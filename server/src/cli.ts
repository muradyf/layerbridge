/**
 * Command-line subcommands. With no arguments the entry point runs the stdio
 * MCP server, which must never print to stdout; only an explicit subcommand
 * reaches this file, and only then is stdout used.
 */
import readline from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ALLOWED_PORTS } from "./auth.js";
import { DISPLAY_NAME, PACKAGE_NAME, PLUGIN_MENU_NAME, SERVER_KEY } from "./brand.js";
import { formatChecks, runDoctor } from "./doctor.js";
import {
  CLIENT_IDS,
  DEFAULT_PORT,
  WRITABLE_CLIENTS,
  bundledPluginDir,
  clientSnippets,
  configPath,
  diffLines,
  installPlugin,
  mergeServerConfig,
  serverEntry,
  stablePluginDir,
  writeWithBackup,
  type ClientId,
} from "./setup.js";
import { VERSION } from "./version.js";

const COMMANDS = new Set(["--version", "-v", "version", "--help", "-h", "help", "setup", "doctor"]);

/** Whether argv (without node and the script) asks for a CLI command instead of the MCP server. */
export const isCliInvocation = (argv: string[]) => argv.length > 0 && COMMANDS.has(argv[0]);

export type Io = { out: (text: string) => void; err: (text: string) => void; isTTY?: boolean };

const defaultIo: Io = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
};

export const HELP = `${DISPLAY_NAME} ${VERSION} — MCP server for the Figma file open in the ${PLUGIN_MENU_NAME} plugin

Usage:
  ${PACKAGE_NAME}                 Run the MCP server over stdio (what AI tools launch)
  ${PACKAGE_NAME} setup           Install the Figma plugin copy and print config for AI tools
  ${PACKAGE_NAME} doctor          Check the server, port, token, connected files and plugin
  ${PACKAGE_NAME} --version
  ${PACKAGE_NAME} --help

setup options:
  --client <name>    Only show one client: ${CLIENT_IDS.join(", ")}
  --write            Write the config file for --client (${WRITABLE_CLIENTS.join(", ")}); shows the diff and backs up the old file
  --yes              Write without asking (required when not in a terminal)
  --no-copy          Don't copy the plugin; print the path of the bundled one
  --port <n>         Port ${ALLOWED_PORTS.join("/")} (default: FIGMA_BRIDGE_PORT or ${DEFAULT_PORT})

doctor options:
  --port <n>         Port to check (default: FIGMA_BRIDGE_PORT or ${DEFAULT_PORT})

Environment (server):
  FIGMA_BRIDGE_PORT          Port, 1995–1999 (default 1995); pick the same in the plugin panel
  FIGMA_BRIDGE_OUTPUT_ROOTS  Extra folders export tools may write to (; on Windows, : elsewhere)
  FIGMA_ACCESS_TOKEN         Optional personal access token; enables the REST tools
  FIGMA_BRIDGE_ALLOW_SCRIPTS Set to allow run_script`;

type Flags = { client?: string; write: boolean; yes: boolean; noCopy: boolean; port?: string };

function parseFlags(args: string[]): Flags | string {
  const flags: Flags = { write: false, yes: false, noCopy: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    try {
      if (arg === "--client") flags.client = value();
      else if (arg === "--port") flags.port = value();
      else if (arg === "--write") flags.write = true;
      else if (arg === "--yes" || arg === "-y") flags.yes = true;
      else if (arg === "--no-copy") flags.noCopy = true;
      else return `Unknown option ${arg}`;
    } catch (err) {
      return (err as Error).message;
    }
  }
  return flags;
}

function resolvePortFlag(flag: string | undefined, env = process.env): number | string {
  const raw = flag ?? env.FIGMA_BRIDGE_PORT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const port = Number(raw.trim());
  return Number.isInteger(port) && ALLOWED_PORTS.includes(port) ? port : `Port "${raw}" is not one of ${ALLOWED_PORTS.join(", ")}`;
}

export async function runCli(argv: string[], io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v" || command === "version") {
    io.out(VERSION);
    return 0;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    io.out(HELP);
    return 0;
  }

  const flags = parseFlags(rest);
  if (typeof flags === "string") {
    io.err(`${flags}\n\nRun ${PACKAGE_NAME} --help for usage.`);
    return 2;
  }
  const port = resolvePortFlag(flags.port);
  if (typeof port === "string") {
    io.err(port);
    return 2;
  }

  if (command === "doctor") {
    const checks = await runDoctor({ port });
    io.out(formatChecks(checks));
    return checks.some((c) => c.status === "fail") ? 1 : 0;
  }
  return setup(flags, port, io);
}

