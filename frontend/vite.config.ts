import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/sessions": "http://localhost:8000",
      "/skills": "http://localhost:8000",    // skill 列表 → gateway
      "/health": "http://localhost:8000",
      "/config": "http://localhost:9000",    // LLM / MCP / Skill CRUD → admin
    },
  },
});
