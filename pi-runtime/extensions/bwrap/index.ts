/**
 * Pi Agent bwrap 沙盒扩展。
 *
 * ═══════════════════════════════════════════════════════════════
 * ⚠️  PI 版本兼容性说明（升级 pi 时必读）
 * ═══════════════════════════════════════════════════════════════
 * 本文件依赖以下 pi Extension API，升级 pi 后需验证这些点：
 *
 * 1. export default function(pi: ExtensionAPI)
 *    pi 扩展必须导出 default 函数并接收 pi 作为参数（非全局变量）。
 *    当前使用版本：pi@0.79.x
 *
 * 2. pi.registerTool({ name, execute, ... })
 *    接收工具定义对象，通过 spread createXxxTool() 继承默认行为。
 *
 * 3. createBashTool / createReadTool / createWriteTool / createEditTool
 *    createFindTool / createGrepTool / createLsTool
 *    从 @earendil-works/pi-coding-agent 导入，用于创建带 operations 覆盖的工具。
 *
 * 4. execute 返回 { content: [{ type: "text", text }] }
 *
 * 升级 pi 时的验证步骤：
 *   1. docker build（会在构建时暴露 npm 安装错误）
 *   2. 启动容器，确认 bwrap.ready 文件被写入（/tmp/pi-config/{sessionId}/bwrap.ready）
 *   3. 确认 bash 命令在沙盒内执行（curl 等网络命令应失败）
 *   4. 确认 read/write/find/grep/ls 越界路径被拦截
 * ═══════════════════════════════════════════════════════════════
 *
 * 沙盒特性（由 worker 在启动 pi 进程前注入环境变量）：
 *   PI_SANDBOX_WORKSPACE → session 专属工作目录
 *   PI_SANDBOX_HOME      → session 专属 home
 *   PI_SANDBOX_TMP       → session 临时目录
 *   --unshare-net        → 禁止网络访问
 *   --unshare-pid        → 独立 PID 空间
 *   --tmpfs sandboxRoot  → 对沙盒内隐藏其他 session/user 目录
 */

import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const sandboxRoot = process.env.PI_SANDBOX_ROOT ?? "/data/sandboxes";
const sandboxWorkspace = process.env.PI_SANDBOX_WORKSPACE ?? "";
const sandboxHome = process.env.PI_SANDBOX_HOME ?? "";
const sandboxTmp = process.env.PI_SANDBOX_TMP ?? "";
const piCodingAgentDir = process.env.PI_CODING_AGENT_DIR ?? "";

// ── bwrap 参数构造 ────────────────────────────────────────────────────────────

function buildBwrapArgs(cmd: string): string[] {
  return [
    "--ro-bind", "/", "/",
    // 用空 tmpfs 覆盖整个 sandbox 根目录，对 bwrap 内隐藏其他 session/user 数据
    "--tmpfs", sandboxRoot,
    "--bind", sandboxWorkspace, sandboxWorkspace,
    "--bind", sandboxHome, sandboxHome,
    ...(sandboxTmp ? ["--bind", sandboxTmp, sandboxTmp] : ["--tmpfs", "/tmp"]),
    "--proc", "/proc",
    "--dev", "/dev",
    "--unshare-net",
    "--unshare-pid",
    "--die-with-parent",
    "--chdir", sandboxWorkspace,
    "--", "bash", "-c", cmd,
  ];
}

/**
 * 实现 BashOperations 接口，将命令路由到 bwrap 沙盒执行。
 * onData 流式传递输出，与 pi 的默认实现保持一致。
 */
function createBwrapBashOperations(): BashOperations {
  return {
    async exec(command, _cwd, { onData, signal, timeout }) {
      return new Promise((resolve, reject) => {
        const args = buildBwrapArgs(command);
        const child = spawn("bwrap", args, { stdio: ["ignore", "pipe", "pipe"] });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        const onAbort = () => child.kill("SIGKILL");
        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code ?? 1 });
          }
        });
      });
    },
  };
}

// ── 路径白名单校验 ────────────────────────────────────────────────────────────

/**
 * 校验路径是否在 workspace / home 范围内。
 * 使用 fs.realpath() 解析符号链接后再做白名单判断，防止：
 *   1. ../路径遍历（path.resolve 字符串层面已处理）
 *   2. 符号链接逃逸（workspace/link → /data/sandboxes/other-user）
 *
 * 对于尚不存在的路径（如写入新文件），逐级向上找到最近存在的父目录，
 * 对父目录做 realpath，再拼回文件名，避免误拒合法的新建文件操作。
 */
