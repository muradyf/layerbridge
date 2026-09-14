// Distribution pieces: CLI subcommands, setup's config merge/backup, doctor's
// checks. Nothing here binds a port in the 1995–1999 range: doctor is pointed
// at a fake leader on an ephemeral port, and the CLI is only run with commands
// that never touch the network.
// Run: bun run build && node --test test/distribution.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8"));

const cli = (...args) =>
  spawnSync(process.execPath, [path.join(dist, "index.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, FIGMA_BRIDGE_PORT: "" },
    timeout: 20_000,
  });

test("--version prints the package version and exits", () => {
  const r = cli("--version");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test("--help lists the subcommands", () => {
  const r = cli("--help");
  assert.equal(r.status, 0);
  for (const word of ["setup", "doctor", "--client", "FIGMA_BRIDGE_PORT"]) assert.match(r.stdout, new RegExp(word));
});

test("setup --no-copy prints every client's config and the plugin step", () => {
  const r = cli("setup", "--no-copy");
  assert.equal(r.status, 0, r.stderr);
  for (const title of ["Claude Code", "Claude Desktop", "Cursor", "VS Code", "Windsurf", "Codex"]) assert.match(r.stdout, new RegExp(title));
  assert.match(r.stdout, /claude mcp add --transport stdio --scope user layerbridge -- npx -y layerbridge@latest/);
  assert.match(r.stdout, /Import plugin from manifest/);
});

test("setup --client and --port narrow and adjust the output", () => {
  const r = cli("setup", "--no-copy", "--client", "codex", "--port", "1997");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Cursor/);
  assert.match(r.stdout, /\[mcp_servers\.layerbridge\.env\]\n +FIGMA_BRIDGE_PORT = "1997"/);
  assert.doesNotMatch(r.stdout, / +\n/, "no trailing spaces in pasted snippets");
});

test("setup rejects bad input with exit code 2", () => {
  assert.equal(cli("setup", "--port", "2000").status, 2);
  assert.equal(cli("setup", "--client", "emacs").status, 2);
  assert.equal(cli("setup", "--write", "--client", "vscode").status, 2);
  assert.equal(cli("setup", "--bogus").status, 2);
});

test("doctor on a port the plugin cannot reach fails without touching the network", () => {
  const r = cli("doctor", "--port", "1994");
  assert.equal(r.status, 2); // rejected before any check runs
  assert.match(r.stderr, /not one of/);
});

test("setup --write asks outside a terminal, then writes with --yes and backs up", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "bridge-home-"));
  const run = (...args) =>
    spawnSync(process.execPath, [path.join(dist, "index.js"), "setup", "--no-copy", "--client", "cursor", "--write", ...args], {
      encoding: "utf8",
      env: { ...process.env, FIGMA_BRIDGE_PORT: "", HOME: home, USERPROFILE: home },
      timeout: 20_000,
    });
  try {
    const file = path.join(home, ".cursor", "mcp.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } } }));

    let r = run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /\+     "layerbridge": \{/);
    assert.match(r.stderr, /--yes/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).mcpServers["layerbridge"], undefined);

    r = run("--yes");
    assert.equal(r.status, 0, r.stderr);
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written.mcpServers.other.command, "x");
    assert.equal(written.mcpServers["layerbridge"].command, "npx");
    assert.equal(readdirSync(path.dirname(file)).filter((f) => f.startsWith("mcp.json.bak-")).length, 1);

    r = run("--yes");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Nothing to write/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("mergeServerConfig keeps other servers and refuses what it cannot parse", async () => {
  const { mergeServerConfig, serverEntry } = await load("setup.js");
  const existing = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } });
  const { after, changed } = mergeServerConfig(existing, serverEntry());
  const parsed = JSON.parse(after);
  assert.equal(changed, true);
  assert.equal(parsed.theme, "dark");
  assert.deepEqual(parsed.mcpServers.other, { command: "x" });
  assert.deepEqual(parsed.mcpServers["layerbridge"], { command: "npx", args: ["-y", "layerbridge@latest"] });

  assert.equal(mergeServerConfig(after, serverEntry()).changed, false);
  assert.deepEqual(JSON.parse(mergeServerConfig(undefined, serverEntry(1996)).after).mcpServers["layerbridge"].env, { FIGMA_BRIDGE_PORT: "1996" });
  assert.throws(() => mergeServerConfig("{ // comment\n}", serverEntry()), /not plain JSON/);
  assert.throws(() => mergeServerConfig("[]", serverEntry()), /not a JSON object/);
  assert.throws(() => mergeServerConfig('{"mcpServers": []}', serverEntry()), /not an object/);
});

