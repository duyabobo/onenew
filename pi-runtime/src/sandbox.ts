/**
 * bwrap 沙盒管理模块。
 *
 * 隔离粒度：session 级别（一个 chat 窗口 = 一个 session = 一套独立目录）。
 *
 * 目录结构：
 *   {SANDBOX_ROOT}/users/{user_id}/sessions/{session_id}/
 *     workspace/  ← session 内跨轮次持久，session 关闭时销毁
 *     home/       ← session 内跨轮次持久（.bashrc、pip 包路径等），session 关闭时销毁
 *     tmp/        ← session 内跨轮次持久，session 关闭时销毁
 *
 *   {SANDBOX_ROOT}/users/{user_id}/skills/  ← 用户专属 skill，跨 session 永久保留
 *   {SANDBOX_ROOT}/global/skills/           ← admin 管理的全局 skill
 *
 * 生命周期：
 *   createSandbox  → session 开始时调用一次（打开新 chat）
 *   destroySandbox → session 结束时调用一次（关闭 chat）
 *   两次调用之间（多轮对话），workspace/home/tmp 全程保留，文件不丢失
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
  userSkills: string;
  globalSkills: string;
}

function buildSessionRoot(userId: string, sessionId: string): string {
  return join(config.sandbox.root, "users", userId, "sessions", sessionId);
}

/**
 * 创建 session 沙盒目录，写入初始 .bashrc。
 * 每次打开新 chat 调用一次，创建全新目录。
 */
export async function createSandbox(userId: string, sessionId: string): Promise<SandboxPaths> {
  const sessionRoot = buildSessionRoot(userId, sessionId);
  const workspace = join(sessionRoot, "workspace");
  const home = join(sessionRoot, "home");
  const sessionTmp = join(sessionRoot, "tmp");
  const userSkills = join(config.sandbox.root, "users", userId, "skills");
  const globalSkills = join(config.sandbox.root, "global", "skills");

  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(sessionTmp, { recursive: true });
  await mkdir(userSkills, { recursive: true });
  await mkdir(globalSkills, { recursive: true });

  await writeFile(join(home, ".bashrc"), [
    "export HOME=/root",
    "export PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin",
    "export PYTHONUSERBASE=/root/.local",
    "export PIP_USER=1",
    "",
  ].join("\n"));

  console.log(`[sandbox] session=${sessionId} user=${userId}: 沙盒创建完成 workspace=${workspace}`);
  return { workspace, home, sessionTmp, userSkills, globalSkills };
}

/**
 * 销毁 session 沙盒目录（workspace + home + tmp 全部删除）。
 * 只在 session 关闭时调用，不在单次轮次结束后调用。
 */
export async function destroySandbox(userId: string, sessionId: string): Promise<void> {
  const sessionRoot = buildSessionRoot(userId, sessionId);
  await rm(sessionRoot, { recursive: true, force: true });
  console.log(`[sandbox] session=${sessionId}: 沙盒已销毁`);
}

function buildBwrapArgs(paths: SandboxPaths): string[] {
  return [
    "--ro-bind", "/", "/",
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
