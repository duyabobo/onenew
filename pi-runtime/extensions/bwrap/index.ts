/**
 * Pi Agent bwrap 沙盒扩展。
 *
 * ═══════════════════════════════════════════════════════════════
 * ⚠️  PI 版本兼容性说明（升级 pi 时必读）
 * ═══════════════════════════════════════════════════════════════
 * 本文件依赖以下 pi Extension API，升级 pi 后需验证这些点：
 *
 * 1. pi.registerTool(name, handler)
 *    用于覆盖 pi 内置工具。若 pi 改名此方法，需同步修改。
 *    当前使用版本：pi@0.79.x
 *
 * 2. 工具名称（如 pi 重命名内置工具，需同步修改）：
 *    "bash"  → pi 执行 shell 命令的工具
 *    "read"  → pi 读文件工具
 *    "write" → pi 写文件工具
 *    "edit"  → pi 编辑文件工具
 *
 * 3. handler 返回 undefined 触发 fallthrough（交由 pi 默认实现处理）
 *    用于 read/write/edit 路径校验通过后的透传。
 *    若 pi 改变此语义，需改为自行实现文件读写。
 *
 * 升级 pi 时的验证步骤：
 *   1. docker build（会在构建时暴露 npm 安装错误）
 *   2. 启动容器，跑一个简单任务，确认 bash 命令走了 bwrap
 *   3. 确认 read/write 工具的路径校验正常
 *   4. 确认越界路径被拦截
 * ═══════════════════════════════════════════════════════════════
 *
 * 沙盒特性（由 worker 在启动 pi 进程前注入环境变量）：
 *   PI_SANDBOX_WORKSPACE → session 专属工作目录（bwrap 内外路径一致）
 *   PI_SANDBOX_HOME      → session 专属 home（bwrap 内外路径一致）
 *   PI_SANDBOX_TMP       → session 临时目录
 *   --unshare-net        → 禁止网络访问
 *   --unshare-pid        → 独立 PID 空间
 */

import { spawn } from "child_process";

// ── pi Extension API 类型声明 ──────────────────────────────────────────────────
// 如果 pi 升级后 API 变化，只需修改这里的类型声明和下方的 pi.registerTool 调用。
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

/**
 * 路径从 worker 注入的环境变量读取（进程启动时已绑定，与 session 一一对应）。
 * 关键：这里是实际文件系统路径（非 /workspace 别名），
 * 确保 pi 的 read/write/edit 工具（Node.js）和 bash 工具（bwrap）访问同一路径。
 */
const sandboxWorkspace = process.env.PI_SANDBOX_WORKSPACE ?? "";
const sandboxHome = process.env.PI_SANDBOX_HOME ?? "";
const sandboxTmp = process.env.PI_SANDBOX_TMP ?? "";

if (!sandboxWorkspace || !sandboxHome) {
  console.error("[bwrap] 警告: PI_SANDBOX_WORKSPACE 或 PI_SANDBOX_HOME 未设置，沙盒可能不生效");
}

function buildBwrapArgs(cmd: string): string[] {
  return [
    // 根文件系统只读（提供系统工具、Python 等运行时）
    "--ro-bind", "/", "/",
    // 覆盖：workspace 和 home 可读写，路径内外一致（不使用别名）
    "--bind", sandboxWorkspace, sandboxWorkspace,
    "--bind", sandboxHome, sandboxHome,
    ...(sandboxTmp ? ["--bind", sandboxTmp, sandboxTmp] : ["--tmpfs", "/tmp"]),
    "--proc", "/proc",
    "--dev", "/dev",
    // 禁止网络：命令无法发出任何网络请求
    "--unshare-net",
    // 独立 PID 空间：命令看不到其他 session 的进程
    "--unshare-pid",
    // 父进程（pi）退出时自动终止沙盒子进程
    "--die-with-parent",
    "--chdir", sandboxWorkspace,
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

// ── bash 工具：路由到 bwrap 沙盒 ─────────────────────────────────────────────
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

// ── read/write/edit 工具：JS 层路径校验 ──────────────────────────────────────
// 这三个工具在 Node.js 进程里直接执行（不经过 bwrap），
// 用路径白名单防止 LLM 生成绝对路径（如 /etc/passwd）逃逸到 workspace 之外。

function resolveAndGuard(rawPath: string): { safe: true; resolved: string } | { safe: false; reason: string } {
  const { path: nodePath } = require("path") as typeof import("path");
  const resolved = nodePath.resolve(sandboxWorkspace, rawPath);
  const allowed = [sandboxWorkspace, sandboxHome].filter(Boolean);
  const inBounds = allowed.some((base) => resolved.startsWith(base + "/") || resolved === base);
  if (!inBounds) {
    return { safe: false, reason: `路径越界: ${rawPath} → ${resolved}（只允许访问 workspace 和 home）` };
  }
  return { safe: true, resolved };
}

for (const toolName of ["read", "write", "edit"] as const) {
  pi.registerTool(toolName, async (input): Promise<PiToolResult> => {
    const rawPath = (input["path"] ?? input["file_path"] ?? "") as string;
    const check = resolveAndGuard(rawPath);
    if (!check.safe) {
      console.error(`[bwrap] 拦截越界文件操作 tool=${toolName} path=${rawPath}`);
      return { output: check.reason, isError: true };
    }
    // 路径合法，交由 pi 默认实现处理（返回 undefined 触发 fallthrough）
    return undefined as unknown as PiToolResult;
  });
}

console.error(
  `[bwrap] 沙盒扩展已就绪 workspace=${sandboxWorkspace} home=${sandboxHome} tmp=${sandboxTmp}`
);
