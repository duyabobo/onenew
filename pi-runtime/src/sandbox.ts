/**
 * bwrap 沙盒管理模块。
 *
 * 隔离粒度：session 级别。
 *   每个 session 拥有完全独立的 workspace、home、tmp 目录。
 *   不同 session（哪怕同一 user）的文件系统完全隔离，互不可见。
 *   session 结束时整个目录销毁。
 *
 * 目录结构：
 *   {SANDBOX_ROOT}/users/{user_id}/sessions/{session_id}/
 *     workspace/   ← bwrap 内外路径一致，可读写（session 结束后销毁）
 *     home/        ← 独立 home，含 .bashrc / pip 包路径等（session 结束后销毁）
 *     tmp/         ← 临时文件（session 结束后销毁）
 *
 * 路径一致性：
 *   bwrap 使用 --ro-bind / / + --bind {实际路径} {实际路径}，
 *   内外路径完全相同，pi 的 read/write/edit 工具（Node.js）和 bash 工具（bwrap）
 *   操作的是同一个物理目录，不存在路径映射歧义。
 */
import { spawn } from "child_process";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { config } from "./config";

export interface SandboxPaths {
  workspace: string;
  home: string;
  sessionTmp: string;
  /** 用户专属 skill 目录（持久化，跨 session，用户级别隔离） */
  userSkills: string;
  /** 全局 skill 目录（admin 管理，所有用户只读可用） */
  globalSkills: string;
}

function buildSessionRoot(userId: string, sessionId: string): string {
  return join(config.sandbox.root, "users", userId, "sessions", sessionId);
}

/**
 * 创建 session 独立沙盒目录，写入基础 .bashrc。
 * 每次调用都创建全新目录（session 级隔离，不复用）。
 */
export async function createSandbox(userId: string, sessionId: string): Promise<SandboxPaths> {
  const sessionRoot = buildSessionRoot(userId, sessionId);
  const workspace = join(sessionRoot, "workspace");
  const home = join(sessionRoot, "home");
  const sessionTmp = join(sessionRoot, "tmp");

  // user 专属 skill 目录（持久化，user 级别隔离，不随 session 销毁）
  const userSkills = join(config.sandbox.root, "users", userId, "skills");
  // 全局 skill 目录（admin 写入，所有用户只读可用）
  const globalSkills = join(config.sandbox.root, "global", "skills");

  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(sessionTmp, { recursive: true });
  await mkdir(userSkills, { recursive: true });
  await mkdir(globalSkills, { recursive: true });

  // 初始化 home 环境（每个 session 独立）
  await writeFile(
    join(home, ".bashrc"),
    [
      "export HOME=/root",
      "export PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin",
      "export PYTHONUSERBASE=/root/.local",
      "export PIP_USER=1",
      "",
    ].join("\n")
  );

  console.log(`[sandbox] session=${sessionId} user=${userId}: 沙盒创建完成 root=${sessionRoot}`);
  return { workspace, home, sessionTmp, userSkills, globalSkills };
}

/**
 * 销毁 session 的整个沙盒目录（workspace + home + tmp 全部删除）。
 */
export async function destroySandbox(userId: string, sessionId: string): Promise<void> {
  const sessionRoot = buildSessionRoot(userId, sessionId);
  await rm(sessionRoot, { recursive: true, force: true });
  console.log(`[sandbox] session=${sessionId}: 沙盒已销毁`);
}

function buildBwrapArgs(paths: SandboxPaths): string[] {
  return [
    // 根文件系统只读（提供系统工具、Python 运行时等）
    "--ro-bind", "/", "/",
    // 覆盖：session 专属目录可读写，路径内外一致
    "--bind", paths.workspace, paths.workspace,
    "--bind", paths.home, paths.home,
    "--bind", paths.sessionTmp, paths.sessionTmp,
    "--proc", "/proc",
    "--dev", "/dev",
    "--unshare-net",
    "--unshare-pid",
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
