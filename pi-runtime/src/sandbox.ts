import { spawn } from "child_process";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { config } from "./config";

export interface SandboxPaths {
  root: string;
  workspace: string;
  home: string;
  tmp: string;
}

export function buildSandboxPaths(sessionId: string): SandboxPaths {
  const root = join(config.sandbox.root, sessionId);
  return {
    root,
    workspace: join(root, "workspace"),
    home: join(root, "home"),
    tmp: join(root, "tmp"),
  };
}

export async function createSandbox(sessionId: string): Promise<SandboxPaths> {
  const paths = buildSandboxPaths(sessionId);

  await mkdir(paths.workspace, { recursive: true });
  await mkdir(paths.home, { recursive: true });
  await mkdir(paths.tmp, { recursive: true });

  console.log(`[sandbox] session ${sessionId}: 沙盒目录创建完成: ${paths.root}`);
  return paths;
}

export async function destroySandbox(sessionId: string): Promise<void> {
  const paths = buildSandboxPaths(sessionId);
  await rm(paths.root, { recursive: true, force: true });
  console.log(`[sandbox] session ${sessionId}: 沙盒已销毁`);
}

/**
 * 在 bwrap 沙盒内执行命令。
 * 沙盒特性：
 *   - workspace 目录可读写（挂载为 /workspace）
 *   - 系统目录只读
 *   - 禁止网络（--unshare-net）
 *   - 独立 PID 空间（--unshare-pid）
 */
export function execInSandbox(
  cmd: string,
  paths: SandboxPaths
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const bwrapArgs = [
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/sbin", "/sbin",
      "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
      "--bind", paths.workspace, "/workspace",
      "--bind", paths.home, "/root",
      "--tmpfs", "/tmp",
      "--proc", "/proc",
      "--dev", "/dev",
      "--unshare-net",
      "--unshare-pid",
      "--die-with-parent",
      "--chdir", "/workspace",
      "--",
      "bash",
      "-c",
      cmd,
    ];

    const proc = spawn("bwrap", bwrapArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });

    proc.on("error", (err) => {
      resolve({ stdout: "", stderr: err.message, exitCode: 1 });
    });
  });
}
