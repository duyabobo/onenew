import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { SandboxPaths } from "./sandbox";
import { SessionOutputStream } from "./output-stream";
import { getMcpConfig, getSkillsByNames } from "./mongo-client";

// Pi RPC 消息类型（根据 pi docs/rpc.md）
interface PiRpcMessage {
  type: string;
  [key: string]: unknown;
}

interface PiTextEvent {
  type: "text";
  text: string;
}

interface PiToolCallEvent {
  type: "tool_call";
  name: string;
  input: Record<string, unknown>;
}

interface PiToolResultEvent {
  type: "tool_result";
  name: string;
  output: string;
}

interface PiDoneEvent {
  type: "done" | "error";
  error?: string;
}

type PiEvent = PiTextEvent | PiToolCallEvent | PiToolResultEvent | PiDoneEvent;

/**
 * 通过 RPC 模式启动 pi agent，将输出流式推送到 Redis Stream。
 * pi 进程通过 stdin/stdout 使用 JSONL 协议通信。
 */
/**
 * 为每个 session 创建独立的 pi config 目录，写入从 MongoDB 读取的 MCP 配置。
 * 通过 PI_CODING_AGENT_DIR 环境变量让 pi 使用该目录，避免多 session 共用 ~/.pi/agent。
 */
async function setupPiConfigDir(sessionId: string): Promise<string> {
  const piConfigDir = `/tmp/pi-config/${sessionId}`;
  await mkdir(piConfigDir, { recursive: true });

  const mcpConfig = await getMcpConfig();
  // 将 MongoDB 中的 MCP 配置转换为 pi-mcp-adapter 期望的 mcpServers 格式
  const piMcpJson = { mcpServers: mcpConfig.servers };
  await writeFile(join(piConfigDir, "mcp.json"), JSON.stringify(piMcpJson, null, 2));

  console.log(`[pi-session] session=${sessionId}: pi config 目录就绪 ${piConfigDir}`);
  return piConfigDir;
}

async function cleanupPiConfigDir(sessionId: string): Promise<void> {
  await rm(`/tmp/pi-config/${sessionId}`, { recursive: true, force: true });
}

/**
 * 将用户选定的 skill content 拼接为 system prompt。
 * 跳过渐进式披露——用户已明确选择，直接注入全量内容。
 */
async function buildSystemPrompt(skillIds: string[]): Promise<string> {
  if (skillIds.length === 0) return "";
  const skills = await getSkillsByNames(skillIds);
  if (skills.length === 0) return "";

  const parts = skills.map((s) => `# Skill: ${s.name}\n\n${s.content}`);
  const systemPrompt = parts.join("\n\n---\n\n");
  console.log(`[pi-session] 注入 ${skills.length} 个 skill: ${skills.map((s) => s.name).join(", ")}`);
  return systemPrompt;
}

export async function runPiSession(
  sessionId: string,
  request: string,
  sandboxPaths: SandboxPaths,
  outputStream: SessionOutputStream,
  skillIds: string[] = []
): Promise<void> {
  const piConfigDir = await setupPiConfigDir(sessionId);

  return new Promise((resolve, reject) => {
    const piEnv = {
      ...process.env,
      // 注入实际路径到 bwrap 扩展（路径内外一致）
      PI_SANDBOX_WORKSPACE: sandboxPaths.workspace,
      PI_SANDBOX_HOME: sandboxPaths.home,
      PI_SANDBOX_TMP: sandboxPaths.sessionTmp,
      // LLM 指向 admin 服务
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://admin:9000/v1",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "pi-agent-internal",
      // 每个 session 独立的 pi config 目录（含 MCP 配置），避免多 session 互相干扰
      PI_CODING_AGENT_DIR: piConfigDir,
    };

    // 以 RPC 模式启动 pi，关闭 session 持久化（每个 session 独立临时会话）
    // bwrap 沙盒扩展已安装在 /root/.pi/agent/extensions/，pi 自动加载
    const piProcess: ChildProcess = spawn(
      "pi",
      [
        "--mode", "rpc",
        "--no-session",
        "--provider", "openai",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: piEnv,
        cwd: sandboxPaths.workspace,
      }
    );

    // 逐行解析 pi 的 JSONL 输出
    const rl = createInterface({ input: piProcess.stdout! });

    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let msg: PiRpcMessage;
      try {
        msg = JSON.parse(line) as PiRpcMessage;
      } catch {
        // pi 可能输出非 JSON 的调试信息，忽略
        return;
      }

      await handlePiEvent(msg as unknown as PiEvent, sessionId, outputStream);

      if (msg.type === "done" || msg.type === "error") {
        piProcess.stdin!.end();
      }
    });

    piProcess.stderr!.on("data", (chunk: Buffer) => {
      console.error(`[pi-session] session ${sessionId} stderr: ${chunk.toString().trim()}`);
    });

    piProcess.on("close", async (code) => {
      console.log(`[pi-session] session ${sessionId}: pi 进程退出，code=${code}`);
      await cleanupPiConfigDir(sessionId).catch(() => {});
      resolve();
    });

    piProcess.on("error", async (err) => {
      console.error(`[pi-session] session ${sessionId}: pi 进程启动失败:`, err);
      await cleanupPiConfigDir(sessionId).catch(() => {});
      reject(err);
    });

    // 构建 system prompt（用户明确选定的 skill，直接注入，跳过 pi 渐进式披露选择）
    const systemPrompt = await buildSystemPrompt(skillIds);
    const promptPayload: Record<string, string> = { type: "prompt", text: request };
    if (systemPrompt) promptPayload.system = systemPrompt;

    piProcess.stdin!.write(JSON.stringify(promptPayload) + "\n");
  });
}

async function handlePiEvent(
  event: PiEvent,
  sessionId: string,
  outputStream: SessionOutputStream
): Promise<void> {
  switch (event.type) {
    case "text":
      await outputStream.push({
        event_type: "token",
        content: event.text,
      });
      break;

    case "tool_call":
      await outputStream.push({
        event_type: "tool_call",
        content: JSON.stringify({ name: event.name, input: event.input }),
      });
      break;

    case "tool_result":
      await outputStream.push({
        event_type: "tool_result",
        content: JSON.stringify({ name: event.name, output: event.output }),
      });
      break;

    case "done":
      await outputStream.pushDone();
      break;

    case "error":
      await outputStream.pushError(event.error ?? "未知错误");
      break;
  }
}
