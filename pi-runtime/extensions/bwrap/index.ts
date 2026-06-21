/**
 * Pi Agent bwrap 沙盒扩展。
 *
 * 核心机制：
 *   pi 执行 bash 命令时会调用内置的 "bash" 工具。
 *   本扩展通过 pi.registerTool("bash", handler) 覆盖该工具，
 *   将命令路由到 bwrap 沙盒中执行。
 *
 *   重要：只覆盖 "bash" 工具。
 *   pi 的 read/write/edit 工具直接在 Node.js 进程中执行（不经过 bash），
 *   不在此处拦截，由 pi 默认处理。
 *
 * 沙盒特性（由 worker 在启动 pi 进程前注入环境变量）：
 *   PI_SANDBOX_WORKSPACE → bwrap 内挂载为 /workspace（每 session 唯一目录）
 *   PI_SANDBOX_HOME      → bwrap 内挂载为 /root（每 session/user 独立 home）
 *   --unshare-net        → 禁止网络访问
 *   --unshare-pid        → 独立 PID 空间
 */

import { spawn } from "child_process";

// pi 扩展 API 类型声明
interface PiToolHandler {
  (input: Record<string, unknown>): Promise<PiToolResult>;
}

interface PiToolResult {
  output: string;
  isError?: boolean;
}

interface PiContext {
  registerTool(name: string, handler: PiToolHandler): void;
}

declare const pi: PiContext;

// 沙盒路径从 worker 注入的环境变量读取（进程启动时已确定，与 session 绑定）
const sandboxWorkspace = process.env.PI_SANDBOX_WORKSPACE ?? "/workspace";
const sandboxHome = process.env.PI_SANDBOX_HOME ?? "/root";

function buildBwrapArgs(cmd: string): string[] {
  return [
    // 系统目录只读挂载（提供二进制程序、Python 等运行时）
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/sbin", "/sbin",
    "--ro-bind", "/etc/alternatives", "/etc/alternatives",
    // session 专属可读写工作目录（文件修改持久化到宿主目录）
    "--bind", sandboxWorkspace, "/workspace",
    // session/user 专属 home 目录（bashrc、Python venv、pip 包等持久化）
    "--bind", sandboxHome, "/root",
    "--tmpfs", "/tmp",
    "--proc", "/proc",
    "--dev", "/dev",
    // 禁止网络：命令无法发出任何网络请求
    "--unshare-net",
    // 独立 PID 空间：命令看不到其他 session 的进程
    "--unshare-pid",
    // 父进程（pi）退出时自动终止沙盒子进程
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

// 覆盖 pi 的内置 bash 工具，将所有 bash 调用路由到 bwrap 沙盒
pi.registerTool("bash", async (input): Promise<PiToolResult> => {
  const cmd = input["command"] as string | undefined;
  if (!cmd) {
    return { output: "错误：bash 工具调用缺少 command 参数", isError: true };
  }

  console.error(`[bwrap] 沙盒执行: ${cmd.slice(0, 120)}`);
  const result = await runInBwrap(cmd);

  if (result.exitCode !== 0) {
    const combined = [
      result.stdout,
      result.stderr ? `stderr: ${result.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { output: combined || `命令退出码: ${result.exitCode}`, isError: true };
  }

  return { output: result.stdout };
});

console.error(
  `[bwrap] 沙盒扩展已就绪 workspace=${sandboxWorkspace} home=${sandboxHome}`
);