test("diffLines marks added and removed lines", async () => {
  const { diffLines } = await load("setup.js");
  assert.equal(diffLines("a\nb\nc\n", "a\nx\nc\n"), "  a\n- b\n+ x\n  c");
  assert.equal(diffLines("", "a\n"), "+ a");
});

test("writeWithBackup keeps the previous file", async () => {
  const { writeWithBackup } = await load("setup.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "bridge-dist-"));
  try {
    const file = path.join(dir, "nested", "mcp.json");
    assert.equal(writeWithBackup(file, "one").backup, undefined);
    const { backup } = writeWithBackup(file, "two", new Date("2026-09-14T10:20:30Z"));
    assert.equal(path.basename(backup), "mcp.json.bak-20260914-102030");
    assert.equal(readFileSync(backup, "utf8"), "one");
    assert.equal(readFileSync(file, "utf8"), "two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config paths follow each client's documented location", async () => {
  const { configPath, userDataDir } = await load("setup.js");
  const home = path.join(path.sep, "home", "u");
  assert.equal(configPath("cursor", "linux", {}, home), path.join(home, ".cursor", "mcp.json"));
  assert.equal(configPath("windsurf", "darwin", {}, home), path.join(home, ".codeium", "windsurf", "mcp_config.json"));
  assert.equal(configPath("claude-desktop", "darwin", {}, home), path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
  assert.equal(configPath("claude-desktop", "win32", { APPDATA: "R" }, home), path.join("R", "Claude", "claude_desktop_config.json"));
  assert.equal(configPath("claude-desktop", "linux", {}, home), undefined);
  assert.equal(userDataDir("linux", { XDG_DATA_HOME: "D" }, home), path.join("D", "layerbridge"));
});

test("installPlugin copies the plugin and detects a stale copy", async () => {
  const { installPlugin, pluginCopyIsStale } = await load("setup.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "bridge-dist-"));
  try {
    const src = path.join(dir, "src");
    mkdirSync(path.join(src, "dist"), { recursive: true });
    writeFileSync(path.join(src, "manifest.json"), "{}");
    writeFileSync(path.join(src, "dist", "code.js"), "v1");
    writeFileSync(path.join(src, "dist", "index.html"), "<p>");
    const target = path.join(dir, "installed");
    const manifest = installPlugin(src, target);
    assert.equal(manifest, path.join(target, "manifest.json"));
    assert.deepEqual(readdirSync(path.join(target, "dist")).sort(), ["code.js", "index.html"]);
    assert.equal(pluginCopyIsStale(src, target), false);
    writeFileSync(path.join(src, "dist", "code.js"), "v2");
    assert.equal(pluginCopyIsStale(src, target), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── install manifests agree with each other ──────────────────────────────── */

test("server.json, the npm package, the MCPB manifest and the Claude plugin agree", () => {
  const root = path.join(here, "..", "..");
  const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
  const serverJson = readJson("server.json");
  const mcpb = readJson("mcpb/manifest.json");
  const plugin = readJson(".claude-plugin/plugin.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");

  // MCP Registry: https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
  assert.match(serverJson.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.ok(serverJson.description.length <= 100, "server.json description is at most 100 characters");
  assert.ok(serverJson.title.length <= 100);
  assert.equal(serverJson.name, pkg.mcpName, "the registry verifies npm ownership by package.json mcpName");
  const [npm] = serverJson.packages;
  assert.equal(npm.registryType, "npm");
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.transport.type, "stdio");
  for (const v of npm.environmentVariables) assert.ok(["string", "number", "boolean", "filepath"].includes(v.format ?? "string"));
  for (const version of [serverJson.version, npm.version, mcpb.version]) assert.equal(version, pkg.version);

  // MCPB 0.3: required fields, and every env value comes from a declared user_config key
  for (const field of ["name", "version", "description", "author", "server"]) assert.ok(mcpb[field], `mcpb ${field}`);
  assert.equal(mcpb.server.type, "node");
  for (const value of Object.values(mcpb.server.mcp_config.env)) {
    const key = value.match(/^\$\{user_config\.(\w+)\}$/)?.[1];
    assert.ok(key && mcpb.user_config[key], `${value} refers to a declared user_config entry`);
  }

  // Claude Code plugin + marketplace
  assert.match(plugin.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.deepEqual(plugin.mcpServers["layerbridge"].args, ["-y", `${pkg.name}@latest`]);
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.equal(marketplace.plugins[0].source, "./");
});

test("every skill has frontmatter naming its folder and a description", () => {
  const skillsDir = path.join(here, "..", "..", "skills");
  const names = readdirSync(skillsDir);
  assert.ok(names.length >= 6);
  for (const name of names) {
    const text = readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(front, `${name} starts with frontmatter`);
    assert.match(front[1], new RegExp(`^name: ${name}$`, "m"));
    const description = front[1].match(/^description: (.+)$/m)?.[1] ?? "";
    assert.ok(description.length > 40 && description.length <= 1024, `${name} description length`);
  }
});

/* ── MCP prompts, over the SDK's in-memory transport ──────────────────────── */

test("prompts are listed with arguments and render their workflows", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { registerPrompts, nodeTarget } = await load("prompts.js");

  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerPrompts(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ["audit-design", "build-in-figma", "implement-design", "sync-tokens", "troubleshoot"]);
    const build = prompts.find((p) => p.name === "build-in-figma");
    assert.equal(build.arguments.find((a) => a.name === "description").required, true);

    const implement = await client.getPrompt({
      name: "implement-design",
      arguments: { node: "https://www.figma.com/design/abc/x?node-id=12-345", assetsDir: "src/icons" },
    });
    const text = implement.messages[0].content.text;
    assert.match(text, /node 12:345/);
    assert.match(text, /get_code_context/);
    assert.match(text, /export_assets with outputDir "src\/icons"/);
    assert.match(text, /export_tokens/);

    const imported = await client.getPrompt({ name: "sync-tokens", arguments: { direction: "import", path: "tokens.json" } });
    assert.match(imported.messages[0].content.text, /import_tokens/);
    const audit = await client.getPrompt({ name: "audit-design", arguments: {} });
    assert.match(audit.messages[0].content.text, /dryRun: true/);
    const trouble = await client.getPrompt({ name: "troubleshoot", arguments: {} });
    assert.match(trouble.messages[0].content.text, /npx -y layerbridge@latest doctor/);

    assert.match(nodeTarget("4029-12345"), /node 4029:12345/);
    assert.match(nodeTarget(undefined), /current selection/);
  } finally {
    await client.close();
    await server.close();
  }
});

/* ── doctor against a fake leader ─────────────────────────────────────────── */

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const doctorAt = async (port, extra = {}) => {
  const { runDoctor } = await load("doctor.js");
  return runDoctor({ port, anyPort: true, pluginDir: path.join(os.tmpdir(), "no-such-plugin-dir"), bundledDir: undefined, ...extra });
};

const fakeLeader = (files, { version } = {}) => async (req, res) => {
  const { VERSION } = await load("version.js");
  if (req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", version: version ?? VERSION }));
  }
  if (req.url === "/rpc") {
    if (req.headers["x-bridge-token"] !== "secret") {
      res.writeHead(401);
      return res.end("{}");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ data: files }));
  }
  res.writeHead(404);
  res.end();
};

test("doctor: nothing listening", async () => {
  const server = await listen(() => {});
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const checks = await doctorAt(port);
  assert.equal(checks[0].status, "ok"); // node
  assert.equal(checks[1].status, "fail");
  assert.match(checks[1].label, /No bridge server is running/);
  assert.match(checks.at(-1).label, /plugin not installed/);
});

test("doctor: port held by another program", async () => {
  const server = await listen((req, res) => {
    res.writeHead(404);
    res.end();
  });
  try {
    const checks = await doctorAt(server.address().port);
    assert.match(checks[1].label, /not this bridge/);
    assert.equal(checks[1].status, "fail");
  } finally {
    server.close();
  }
});

test("doctor: running, connected, token missing, token wrong, no files, other version", async () => {
  const { formatChecks } = await load("doctor.js");
  const connected = await listen(fakeLeader([{ fileKey: "abc", fileName: "Design" }]));
  const empty = await listen(fakeLeader([], { version: "0.0.1" }));
  try {
    let checks = await doctorAt(connected.address().port, { readTokenFor: () => "secret" });
    assert.deepEqual(checks.slice(0, 3).map((c) => c.status), ["ok", "ok", "ok"]);
    assert.match(checks[2].label, /Connected: Design \(abc\)/);
    assert.match(formatChecks(checks), /^\[ok\]   Node/);

    checks = await doctorAt(connected.address().port, { readTokenFor: () => undefined });
    assert.match(checks[2].label, /No access token/);

    checks = await doctorAt(connected.address().port, { readTokenFor: () => "wrong" });
    assert.match(checks[2].label, /rejected the token/);

    checks = await doctorAt(empty.address().port, { readTokenFor: () => "secret" });
    assert.equal(checks[1].status, "warn");
    assert.match(checks[1].label, /version 0\.0\.1/);
    assert.equal(checks[2].status, "warn");
    assert.match(checks[2].label, /No Figma file is connected/);
    assert.match(formatChecks(checks), /→ In Figma, open the file/);
  } finally {
    connected.close();
    empty.close();
  }
});
