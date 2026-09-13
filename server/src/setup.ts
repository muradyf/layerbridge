/**
 * `setup`: puts a stable copy of the Figma plugin on disk and prints (or, for
 * the clients whose config file location and format are documented, writes)
 * the MCP client configuration.
 *
 * Why copy the plugin: Figma remembers a development plugin by the path of its
 * manifest. The package's own copy lives in npx's cache, whose folder changes
 * with every version and can be cleared at any time. The per-user copy keeps
 * one path; re-running setup after an update refreshes it in place.
 *
 * Config locations (checked 2026-09-14):
 *  - Claude Code: `claude mcp add` — https://code.claude.com/docs/en/mcp
 *  - Claude Desktop: claude_desktop_config.json — https://modelcontextprotocol.io/docs/develop/connect-local-servers
 *  - Cursor: ~/.cursor/mcp.json — https://cursor.com/docs/context/mcp
 *  - VS Code: .vscode/mcp.json, top-level "servers" — https://code.visualstudio.com/docs/copilot/customization/mcp-servers
 *  - Windsurf: ~/.codeium/windsurf/mcp_config.json — https://docs.devin.ai/desktop/cascade/mcp
 *  - Codex: ~/.codex/config.toml, [mcp_servers.<name>] — https://learn.chatgpt.com/docs/extend/mcp?surface=cli
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR_NAME, NPX_SPEC, SERVER_KEY } from "./brand.js";

export const DEFAULT_PORT = 1995;

export type ClientId = "claude-code" | "claude-desktop" | "cursor" | "vscode" | "windsurf" | "codex";
export const CLIENT_IDS: ClientId[] = ["claude-code", "claude-desktop", "cursor", "vscode", "windsurf", "codex"];

/** Clients whose config is a JSON file with a top-level `mcpServers` object at a documented path. */
export const WRITABLE_CLIENTS: ClientId[] = ["claude-desktop", "cursor", "windsurf"];

export type Platform = NodeJS.Platform;
type Env = Record<string, string | undefined>;

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The plugin shipped with this server: `<package>/plugin` when installed from
 * npm, or the repo's `plugin/` folder when run from a git checkout.
 */
export function bundledPluginDir(serverRoot = path.join(here, "..")): string | undefined {
  for (const dir of [path.join(serverRoot, "plugin"), path.join(serverRoot, "..", "plugin")]) {
    if (existsSync(path.join(dir, "manifest.json")) && existsSync(path.join(dir, "dist", "code.js"))) return dir;
  }
  return undefined;
}

export function userDataDir(platform: Platform = process.platform, env: Env = process.env, home = os.homedir()): string {
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  return path.join(base, DATA_DIR_NAME);
}

export const stablePluginDir = (platform?: Platform, env?: Env, home?: string) =>
  path.join(userDataDir(platform, env, home), "plugin");

/** Copies the bundled plugin to `target` (replacing its dist/) and returns the manifest path. */
export function installPlugin(source: string, target: string): string {
  mkdirSync(target, { recursive: true });
  rmSync(path.join(target, "dist"), { recursive: true, force: true });
  cpSync(path.join(source, "dist"), path.join(target, "dist"), { recursive: true });
  copyFileSync(path.join(source, "manifest.json"), path.join(target, "manifest.json"));
  for (const notice of ["NOTICE-html-figma.md"]) {
    if (existsSync(path.join(source, notice))) copyFileSync(path.join(source, notice), path.join(target, notice));
  }
  return path.join(target, "manifest.json");
}

/** True when the installed copy's code differs from the bundled one (an update not yet copied). */
export function pluginCopyIsStale(source: string, target: string): boolean {
  try {
    const a = readFileSync(path.join(source, "dist", "code.js"));
    const b = readFileSync(path.join(target, "dist", "code.js"));
    return !a.equals(b);
  } catch {
    return true;
  }
}

/* ── client configuration ─────────────────────────────────────────────────── */

export type ServerEntry = { command: string; args: string[]; env?: Record<string, string> };

export function serverEntry(port = DEFAULT_PORT): ServerEntry {
  return {
    command: "npx",
    args: ["-y", NPX_SPEC],
    ...(port !== DEFAULT_PORT ? { env: { FIGMA_BRIDGE_PORT: String(port) } } : {}),
  };
}

