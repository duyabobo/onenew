import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { mkdir, writeFile, rm, access as fsAccess } from "fs/promises";
import { join } from "path";
import { SandboxPaths } from "./sandbox";
import { SessionOutputStream } from "./output-stream";
import { getMcpConfig, McpServerConfig } from "./mongo-client";

// ── Pi RPC 协议类型 ───────────────────────────────────────────────────────────

interface PiPromptCommand {
  type: "prompt";
  message: string;
}

interface PiCommandResponse {
  type: "response";
  command: string;
  success: boolean;
  error?: string;
}

interface PiMessageUpdateEvent {
  type: "message_update";
  assistantMessageEvent: {
    type: string;
    delta?: string;
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

// ── 多轮会话句柄 ─────────────────────────────────────────────────────────────

/**
 * pi 进程句柄，代表一个存活的 pi 进程（对应一个 chat 窗口 / session）。
 * 支持多轮对话：每次用户发送消息调用 sendTurn，pi 进程持续运行，workspace 文件保留。
 */
export interface PiSessionHandle {
  /** 向 pi 发送一条新消息，流式输出到 outputStream，完成后 resolve */
  sendTurn(turnId: string, message: string, outputStream: SessionOutputStream): Promise<void>;
  /** 关闭 pi 进程，清理 pi config 目录（sandbox workspace 由 worker 负责清理） */
  close(): Promise<void>;
}

// ── 内部：当前轮次状态 ────────────────────────────────────────────────────────

interface ActiveTurn {
  turnId: string;
  outputStream: SessionOutputStream;
  resolve: () => void;
  reject: (err: Error) => void;
  bwrapChecked: boolean;  // 首轮校验 bwrap.ready，后续轮次跳过
}

// ── MCP 配置过滤 ──────────────────────────────────────────────────────────────

function filterUrlOnlyMcpServers(
  servers: Record<string, McpServerConfig>
): Record<string, McpServerConfig> {
  const safe: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    const raw = cfg as unknown as Record<string, unknown>;
    if (cfg.url && !raw["command"]) {
      safe[name] = cfg;
    } else {
      console.warn(`[pi-session] MCP Server "${name}" 已跳过：缺少 url 或含有 command 字段`);
    }
  }
  return safe;
}

// ── pi config 目录管理 ────────────────────────────────────────────────────────

/**
 * 为 session 创建独立的 pi config 目录，写入 MCP 配置、models.json，软链接扩展和 skills。
 * PI_CODING_AGENT_DIR 指向此目录，确保多 session 间配置完全隔离。
 */
async function setupPiConfigDir(
  sessionId: string,
  globalSkillsRoot: string,
  userSkillsRoot: string
): Promise<string> {
  const piConfigDir = `/tmp/pi-config/${sessionId}`;
  await mkdir(piConfigDir, { recursive: true });

  // MCP 配置（从 MongoDB 读取，只保留 url 类型，command 类型双重过滤）
  const mcpConfig = await getMcpConfig();
  const safeServers = filterUrlOnlyMcpServers(mcpConfig.servers);
  await writeFile(join(piConfigDir, "mcp.json"), JSON.stringify({ mcpServers: safeServers }, null, 2));

  // LLM provider 配置（指向 llm-proxy，model id 是占位符）
  const piModelsJson = {
    providers: {
      "llm-proxy": {
        baseUrl: process.env.OPENAI_BASE_URL ?? "http://llm-proxy:9001/v1",
        api: "openai-completions",
        apiKey: process.env.OPENAI_API_KEY ?? "pi-agent-internal",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{
          id: "default",
          name: "LLM Proxy (via llm-proxy)",
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  };
  await writeFile(join(piConfigDir, "models.json"), JSON.stringify(piModelsJson, null, 2));

  // Skills 软链接
  const piSkillsDir = join(piConfigDir, "skills");
  await mkdir(piSkillsDir, { recursive: true });

  const { symlink, readdir } = await import("fs/promises");

  // 扩展软链接（PI_CODING_AGENT_DIR 覆盖默认路径，必须显式链接）
  // bwrap 扩展是安全关键，链接失败直接抛错（fail-closed）
  const defaultExtensionsDir = "/root/.pi/agent/extensions";
  const piExtensionsDir = join(piConfigDir, "extensions");
  await mkdir(piExtensionsDir, { recursive: true });
  const extensionEntries = await readdir(defaultExtensionsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of extensionEntries) {
    if (!entry.isDirectory()) continue;
    await symlink(join(defaultExtensionsDir, entry.name), join(piExtensionsDir, entry.name)).catch((err: Error) => {
      console.error(`[pi-session] session=${sessionId}: 扩展 "${entry.name}" 链接失败:`, err.message);
    });
  }

  const bwrapExtensionPath = join(piExtensionsDir, "bwrap");
  await fsAccess(bwrapExtensionPath).catch(() => {
    throw new Error(
      `[pi-session] bwrap 扩展未就绪: ${bwrapExtensionPath} 不存在，` +
      `bash 工具将无沙盒防护，session 终止（fail-closed）。`
    );
  });
  console.log(`[pi-session] session=${sessionId}: 已链接 ${extensionEntries.length} 个扩展，bwrap 已就绪`);

  for (const [srcRoot, prefix] of [[globalSkillsRoot, "g"], [userSkillsRoot, "u"]] as const) {
    const entries = await readdir(srcRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
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

function buildSkillArgs(skillIds: string[], globalSkillsRoot: string, userSkillsRoot: string): string[] {
  if (skillIds.length === 0) return [];
  const args: string[] = ["--no-skills"];
  for (const id of skillIds) {
    args.push("--skill", join(globalSkillsRoot, id));
    args.push("--skill", join(userSkillsRoot, id));
  }
  return args;
}

// ── 启动 pi 进程，返回多轮会话句柄 ───────────────────────────────────────────

/**
 * 启动 pi 进程，等待扩展加载完成，返回 PiSessionHandle。
 *
 * 设计要点：
 *   - pi 进程持续运行，不随单次轮次结束而退出
 *   - workspace 文件在轮次间保留，支持"修改上一轮写的文件"
 *   - pi 自身维护对话历史，无需外部传 context 字段
 */
export async function startPiSession(
  sessionId: string,
  sandboxPaths: SandboxPaths,
  skillIds: string[] = []
): Promise<PiSessionHandle> {
  const piConfigDir = await setupPiConfigDir(sessionId, sandboxPaths.globalSkills, sandboxPaths.userSkills);

  // pi 子进程只注入必要环境变量，不暴露 MongoDB/Redis 凭据
  const piEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/root",
    TERM: process.env.TERM ?? "xterm",
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://llm-proxy:9001/v1",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "pi-agent-internal",
    PI_SANDBOX_ROOT: process.env.SANDBOX_ROOT ?? "/data/sandboxes",
    PI_SANDBOX_WORKSPACE: sandboxPaths.workspace,
    PI_SANDBOX_HOME: sandboxPaths.home,
    PI_SANDBOX_TMP: sandboxPaths.sessionTmp,
    PI_CODING_AGENT_DIR: piConfigDir,
  };

  const skillArgs = buildSkillArgs(skillIds, sandboxPaths.globalSkills, sandboxPaths.userSkills);
  const piArgs = ["--mode", "rpc", "--no-session", "--provider", "llm-proxy", "--model", "default", ...skillArgs];

  const piProcess: ChildProcess = spawn("pi", piArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: piEnv,
    cwd: sandboxPaths.workspace,
  });

  console.log(`[pi-session] session=${sessionId}: pi 进程已启动 pid=${piProcess.pid}`);

  // bwrap 就绪标记文件（由 bwrap 扩展在所有 registerTool 完成后写入）
  const bwrapReadyFile = join(piConfigDir, "bwrap.ready");

  // 当前活跃轮次（同一时刻最多一轮）
  let activeTurn: ActiveTurn | null = null;

  // pi 进程退出时的 Promise，供 close() 等待
  let piExitResolve: () => void;
  const piExitPromise = new Promise<void>((res) => { piExitResolve = res; });

  // ── 解析 pi stdout（全局监听，轮次间持续有效）──────────────────────────────
  const rl = createInterface({ input: piProcess.stdout! });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: PiEvent;
    try {
      msg = JSON.parse(line) as PiEvent;
    } catch {
      console.warn(`[pi-session] session=${sessionId}: 忽略非 JSON 输出: ${line.slice(0, 100)}`);
      return;
    }

    if (!activeTurn) return; // 没有活跃轮次，忽略（理论上不会发生）

    const { turnId, outputStream, resolve, reject } = activeTurn;

    // bwrap 就绪检查（仅第一轮首次 response.success 时执行）
    const responseEvent = msg as PiCommandResponse;
    if (msg.type === "response" && responseEvent.success && !activeTurn.bwrapChecked) {
      const ready = await fsAccess(bwrapReadyFile).then(() => true).catch(() => false);
      if (!ready) {
        const errMsg = `bwrap 沙盒扩展未就绪（标记文件 ${bwrapReadyFile} 不存在），session 终止（fail-closed）`;
        console.error(`[pi-session] session=${sessionId} turn=${turnId}: ${errMsg}`);
        await outputStream.pushError(errMsg);
        await outputStream.pushDone();
        activeTurn = null;
        piProcess.stdin!.end();
        reject(new Error(errMsg));
        return;
      }
      activeTurn.bwrapChecked = true;
      console.log(`[pi-session] session=${sessionId}: bwrap 扩展已确认就绪`);
    }

    const done = await dispatchPiEvent(msg, sessionId, turnId, outputStream);
    if (done) {
      console.log(`[pi-session] session=${sessionId} turn=${turnId}: 轮次结束`);
      activeTurn = null;
      resolve();
      // 注意：不关闭 stdin，pi 继续等待下一条 prompt
    }
  });

  piProcess.stderr!.on("data", (chunk: Buffer) => {
    const trimmed = chunk.toString().trim();
    if (trimmed) console.error(`[pi-session] session=${sessionId} pi stderr: ${trimmed}`);
  });

  piProcess.on("close", async (code) => {
    console.log(`[pi-session] session=${sessionId}: pi 进程退出 code=${code}`);
    // 若有活跃轮次未完成，通知失败
    if (activeTurn) {
      await activeTurn.outputStream.pushError("pi 进程意外退出").catch(() => {});
      await activeTurn.outputStream.pushDone().catch(() => {});
      activeTurn.reject(new Error(`pi 进程意外退出，code=${code}`));
      activeTurn = null;
    }
    await cleanupPiConfigDir(sessionId).catch(() => {});
    piExitResolve();
  });

  piProcess.on("error", async (err) => {
    console.error(`[pi-session] session=${sessionId}: pi 进程启动失败:`, err.message);
    if (activeTurn) {
      activeTurn.reject(err);
      activeTurn = null;
    }
    await cleanupPiConfigDir(sessionId).catch(() => {});
    piExitResolve();
  });

  // ── 返回句柄 ─────────────────────────────────────────────────────────────

  return {
    async sendTurn(turnId: string, message: string, outputStream: SessionOutputStream): Promise<void> {
      if (activeTurn) {
        throw new Error(`session=${sessionId}: 上一轮 turn=${activeTurn.turnId} 尚未结束，不能发送新消息`);
      }

      return new Promise<void>((resolve, reject) => {
        activeTurn = {
          turnId,
          outputStream,
          resolve,
          reject,
          bwrapChecked: false,
        };

        const promptPayload: PiPromptCommand = { type: "prompt", message };
        piProcess.stdin!.write(JSON.stringify(promptPayload) + "\n");
        console.log(`[pi-session] session=${sessionId} turn=${turnId}: prompt 已写入 stdin（${message.length}字符）`);
      });
    },

    async close(): Promise<void> {
      console.log(`[pi-session] session=${sessionId}: 关闭 pi 进程`);
      piProcess.stdin!.end();
      await piExitPromise;
    },
  };
}

// ── 事件分发（轮次级别）─────────────────────────────────────────────────────

/**
 * 处理单条 pi 事件，返回 true 表示本轮结束（agent_end 或错误）。
 */
async function dispatchPiEvent(
  event: PiEvent,
  sessionId: string,
  turnId: string,
  outputStream: SessionOutputStream
): Promise<boolean> {
  switch (event.type) {
    case "response": {
      const resp = event as PiCommandResponse;
      if (!resp.success) {
        console.error(`[pi-session] session=${sessionId} turn=${turnId}: prompt 命令失败 error=${resp.error}`);
        await outputStream.pushError(resp.error ?? "pi prompt 命令失败");
        await outputStream.pushDone();
        return true;
      }
      return false;
    }

    case "message_update": {
      const e = event as PiMessageUpdateEvent;
      const { type: evType, delta } = e.assistantMessageEvent;
      if (!delta) return false;
      if (evType === "text_delta") {
        await outputStream.push({ event_type: "token", content: delta });
      } else if (evType === "thinking_delta") {
        await outputStream.push({ event_type: "thinking", content: delta });
      }
      return false;
    }

    case "tool_execution_start": {
      const e = event as PiToolExecutionStartEvent;
      await outputStream.push({
        event_type: "tool_call",
        content: JSON.stringify({ name: e.toolName, input: e.args }),
      });
      return false;
    }

    case "tool_execution_end": {
      const e = event as PiToolExecutionEndEvent;
      const output = typeof e.result === "string" ? e.result : JSON.stringify(e.result);
      await outputStream.push({
        event_type: "tool_result",
        content: JSON.stringify({ name: e.toolName, output, isError: e.isError }),
      });
      return false;
    }

    case "agent_end": {
      await outputStream.pushDone();
      return true;
    }

    default: {
      const unknown = event as { type: string; [key: string]: unknown };
      const keys = Object.keys(unknown).filter(k => k !== "type").join(",");
      console.log(`[pi-session] session=${sessionId} turn=${turnId}: 忽略事件 type=${unknown.type} fields=[${keys}]`);
      return false;
    }
  }
}
