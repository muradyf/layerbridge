#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Node } from "./node.js";
import { Election } from "./election.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";
import { ALLOWED_PORTS } from "./auth.js";

// 1995, not upstream's 1994: 1994 is also figma-mcp-go's and gethopp's port,
// and sharing it made the servers' leader elections and plugins collide.
// Figma only lets the plugin reach ports its manifest lists, so the choice is
// 1995–1999; the plugin panel's Port setting must match.
export const DEFAULT_PORT = 1995;

function resolvePort(): number {
  const raw = process.env.FIGMA_BRIDGE_PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || !ALLOWED_PORTS.includes(port)) {
    // An explicitly set but unusable value must fail loudly: the plugin could
    // never connect, and the error would otherwise look like a Figma problem.
    console.error(`Invalid FIGMA_BRIDGE_PORT "${raw}" — the plugin can only reach ${ALLOWED_PORTS.join(", ")}`);
    process.exit(1);
  }
  return port;
}
const PORT = resolvePort();

async function main(): Promise<void> {
  const node = new Node(PORT);
  const election = new Election(PORT, node);
  await election.start();

  let transport: StdioServerTransport | null = null;
  let shuttingDown = false;
  const shutdown = async (reason: string, code: number = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Shutting down (${reason})...`);

    const force = setTimeout(() => {
      console.error("Shutdown timeout exceeded, forcing exit");
      process.exit(code);
    }, 5000);
    force.unref();

    election.stop();
    node.stop();
    if (transport) {
      try {
        await transport.close();
      } catch (err) {
        console.error("Transport close error:", err);
      }
    }
    process.exit(code);
  };

  process.stdin.on("end", () => void shutdown("stdin end"));
  process.stdin.on("close", () => void shutdown("stdin close"));

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  process.on("uncaughtException", async (err) => {
    console.error("Uncaught exception:", err);
    await shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
  });

  const server = new McpServer({
    name: "figma-bridge",
    version: VERSION,
  });

  registerTools(server, node, PORT);

  console.error(`Starting MCP server (role: ${node.roleName})`);

  transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
