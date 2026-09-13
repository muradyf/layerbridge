#!/usr/bin/env node

/*
 * Derived from gethopp/figma-mcp-bridge (https://github.com/gethopp/figma-mcp-bridge), MIT License.
 * Copyright (c) 2026 GETHOPP LTD. Modifications Copyright (c) 2026 Murad Yousuf.
 * See LICENSE.md and NOTICE.md.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Node } from "./node.js";
import { Election } from "./election.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";
import { VERSION } from "./version.js";
import { ALLOWED_PORTS } from "./auth.js";
import { SERVER_KEY } from "./brand.js";
import { isCliInvocation, runCli } from "./cli.js";
import { DEFAULT_PORT } from "./setup.js";

// 1995, not upstream's 1994: 1994 is also figma-mcp-go's and gethopp's port,
// and sharing it made the servers' leader elections and plugins collide.
// Figma only lets the plugin reach ports its manifest lists, so the choice is
// 1995–1999; the plugin panel's Port setting must match.
export { DEFAULT_PORT };

function resolvePort(): number {
  const raw = process.env.FIGMA_BRIDGE_PORT;
  // Empty counts as unset: config UIs (e.g. a Claude Desktop extension's
  // settings) can pass an empty string for a field left blank.
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || !ALLOWED_PORTS.includes(port)) {
    // An explicitly set but unusable value must fail loudly: the plugin could
    // never connect, and the error would otherwise look like a Figma problem.
    console.error(`Invalid FIGMA_BRIDGE_PORT "${raw}" — the plugin can only reach ${ALLOWED_PORTS.join(", ")}`);
    process.exit(1);
  }
  return port;
}

async function main(): Promise<void> {
  const PORT = resolvePort();
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
    name: SERVER_KEY,
    version: VERSION,
  });

  registerTools(server, node, PORT);

  console.error(`Starting MCP server (role: ${node.roleName})`);

  transport = new StdioServerTransport();
  await server.connect(transport);
}

const argv = process.argv.slice(2);
if (isCliInvocation(argv)) {
  // A subcommand (setup, doctor, --version, --help): stdout is the user's
  // terminal here, not an MCP transport.
  runCli(argv).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  );
} else {
  // Anything else starts the stdio MCP server, as before. Unknown arguments are
  // ignored rather than fatal, so a client passing extra args still connects.
  if (argv.length > 0) console.error(`Ignoring arguments ${JSON.stringify(argv)}; run with --help for commands`);
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