export function configPath(
  client: ClientId,
  platform: Platform = process.platform,
  env: Env = process.env,
  home = os.homedir()
): string | undefined {
  switch (client) {
    case "claude-desktop":
      if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
      return undefined; // Claude Desktop is macOS and Windows only
    case "cursor":
      return path.join(home, ".cursor", "mcp.json");
    case "windsurf":
      return path.join(home, ".codeium", "windsurf", "mcp_config.json");
    case "codex":
      return path.join(home, ".codex", "config.toml");
    default:
      return undefined;
  }
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export type Snippet = { client: ClientId; title: string; where: string; text: string };

export function clientSnippets(port = DEFAULT_PORT, platform: Platform = process.platform): Snippet[] {
  const entry = serverEntry(port);
  const envFlag = entry.env ? ` --env FIGMA_BRIDGE_PORT=${port}` : "";
  const mcpServers = json({ mcpServers: { [SERVER_KEY]: entry } });
  const tomlEnv = entry.env ? `\n\n[mcp_servers.${SERVER_KEY}.env]\nFIGMA_BRIDGE_PORT = "${port}"` : "";
  return [
    {
      client: "claude-code",
      title: "Claude Code",
      where: "Run in a terminal (--scope user makes it available in every project):",
      // --env must not sit directly before the name, so --scope goes between them.
      text: `claude mcp add --transport stdio${envFlag} --scope user ${SERVER_KEY} -- npx -y ${NPX_SPEC}`,
    },
    {
      client: "claude-desktop",
      title: "Claude Desktop",
      where: `Add to ${configPath("claude-desktop", platform) ?? "claude_desktop_config.json (macOS and Windows only)"}:`,
      text: mcpServers,
    },
    { client: "cursor", title: "Cursor", where: "Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project):", text: mcpServers },
    {
      client: "vscode",
      title: "VS Code",
      where: 'Add to .vscode/mcp.json (or run "MCP: Open User Configuration"):',
      text: json({ servers: { [SERVER_KEY]: entry } }),
    },
    { client: "windsurf", title: "Windsurf", where: "Add to ~/.codeium/windsurf/mcp_config.json:", text: mcpServers },
    {
      client: "codex",
      title: "Codex",
      where: `Run \`codex mcp add${entry.env ? ` --env FIGMA_BRIDGE_PORT=${port}` : ""} ${SERVER_KEY} -- npx -y ${NPX_SPEC}\`, or add to ~/.codex/config.toml:`,
      text: `[mcp_servers.${SERVER_KEY}]\ncommand = "npx"\nargs = ["-y", "${NPX_SPEC}"]${tomlEnv}`,
    },
  ];
}

/**
 * Adds or replaces this server in a JSON config's `mcpServers`, leaving every
 * other key as it was. Throws when the existing file is not a JSON object —
 * the caller must not overwrite what it cannot parse.
 */
export function mergeServerConfig(existing: string | undefined, entry: ServerEntry): { before: string; after: string; changed: boolean } {
  const before = existing ?? "";
  let config: Record<string, unknown> = {};
  if (before.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(before);
    } catch {
      throw new Error("the file is not plain JSON (comments or a syntax error?) — edit it by hand with the snippet above");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the file's top level is not a JSON object");
    config = parsed as Record<string, unknown>;
  }
  const servers = config.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
    throw new Error('"mcpServers" in the file is not an object');
  }
  const next = { ...config, mcpServers: { ...((servers as Record<string, unknown>) ?? {}), [SERVER_KEY]: entry } };
  const after = json(next) + "\n";
  const changed = before.trim() === "" || JSON.stringify(JSON.parse(before)) !== JSON.stringify(next);
  return { before, after, changed };
}

/** A minimal line diff (LCS) for showing what a config write changes. */
export function diffLines(before: string, after: string): string {
  const a = before === "" ? [] : before.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // Removals first, like unified diffs.
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  return out.join("\n");
}

/** Writes `content` to `file`, first copying an existing file to `<file>.bak-<timestamp>`. */
export function writeWithBackup(file: string, content: string, now = new Date()): { backup?: string } {
  mkdirSync(path.dirname(file), { recursive: true });
  let backup: string | undefined;
  if (existsSync(file)) {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    backup = `${file}.bak-${stamp}`;
    copyFileSync(file, backup);
  }
  writeFileSync(file, content);
  return { backup };
}
