/**
 * bwrap 沙盒管理模块。
 *
 * 路径一致性设计（关键）：
 *   bwrap 内部路径 == pi Node.js 进程路径 == 宿主机路径
 *   做法：--ro-bind / / 挂载只读根，再用 --bind 把 workspace/home 覆盖为可读写。
 *   这样 pi 的 read/write/edit 工具（Node.js）和 bash 工具（bwrap）看到的是同一路径。
 *
 * 持久化设计：
 *   user 级别：workspace/ 和 home/ 跨 session 保留（文件、pip 包、venv 等）。
 *   session 级别：sessions/{sid}/tmp/ 仅当前 session 使用，结束后销毁。
 *
 * 目录结构（挂载到 Docker named volume 或 NFS）：
 *   {SANDBOX_ROOT}/users/{user_id}/
 *     workspace/          ← bwrap 内可读写，路径与宿主一致（持久化）
 *     home/               ← bwrap 内可读写，路径与宿主一致（持久化）
 *     sessions/{sid}/tmp/ ← bwrap 内 /tmp 的宿主对应（session 结束销毁）
 */
import { spawn } from "child_process";
import { mkdir, rm, writeFile, access } from "fs/promises";
import { join } from "path";
import { config } from "./config";

export interface SandboxPaths {
  /** user 持久化工作目录（bwrap 内外路径相同） */
  workspace: string;
  /** user 持久化 home 目录（bwrap 内外路径相同） */
  home: string;
  /** session 临时目录，对应 bwrap 内 /tmp */
  sessionTmp: string;
}

function buildUserRoot(userId: string): string {
  return join(config.sandbox.root, "users", userId);
}

/**
 * 初始化 user 持久化工作空间（幂等）。
 * 首次创建时写入 .bashrc 基础环境，后续 session 直接复用。
 */
async function ensureUserWorkspace(userId: string): Promise<Pick<SandboxPaths, "workspace" | "home">> {
  const userRoot = buildUserRoot(userId);
  const workspace = join(userRoot, "workspace");
  const home = join(userRoot, "home");

  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });

  const bashrc = join(home, ".bashrc");
  const isFirstTime = await access(bashrc).then(() => false).catch(() => true);
  if (isFirstTime) {
    await writeFile(
      bashrc,
      [
        "export HOME=/root",
        `export REAL_HOME=${home}`,
        "export PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin",
        // pip install --user 装到持久化 home 下
        "export PYTHONUSERBASE=/root/.local",
        "export PIP_USER=1",
        "",
      ].join("\n")
    );
    console.log(`[sandbox] user=${userId}: 首次初始化工作空间 home=${home}`);
  }

  return { workspace, home };
}

/**
 * 创建 session 沙盒。
 * user 的 workspace/home 是持久化的，sessionTmp 是 session 级别的。
 */
export async function createSandbox(userId: string, sessionId: string): Promise<SandboxPaths> {
  const { workspace, home } = await ensureUserWorkspace(userId);
  const sessionTmp = join(buildUserRoot(userId), "sessions", sessionId, "tmp");
  await mkdir(sessionTmp, { recursive: true });

  console.log(`[sandbox] user=${userId} session=${sessionId}: 就绪 workspace=${workspace}`);
  return { workspace, home, sessionTmp };
}

/**
 * 销毁 session 临时目录。user 的 workspace/home 保留（持久化）。
 */
export async function destroySandbox(userId: string, sessionId: string): Promise<void> {
  const sessionTmp = join(buildUserRoot(userId), "sessions", sessionId, "tmp");
  await rm(sessionTmp, { recursive: true, force: true });
  console.log(`[sandbox] session=${sessionId}: 临时目录已清理，workspace 持久保留`);
}

/**
 * 构造 bwrap 参数。
 *
 * 核心设计：使用实际路径挂载（不使用 /workspace 别名）
 *   --ro-bind / /                     → 根文件系统只读
 *   --bind {workspace} {workspace}    → workspace 可读写（路径内外一致）
 *   --bind {home} {home}              → home 可读写（路径内外一致）
 *   --bind {sessionTmp} {sessionTmp}  → tmp 可读写
 *
 * 这确保 pi 的 bash 工具（bwrap 内）和 read/write/edit 工具（Node.js）
 * 操作的是同一路径，不存在路径映射歧义。
 */
function buildBwrapArgs(paths: SandboxPaths): string[] {
  return [
    // 整个根文件系统只读（提供系统工具、Python 运行时等）
    "--ro-bind", "/", "/",
    // 再覆盖：workspace 可读写（user 文件持久化）
    "--bind", paths.workspace, paths.workspace,
    // 再覆盖：home 可读写（pip 包、venv、.bashrc 持久化）
    "--bind", paths.home, paths.home,
    // 再覆盖：session 临时目录可读写
    "--bind", paths.sessionTmp, paths.sessionTmp,
    // 重新挂载 /proc /dev（只读根后需要显式恢复）
    "--proc", "/proc",
    "--dev", "/dev",
    // 禁止网络：沙盒内无法发出任何网络请求
    "--unshare-net",
    // 独立 PID 空间：沙盒内看不到其他 session 的进程
    "--unshare-pid",
    // pi 进程退出时自动终止沙盒子进程
    "--die-with-parent",
    "--chdir", paths.workspace,
    "--",
  ];
}

export function execInSandbox(
  cmd: string,
  paths: SandboxPaths
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = [...buildBwrapArgs(paths), "bash", "-c", cmd];

  return new Promise((resolve) => {
    const proc = spawn("bwrap", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    proc.on("error", (err) => resolve({ stdout: "", stderr: err.message, exitCode: 1 }));
  });
}
