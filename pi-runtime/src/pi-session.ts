import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { SandboxPaths } from "./sandbox";
import { SessionOutputStream } from "./output-stream";
import { getMcpConfig } from "./mongo-client";

// Pi RPC 协议类型（基于 pi@0.79.x rpc-types.d.ts / agent-core/types.d.ts）
// 命令方向：host → pi (stdin)
interface PiPromptCommand {
  type: "prompt";
  message: string; // 注意：是 message，不是 text
}

// 响应方向：pi → host (stdout)
// ── 命令确认 ──────────────────────────────────────────────────────────────
interface PiCommandResponse {
  type: "response";
  command: string;
  success: boolean;
  error?: string;
}

// ── AgentSessionEvent（session.subscribe 直接 output）────────────────────
interface PiMessageUpdateEvent {
  type: "message_update";
  assistantMessageEvent: {
    type: string;
    delta?: string;       // text_delta / thinking_delta
    contentIndex?: number;
  };
}

interface PiToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

interface PiToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

interface PiAgentEndEvent {
  type: "agent_end";
}

type PiEvent =
  | PiCommandResponse
  | PiMessageUpdateEvent
  | PiToolExecutionStartEvent
  | PiToolExecutionEndEvent
  | PiAgentEndEvent
  | { type: string; [key: string]: unknown };

/**
 * 通过 RPC 模式启动 pi agent，将输出流式推送到 Redis Stream。
 * pi 进程通过 stdin/stdout 使用 JSONL 协议通信。
 */
/**
 * 为每个 session 创建独立的 pi config 目录，写入从 MongoDB 读取的 MCP 配置。
 * 通过 PI_CODING_AGENT_DIR 环境变量让 pi 使用该目录，避免多 session 共用 ~/.pi/agent。
 */
