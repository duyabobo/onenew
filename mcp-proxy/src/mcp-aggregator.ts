/**
 * MCP 聚合器：连接多个后端 MCP Server，汇总工具列表，路由工具调用。
 *
 * 工作流程：
 *   1. refresh(servers) 连接所有后端，拉取工具列表，构建 toolName→{client,server} 索引
 *   2. listTools()       返回聚合后的工具列表（去重，重名时保留先发现的）
 *   3. callTool()        根据工具名路由到对应后端执行
 *
 * 刷新策略：
 *   - refreshIfStale() 按 TTL 定时触发，避免频繁重连
 *   - 每次刷新先关闭旧连接，再重新连接所有 server
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerEntry } from "./mongo-client.js";

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface ToolEntry {
  tool: ToolDefinition;
  serverName: string;
  client: Client;
}

export class McpAggregator {
  private toolMap = new Map<string, ToolEntry>();
  private clientMap = new Map<string, Client>();
  private lastRefreshAt = 0;
  private readonly refreshIntervalMs: number;

  constructor(refreshIntervalMs: number) {
    this.refreshIntervalMs = refreshIntervalMs;
  }

  async refreshIfStale(servers: McpServerEntry[]): Promise<void> {
    if (Date.now() - this.lastRefreshAt < this.refreshIntervalMs) return;
    await this.refresh(servers);
  }

  async refresh(servers: McpServerEntry[]): Promise<void> {
    await this.closeAllClients();
    this.toolMap.clear();

    for (const server of servers) {
      await this.connectAndLoadTools(server);
    }

    this.lastRefreshAt = Date.now();
    console.log(`[mcp-proxy:aggregator] 刷新完成，共 ${this.toolMap.size} 个工具`);
  }

  listTools(): ToolDefinition[] {
    return [...this.toolMap.values()].map((e) => e.tool);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const entry = this.toolMap.get(name);
    if (!entry) throw new Error(`工具未找到: ${name}`);
    console.log(`[mcp-proxy:aggregator] 调用工具: ${name} → server=${entry.serverName}`);
    return await entry.client.callTool({ name, arguments: args });
  }

  private async connectAndLoadTools(server: McpServerEntry): Promise<void> {
    try {
      const client = new Client({ name: "mcp-proxy", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(server.url));
      await client.connect(transport);
      this.clientMap.set(server.name, client);

      const { tools } = await client.listTools();
      let loaded = 0;
      for (const tool of tools) {
        if (this.toolMap.has(tool.name)) {
          console.warn(
            `[mcp-proxy:aggregator] 工具名冲突: "${tool.name}" ` +
            `已存在于 ${this.toolMap.get(tool.name)!.serverName}，跳过 ${server.name}`
          );
          continue;
        }
        this.toolMap.set(tool.name, {
          tool: { name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown> },
          serverName: server.name,
          client,
        });
        loaded++;
      }
      console.log(`[mcp-proxy:aggregator] server=${server.name}: 加载 ${loaded} 个工具`);
    } catch (err) {
      console.error(
        `[mcp-proxy:aggregator] 连接 MCP server 失败: name=${server.name} url=${server.url}`,
        err
      );
    }
  }

  private async closeAllClients(): Promise<void> {
    const closePromises = [...this.clientMap.values()].map((c) =>
      c.close().catch(() => {})
    );
    await Promise.all(closePromises);
    this.clientMap.clear();
  }
}
