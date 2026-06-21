import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { SandboxPaths } from "./sandbox";
import { SessionOutputStream } from "./output-stream";

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
export async function runPiSession(
  sessionId: string,
  request: string,
  sandboxPaths: SandboxPaths,
  outputStream: SessionOutputStream
): Promise<void> {
  return new Promise((resolve, reject) => {
    const piEnv = {
      ...process.env,
      // 使 pi agent 将 bash 命令路由到 bwrap 沙盒
      PI_SANDBOX_ROOT: sandboxPaths.root,
      PI_SANDBOX_WORKSPACE: sandboxPaths.workspace,
      PI_SANDBOX_HOME: sandboxPaths.home,
      // LLM 指向 admin 服务
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://admin:9000/v1",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "pi-agent-internal",
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
      resolve();
    });

    piProcess.on("error", (err) => {
      console.error(`[pi-session] session ${sessionId}: pi 进程启动失败:`, err);
      reject(err);
    });

    // 通过 stdin 发送用户 prompt
    const promptMsg = JSON.stringify({ type: "prompt", text: request }) + "\n";
    piProcess.stdin!.write(promptMsg);
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