async function setup(flags: Flags, port: number, io: Io): Promise<number> {
  if (flags.client !== undefined && !CLIENT_IDS.includes(flags.client as ClientId)) {
    io.err(`Unknown client "${flags.client}". Choose one of: ${CLIENT_IDS.join(", ")}`);
    return 2;
  }
  const client = flags.client as ClientId | undefined;
  if (flags.write && (!client || !WRITABLE_CLIENTS.includes(client))) {
    io.err(`--write needs --client ${WRITABLE_CLIENTS.join(" | ")}. For other clients, paste the snippet setup prints.`);
    return 2;
  }

  // 1. The Figma plugin
  io.out(`${DISPLAY_NAME} ${VERSION} setup\n`);
  io.out("1. Add the plugin to Figma (once)");
  const bundled = bundledPluginDir();
  if (!bundled) {
    io.out("   This copy of the server has no built plugin. In the repo run `cd plugin && bun install && bun run build`, then:");
    io.out("   Figma desktop → open a design file → Plugins → Development → Import plugin from manifest… → plugin/manifest.json");
  } else if (flags.noCopy) {
    io.out(`   Figma desktop → open a design file → Plugins → Development → Import plugin from manifest… →\n   ${path.join(bundled, "manifest.json")}`);
    io.out("   (This path changes when npx updates the package; setup without --no-copy keeps a stable copy.)");
  } else {
    const target = stablePluginDir();
    let manifest: string;
    try {
      manifest = installPlugin(bundled, target);
    } catch (err) {
      io.err(`   Could not copy the plugin to ${target}: ${(err as Error).message}`);
      return 1;
    }
    io.out(`   Plugin files are at ${target} (re-run setup after updating to refresh them).`);
    io.out(`   Figma desktop → open a design file → Plugins → Development → Import plugin from manifest… →\n   ${manifest}`);
    if (existsSync(path.join(target, "manifest.boards.json"))) {
      io.out(`   For FigJam boards and Slides decks, also import (from a FigJam file) →\n   ${path.join(target, "manifest.boards.json")}`);
    }
  }
  io.out("   Already imported it? Nothing to do — Figma reads the files from that path each run.\n");

  // 2. The AI tool
  io.out(`2. Add the server to your AI tool${port !== DEFAULT_PORT ? ` (port ${port})` : ""}`);
  for (const s of clientSnippets(port).filter((s) => !client || s.client === client)) {
    // Indent non-empty lines only, so a pasted snippet carries no trailing spaces.
    io.out(`\n   ${s.title} — ${s.where}\n${s.text.replace(/^(?=.)/gm, "     ")}`);
  }
  io.out("\n   Then restart the AI tool.\n");

  // 3. Every session
  io.out(`3. Every session: open the file in Figma, run Plugins → Development → ${PLUGIN_MENU_NAME}${port !== DEFAULT_PORT ? `, set Port to ${port}` : ""}, keep the window open.`);
  io.out(`   Something wrong? Run: npx -y ${PACKAGE_NAME} doctor${port !== DEFAULT_PORT ? ` --port ${port}` : ""}`);

  if (flags.write && client) return writeConfig(client, port, flags.yes, io);
  return 0;
}

async function writeConfig(client: ClientId, port: number, yes: boolean, io: Io): Promise<number> {
  const file = configPath(client);
  if (!file) {
    io.err(`\n${client} has no config file on ${process.platform}.`);
    return 2;
  }
  const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  let merged: ReturnType<typeof mergeServerConfig>;
  try {
    merged = mergeServerConfig(existing, serverEntry(port));
  } catch (err) {
    io.err(`\nNot writing ${file}: ${(err as Error).message}`);
    return 1;
  }
  if (!merged.changed) {
    io.out(`\n${file} already has "${SERVER_KEY}" configured this way. Nothing to write.`);
    return 0;
  }
  io.out(`\nChanges to ${file}${existing === undefined ? " (new file)" : ""}:\n${diffLines(merged.before, merged.after)}`);

  if (!yes) {
    if (!io.isTTY) {
      io.err("\nNot written. Re-run with --yes to write it.");
      return 1;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("\nWrite this? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      io.out("Not written.");
      return 1;
    }
  }
  const { backup } = writeWithBackup(file, merged.after);
  io.out(`Wrote ${file}${backup ? ` (previous version saved as ${backup})` : ""}. Restart ${client} to load it.`);
  return 0;
}
