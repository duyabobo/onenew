/**
 * Pi Agent bwrap 沙盒扩展。
 *
 * 原理：通过 Pi 扩展 API 拦截 bash 工具调用，
 * 将命令包装到 bwrap 沙盒中执行，实现：
 *   - 独立文件系统（每个 session 独立工作目录）
 *   - 禁止网络访问（--unshare-net）
 *   - 独立 PID 空间（--unshare-pid）
 *
 * 沙盒根目录通过环境变量 PI_SANDBOX_ROOT / PI_SANDBOX_WORKSPACE 注入。
 */

import { spawn } from "child_process";

// pi 扩展接口（根据 pi extension API）
interface PiExtensionContext {
  on(event: "tool_call", handler: (call: ToolCall) => Promise<ToolResult>): void;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface ToolResult {
  output: string;
  isError?: boolean;
}

declare const pi: PiExtensionContext;

const sandboxWorkspace = process.env.PI_SANDBOX_WORKSPACE ?? "/workspace";
const sandboxHome = process.env.PI_SANDBOX_HOME ?? "/root";
const sandboxRoot = process.env.PI_SANDBOX_ROOT ?? "/tmp/pi-sandbox/default";

function buildBwrapArgs(cmd: string): string[] {
  return [
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/sbin", "/sbin",
    // 挂载 session 独立的可读写工作目录
    "--bind", sandboxWorkspace, "/workspace",
    "--bind", sandboxHome, "/root",
    "--tmpfs", "/tmp",
    "--proc", "/proc",
    "--dev", "/dev",
    // 禁止网络
    "--unshare-net",
    // 独立 PID 空间防止进程逃逸
    "--unshare-pid",
    // 父进程退出时自动杀死子进程
    "--die-with-parent",
    "--chdir", "/workspace",
    "--",
    "bash",
    "-c",
    cmd,
  ];
}

function runInBwrap(
  cmd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const args = buildBwrapArgs(cmd);
    const proc = spawn("bwrap", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      resolve({ stdout: "", stderr: `bwrap 启动失败: ${err.message}`, exitCode: 1 });
    });
  });
}

// 拦截 pi 的 bash 工具调用，路由到 bwrap 沙盒
pi.on("tool_call", async (call: ToolCall): Promise<ToolResult> => {
  if (call.name !== "bash") {
    // 非 bash 工具不拦截，交由 pi 默认处理
    return { output: "", isError: false };
  }

  const cmd = call.input["command"] as string | undefined;
  if (!cmd) {
    return { output: "错误：bash 工具调用缺少 command 参数", isError: true };
  }

  console.error(`[bwrap-ext] 沙盒执行命令: ${cmd.slice(0, 120)}`);
  const result = await runInBwrap(cmd);

  if (result.exitCode !== 0) {
    const errorOutput = [
      result.stdout,
      result.stderr ? `stderr: ${result.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { output: errorOutput || `命令退出码: ${result.exitCode}`, isError: true };
  }

  return { output: result.stdout };
});

console.error(
  `[bwrap-ext] 沙盒扩展已加载: workspace=${sandboxWorkspace} home=${sandboxHome}`
);