async function guardPath(rawPath: string): Promise<{ safe: true } | { safe: false; reason: string }> {
  const { realpath, access: fsAccess } = await import("fs/promises");
  const { resolve: pathResolve, dirname, basename, join: pathJoin } = await import("path");

  const tentative = pathResolve(sandboxWorkspace, rawPath);
  const allowed = [sandboxWorkspace, sandboxHome].filter(Boolean);

  // 第一道：字符串检查（快速排除明显越界，如绝对路径、../遍历）
  const tentativeOk = allowed.some((base) => tentative.startsWith(base + "/") || tentative === base);
  if (!tentativeOk) {
    return { safe: false, reason: `路径越界: ${rawPath} → ${tentative}（只允许访问 workspace 和 home）` };
  }

  // 第二道：realpath 检查（解析符号链接后再做白名单判断，防止 symlink 逃逸）
  let canonical: string;
  try {
    canonical = await realpath(tentative);
  } catch {
    // 路径不存在（如写入新文件）：对父目录做 realpath，再拼回文件名
    try {
      const parentReal = await realpath(dirname(tentative));
      canonical = pathJoin(parentReal, basename(tentative));
    } catch {
      canonical = tentative; // 父目录也不存在，维持原路径（访问时会自然报错）
    }
  }

  const canonicalOk = allowed.some((base) => canonical.startsWith(base + "/") || canonical === base);
  if (!canonicalOk) {
    return { safe: false, reason: `路径越界（符号链接解析后）: ${rawPath} → ${canonical}（只允许访问 workspace 和 home）` };
  }

  return { safe: true };
}

function makeErrorResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ── 扩展入口 ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // 安全关键校验：环境变量未注入说明运行上下文异常，抛错阻止扩展注册（fail-closed）。
  // 扩展抛错 → bwrap.ready 文件不会被写入 → pi-session.ts 检测到并终止 session。
  if (!sandboxWorkspace || !sandboxHome) {
    throw new Error(
      "[bwrap] 严重错误: PI_SANDBOX_WORKSPACE 或 PI_SANDBOX_HOME 未设置，" +
      "拒绝注册工具（fail-closed）。请检查 worker 是否正确注入了沙盒环境变量。"
    );
  }

  // bash：完全替换为 bwrap 沙盒执行（LLM 调用路径）
  const bwrapBash = createBashTool(sandboxWorkspace, { operations: createBwrapBashOperations() });
  pi.registerTool({ ...bwrapBash, label: "bash (bwrap sandbox)" });

  // user_bash：用户在 TUI 里直接输入 shell 命令的路径（--mode rpc 下通常不触发，防御性兜底）
  pi.on("user_bash", () => ({ operations: createBwrapBashOperations() }));

  // read/write/edit：路径白名单校验，通过后 fallthrough 到 pi 默认实现
  for (const [toolName, createTool] of [
    ["read",  createReadTool],
    ["write", createWriteTool],
    ["edit",  createEditTool],
  ] as const) {
    const defaultTool = createTool(sandboxWorkspace);
    pi.registerTool({
      ...defaultTool,
      execute: async (id, params, signal, onUpdate, ctx) => {
        const rawPath = ((params as Record<string, unknown>)["path"] ?? "") as string;
        if (rawPath) {
          const check = await guardPath(rawPath);
          if (!check.safe) {
            console.error(`[bwrap] 拦截越界 tool=${toolName} path=${rawPath}`);
            return makeErrorResult(check.reason);
          }
        }
        return defaultTool.execute(id, params, signal, onUpdate, ctx);
      },
    });
  }

  // find/grep/ls
  for (const [toolName, createTool] of [
    ["find", createFindTool],
    ["grep", createGrepTool],
    ["ls",   createLsTool],
  ] as const) {
    const defaultTool = createTool(sandboxWorkspace);
    pi.registerTool({
      ...defaultTool,
      execute: async (id, params, signal, onUpdate, ctx) => {
        const rawPath = ((params as Record<string, unknown>)["path"] ?? "") as string;
        if (rawPath) {
          const check = await guardPath(rawPath);
          if (!check.safe) {
            console.error(`[bwrap] 拦截越界 tool=${toolName} path=${rawPath}`);
            return makeErrorResult(check.reason);
          }
        }
        return defaultTool.execute(id, params, signal, onUpdate, ctx);
      },
    });
  }

  // 就绪标记文件：必须在所有 registerTool 调用之后写入。
  // "文件存在" = 扩展完整初始化，所有工具保护已注册。
  // pi-session.ts 依赖此文件做 fail-closed 启动校验。
  if (piCodingAgentDir) {
    writeFileSync(join(piCodingAgentDir, "bwrap.ready"), "1", { flag: "w" });
    console.error(`[bwrap] 沙盒扩展已就绪 workspace=${sandboxWorkspace} home=${sandboxHome} tmp=${sandboxTmp}`);
  } else {
    console.error("[bwrap] 警告: PI_CODING_AGENT_DIR 未设置，无法写入就绪标记文件");
  }
}
