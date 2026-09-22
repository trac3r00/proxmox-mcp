import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

try {
  const server = createServer(loadConfig(process.env));
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unable to start Proxmox MCP server");
  process.exitCode = 1;
}
