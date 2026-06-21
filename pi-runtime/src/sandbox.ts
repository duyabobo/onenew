/**
 * bwrap 沙盒管理模块。
 *
 * 设计思路：
 *   - 每个 user 拥有一个持久化工作空间（userWorkspace），跨 session 复用。
 *     文件、Python venv、安装的包等都保留在这里。
 *   - 每个 session 在 userWorkspace 下创建一个 session 临时目录（sessionTmp），
 *     用于 /tmp 级别的临时文件，session 结束时销毁。
 *   - bwrap 把 userWorkspace 挂载为 /workspace（可读写），
 *     userHome 挂载为 /root（包含 .bashrc、pip 包路径等）。
 *
 * 目录结构：
 *   /data/workspaces/{user_id}/
 *     workspace/          ← bwrap 内 /workspace（持久化）
 *     home/               ← bwrap 内 /root（bashrc、pip 包、venv 等持久化）
 *     sessions/{sid}/tmp/ ← bwrap 内 /tmp（session 临时文件，结束后销毁）
 */
import { spawn } from "child_process";
import { mkdir, rm, writeFile, access } from "fs/promises";
import { join } from "path";
import { config } from "./config";

export interface SandboxPaths {
  /** 宿主机上 user 的持久化工作目录 → bwrap 内 /workspace */
  workspace: string;
  /** 宿主机上 user 的持久化 home → bwrap 内 /root */
  home: string;
  /** 宿主机上 session 级别的临时目录 → bwrap 内 /tmp */
  sessionTmp: string;
}

function buildUserPaths(userId: string) {
  const userRoot = join(config.sandbox.root, "users", userId);
  return {
    userRoot,
    workspace: join(userRoot, "workspace"),
    home: join(userRoot, "home"),
  };
}

function buildSessionTmpPath(userId: string, sessionId: string): string {
  return join(config.sandbox.root, "users", userId, "sessions", sessionId, "tmp");
}

/**
 * 初始化 user 的持久化工作空间（幂等）。
 * 首次创建时写入 .bashrc 和基础的 Python venv 初始化脚本。
 */
async function ensureUserWorkspace(userId: string): Promise<{ workspace: string; home: string }> {
  const paths = buildUserPaths(userId);

  await mkdir(paths.workspace, { recursive: true });
  await mkdir(paths.home, { recursive: true });

  const bashrc = join(paths.home, ".bashrc");
  const needsInit = await access(bashrc).then(() => false).catch(() => true);

  if (needsInit) {
    // 首次初始化：写入基础环境配置
    await writeFile(
      bashrc,
      [
        "# Pi Agent Sandbox - User Environment",
        "export HOME=/root",
        "export PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin",
        // Python pip 安装包的用户目录
        "export PYTHONUSERBASE=/root/.local",
        "export PIP_USER=1",
        "",
      ].join("\n")
    );
    console.log(`[sandbox] user=${userId}: 首次初始化工作空间`);
  }

  return { workspace: paths.workspace, home: paths.home };
}

/**
 * 创建 session 级别的临时目录，返回完整的沙盒路径。
 * user 的 workspace/home 是持久化的，只有 sessionTmp 是临时的。
 */
export async function createSandbox(userId: string, sessionId: string): Promise<SandboxPaths> {
  const { workspace, home } = await ensureUserWorkspace(userId);
  const sessionTmp = buildSessionTmpPath(userId, sessionId);
  await mkdir(sessionTmp, { recursive: true });

  console.log(
    `[sandbox] session=${sessionId} user=${userId}: 沙盒就绪 workspace=${workspace}`
  );
  return { workspace, home, sessionTmp };
}

/**
 * 销毁 session 的临时目录。
 * user 的 workspace 和 home 不删除（持久化）。
 */
export async function destroySandbox(userId: string, sessionId: string): Promise<void> {
  const sessionTmp = buildSessionTmpPath(userId, sessionId);
  await rm(sessionTmp, { recursive: true, force: true });
  console.log(`[sandbox] session=${sessionId}: 临时目录已清理，workspace 已保留`);
}

/**
 * 在 bwrap 沙盒内执行命令。
 *
 * 隔离机制：
 *   - /workspace 和 /root 挂载 user 专属目录（不同 user/session 物理路径不同）
 *   - --unshare-net: 禁止网络访问
 *   - --unshare-pid: 独立 PID 空间，看不到其他 session 的进程
 *   - --die-with-parent: pi 进程退出时自动终止沙盒子进程
 */
export function execInSandbox(
  cmd: string,
  paths: SandboxPaths
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const bwrapArgs = buildBwrapArgs(paths);
  bwrapArgs.push("bash", "-c", cmd);

  return new Promise((resolve) => {
    const proc = spawn("bwrap", bwrapArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });

    proc.on("error", (err) => {
      resolve({ stdout: "", stderr: err.message, exitCode: 1 });
    });
  });
}

function buildBwrapArgs(paths: SandboxPaths): string[] {
  return [
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/sbin", "/sbin",
    "--ro-bind", "/etc/alternatives", "/etc/alternatives",
    // user 持久化工作目录（跨 session 保留文件、脚本等）
    "--bind", paths.workspace, "/workspace",
    // user 持久化 home（pip 包、venv、.bashrc 等跨 session 保留）
    "--bind", paths.home, "/root",
    // session 级别临时目录（session 结束后销毁）
    "--bind", paths.sessionTmp, "/tmp",
    "--proc", "/proc",
    "--dev", "/dev",
    "--unshare-net",
    "--unshare-pid",
    "--die-with-parent",
    "--chdir", "/workspace",
    "--",
  ];
}
