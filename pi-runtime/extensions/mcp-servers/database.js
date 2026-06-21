#!/usr/bin/env node
/**
 * MongoDB 数据库查询 MCP 服务器（stdio transport）。
 * 提供只读查询工具，不开放写入，降低数据风险。
 */
"use strict";

const { createServer } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { MongoClient } = require("mongodb");

const DB_URI = process.env.DB_URI ?? "mongodb://mongo:27017";
const DB_NAME = process.env.DB_NAME ?? "pi_agent";

const server = createServer(
  { name: "database", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

let dbClient = null;

async function getDb() {
  if (!dbClient) {
    dbClient = new MongoClient(DB_URI);
    await dbClient.connect();
  }
  return dbClient.db(DB_NAME);
}

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "db_find",
      description: "在 MongoDB 集合中查询文档（只读）",
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string", description: "集合名称" },
          filter: { type: "object", description: "查询条件（MongoDB filter）" },
          limit: { type: "number", description: "最多返回条数，默认 10，最大 100" },
        },
        required: ["collection"],
      },
    },
    {
      name: "db_count",
      description: "统计 MongoDB 集合中符合条件的文档数量",
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string", description: "集合名称" },
          filter: { type: "object", description: "查询条件（MongoDB filter）" },
        },
        required: ["collection"],
      },
    },
  ],
}));

server.setRequestHandler("tools/call", async (req) => {
  const { name, arguments: args } = req.params;
  const db = await getDb();

  if (name === "db_find") {
    const limit = Math.min(args.limit ?? 10, 100);
    const docs = await db
      .collection(args.collection)
      .find(args.filter ?? {})
      .limit(limit)
      .toArray();
    return { content: [{ type: "text", text: JSON.stringify(docs, null, 2) }] };
  }

  if (name === "db_count") {
    const count = await db.collection(args.collection).countDocuments(args.filter ?? {});
    return { content: [{ type: "text", text: String(count) }] };
  }

  throw new Error(`未知工具: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[database-mcp] 启动完成\n");
}

main().catch((err) => {
  process.stderr.write(`[database-mcp] 启动失败: ${err}\n`);
  process.exit(1);
});