async function setupPiConfigDir(
  sessionId: string,
  globalSkillsRoot: string,
  userSkillsRoot: string
): Promise<string> {
  const piConfigDir = `/tmp/pi-config/${sessionId}`;
  await mkdir(piConfigDir, { recursive: true });

  // MCP 配置（从 MongoDB 读取）
  const mcpConfig = await getMcpConfig();
  const piMcpJson = { mcpServers: mcpConfig.servers };
  await writeFile(join(piConfigDir, "mcp.json"), JSON.stringify(piMcpJson, null, 2));

  // 注册 llm-proxy 自定义 provider（pi 通过 openai-completions API 调用 llm-proxy）
  // llm-proxy 会忽略 model 字段，始终使用自身配置的 model，所以 model id 只是占位符
  const piModelsJson = {
    providers: {
      "llm-proxy": {
        baseUrl: process.env.OPENAI_BASE_URL ?? "http://llm-proxy:9001/v1",
        api: "openai-completions",
        apiKey: process.env.OPENAI_API_KEY ?? "pi-agent-internal",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
        models: [
          {
            id: "default",
            name: "LLM Proxy (via llm-proxy)",
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  await writeFile(join(piConfigDir, "models.json"), JSON.stringify(piModelsJson, null, 2));

  // Skills 目录：合并 global + user 专属 skill，pi 从此处自动发现（无用户选定时）
  // 通过软链接指向真实目录，避免文件复制
  const piSkillsDir = join(piConfigDir, "skills");
  await mkdir(piSkillsDir, { recursive: true });

  // 将 global skills 和 user skills 软链接到 pi config skills 目录
  const { symlink, readdir } = await import("fs/promises");

  for (const [srcRoot, prefix] of [[globalSkillsRoot, "g"], [userSkillsRoot, "u"]] as const) {
    const entries = await readdir(srcRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // 命名加前缀避免 global 和 user skill 同名冲突
      const linkName = join(piSkillsDir, `${prefix}_${entry.name}`);
      await symlink(join(srcRoot, entry.name), linkName).catch(() => {});
    }
  }

  console.log(`[pi-session] session=${sessionId}: pi config 目录就绪 ${piConfigDir}`);
  return piConfigDir;
}

async function cleanupPiConfigDir(sessionId: string): Promise<void> {
  await rm(`/tmp/pi-config/${sessionId}`, { recursive: true, force: true });
}

/**
 * 构建传给 pi 的 --skill 参数列表。
 *
 * 用户选定 skill 时：
 *   只传选定的 skill 目录路径（global + user）。
 *   pi 使用 --no-skills（关闭全量扫描）+ --skill {path}（只加载指定的）。
 *   pi 对这些 skill 依然执行渐进式披露（tier 1 description → tier 2 正文 → tier 3 资源）。
 *
 * 用户未选 skill 时：
 *   不传 --skill 参数，pi 自动扫描 PI_CODING_AGENT_DIR/skills/（全局 + 用户专属）。
 */
function buildSkillArgs(
  skillIds: string[],
  globalSkillsRoot: string,
  userSkillsRoot: string
): string[] {
  if (skillIds.length === 0) return [];

  const args: string[] = ["--no-skills"];
  for (const id of skillIds) {
    const globalPath = join(globalSkillsRoot, id);
    const userPath = join(userSkillsRoot, id);
    // 优先 global skill，再找用户专属 skill
    args.push("--skill", globalPath);
    args.push("--skill", userPath);
  }
  return args;
}

export async function runPiSession(
  sessionId: string,
  request: string,
  sandboxPaths: SandboxPaths,
  outputStream: SessionOutputStream,
  skillIds: string[] = []
): Promise<void> {
  const piConfigDir = await setupPiConfigDir(
    sessionId,
    sandboxPaths.globalSkills,
    sandboxPaths.userSkills
  );

  return new Promise((resolve, reject) => {
    const piEnv = {
      ...process.env,
      PI_SANDBOX_ROOT: process.env.SANDBOX_ROOT ?? "/data/sandboxes",
      PI_SANDBOX_WORKSPACE: sandboxPaths.workspace,
      PI_SANDBOX_HOME: sandboxPaths.home,
      PI_SANDBOX_TMP: sandboxPaths.sessionTmp,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://llm-proxy:9001/v1",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "pi-agent-internal",
      PI_CODING_AGENT_DIR: piConfigDir,
    };

    // 用户选定 skill 时：--no-skills + --skill {path}（仅加载选定的）
    // 用户未选时：pi 自动扫描 PI_CODING_AGENT_DIR/skills/（全量渐进式披露）
    const skillArgs = buildSkillArgs(
      skillIds,
      sandboxPaths.globalSkills,
      sandboxPaths.userSkills
    );

    const piArgs = ["--mode", "rpc", "--no-session", "--provider", "llm-proxy", "--model", "default", ...skillArgs];
    console.log(`[pi-session] session ${sessionId}: 启动 pi 进程 args=[${piArgs.join(" ")}] cwd=${sandboxPaths.workspace}`);

    const piProcess: ChildProcess = spawn("pi", piArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: piEnv,
      cwd: sandboxPaths.workspace,
    });

    console.log(`[pi-session] session ${sessionId}: pi 进程已启动 pid=${piProcess.pid}`);

    // 逐行解析 pi 的 JSONL 输出
    const rl = createInterface({ input: piProcess.stdout! });
    let lineCount = 0;

    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let msg: PiEvent;
      try {
        msg = JSON.parse(line) as PiEvent;
      } catch {
        console.warn(`[pi-session] session ${sessionId}: 忽略非 JSON 输出: ${line.slice(0, 100)}`);
        return;
      }

      lineCount++;
      if (lineCount === 1) {
        console.log(`[pi-session] session ${sessionId}: 收到 pi 首条消息 type=${msg.type}`);
      }

      const shouldStop = await handlePiEvent(msg, sessionId, outputStream);
      if (shouldStop) {
        console.log(`[pi-session] session ${sessionId}: 收到终止事件，关闭 stdin，共 ${lineCount} 条消息`);
        piProcess.stdin!.end();
      }
    });

    piProcess.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[pi-session] session ${sessionId} pi stderr: ${text}`);
      }
    });

    piProcess.on("close", async (code) => {
      console.log(`[pi-session] session ${sessionId}: pi 进程退出 code=${code} 累计输出 ${lineCount} 条消息`);
      await cleanupPiConfigDir(sessionId).catch(() => {});
      resolve();
    });

    piProcess.on("error", async (err) => {
      console.error(`[pi-session] session ${sessionId}: pi 进程启动失败:`, err.message);
      await cleanupPiConfigDir(sessionId).catch(() => {});
      reject(err);
    });

    // 发送 prompt（pi RPC 协议用 message 字段，不是 text）
    const promptPayload: PiPromptCommand = { type: "prompt", message: request };
    piProcess.stdin!.write(JSON.stringify(promptPayload) + "\n");
    console.log(`[pi-session] session ${sessionId}: prompt 已写入 stdin（${request.length} 字符）`);
  });
}

/**
 * 处理 pi RPC 事件，返回 true 表示应终止（关闭 stdin）。
 *
 * pi@0.79.x 输出两类 JSON：
 * 1. { type: "response", command, success } — 命令确认
 * 2. AgentSessionEvent — session.subscribe 直接 output 的事件流
 */
async function handlePiEvent(
  event: PiEvent,
  sessionId: string,
  outputStream: SessionOutputStream
): Promise<boolean> {
  switch (event.type) {
    // ── 命令确认（response to "prompt"）──────────────────────────────────
    case "response": {
      const resp = event as PiCommandResponse;
      if (!resp.success) {
        console.error(`[pi-session] session ${sessionId}: prompt 命令失败 error=${resp.error}`);
        await outputStream.pushError(resp.error ?? "pi prompt 命令失败");
        await outputStream.pushDone();
        return true;
      }
      console.log(`[pi-session] session ${sessionId}: prompt 命令已接受（preflight 通过）`);
      return false;
    }

    // ── 文本 token 流（每个 text_delta 是一个增量 token）──────────────────
    case "message_update": {
      const e = event as PiMessageUpdateEvent;
      if (e.assistantMessageEvent.type === "text_delta" && e.assistantMessageEvent.delta) {
        await outputStream.push({ event_type: "token", content: e.assistantMessageEvent.delta });
      }
      return false;
    }

    // ── 工具调用开始 ──────────────────────────────────────────────────────
    case "tool_execution_start": {
      const e = event as PiToolExecutionStartEvent;
      await outputStream.push({
        event_type: "tool_call",
        content: JSON.stringify({ name: e.toolName, input: e.args }),
      });
      return false;
    }

    // ── 工具调用结束 ──────────────────────────────────────────────────────
    case "tool_execution_end": {
      const e = event as PiToolExecutionEndEvent;
      const output = typeof e.result === "string" ? e.result : JSON.stringify(e.result);
      await outputStream.push({
        event_type: "tool_result",
        content: JSON.stringify({ name: e.toolName, output, isError: e.isError }),
      });
      return false;
    }

    // ── Agent 执行结束（本次 prompt 处理完毕）─────────────────────────────
    case "agent_end": {
      console.log(`[pi-session] session ${sessionId}: agent_end 收到，推送 done`);
      await outputStream.pushDone();
      return true;
    }

    default: {
      // 临时：记录所有未处理事件，用于排查 pi 输出的完整事件序列
      const unknown = event as { type: string; [key: string]: unknown };
      const keys = Object.keys(unknown).filter(k => k !== "type").join(",");
      console.log(`[pi-session] session ${sessionId}: 忽略事件 type=${unknown.type} fields=[${keys}]`);
      return false;
    }
  }
}
