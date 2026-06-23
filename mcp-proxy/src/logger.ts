/**
 * 日志模块：格式与其他服务（gateway / admin / llm-proxy）保持一致。
 *
 * 输出格式：YYYY-MM-DD HH:mm:ss [LEVEL] module: message
 * 输出目标：控制台 + 按天分割的文件（保留 7 天）
 * 日志级别：由 LOG_LEVEL 环境变量控制，默认 info
 */
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";

const LOG_DIR = process.env.LOG_DIR ?? "/app/logs";
const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();

const timestampFormat = winston.format.timestamp({
  format: "YYYY-MM-DD HH:mm:ss",
});

const messageFormat = winston.format.printf(({ timestamp, level, message, module: mod, ...rest }) => {
  const modulePart = mod ? `${mod}` : "mcp-proxy";
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
  return `${timestamp} [${level.toUpperCase()}] ${modulePart}: ${message}${extra}`;
});

const sharedFormat = winston.format.combine(timestampFormat, messageFormat);

const consoleTransport = new winston.transports.Console({ format: sharedFormat });

const fileTransport = new DailyRotateFile({
  dirname: LOG_DIR,
  filename: "mcp-proxy-%DATE%.log",
  datePattern: "YYYY-MM-DD",
  maxFiles: "7d",
  format: sharedFormat,
});

const rootLogger = winston.createLogger({
  level: LOG_LEVEL,
  transports: [consoleTransport, fileTransport],
});

/**
 * 获取带模块名前缀的子日志器。
 * 用法：const logger = getLogger("aggregator");
 *       logger.info("刷新完成");
 * 输出：2026-06-23 19:10:30 [INFO] mcp-proxy:aggregator: 刷新完成
 */
export function getLogger(module?: string): winston.Logger {
  const moduleName = module ? `mcp-proxy:${module}` : "mcp-proxy";
  return rootLogger.child({ module: moduleName });
}
