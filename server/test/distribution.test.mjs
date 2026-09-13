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
  assert.match(r.stdout, /claude mcp add --transport stdio --scope user figma-bridge -- npx -y figma-bridge-ours@latest/);
  assert.match(r.stdout, /Import plugin from manifest/);
});

test("setup --client and --port narrow and adjust the output", () => {
  const r = cli("setup", "--no-copy", "--client", "codex", "--port", "1997");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Cursor/);
  assert.match(r.stdout, /\[mcp_servers\.figma-bridge\.env\]\n +FIGMA_BRIDGE_PORT = "1997"/);
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
    assert.match(r.stdout, /\+     "figma-bridge": \{/);
    assert.match(r.stderr, /--yes/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).mcpServers["figma-bridge"], undefined);

    r = run("--yes");
    assert.equal(r.status, 0, r.stderr);
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written.mcpServers.other.command, "x");
    assert.equal(written.mcpServers["figma-bridge"].command, "npx");
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
  assert.deepEqual(parsed.mcpServers["figma-bridge"], { command: "npx", args: ["-y", "figma-bridge-ours@latest"] });

  assert.equal(mergeServerConfig(after, serverEntry()).changed, false);
  assert.deepEqual(JSON.parse(mergeServerConfig(undefined, serverEntry(1996)).after).mcpServers["figma-bridge"].env, { FIGMA_BRIDGE_PORT: "1996" });
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
  assert.equal(userDataDir("linux", { XDG_DATA_HOME: "D" }, home), path.join("D", "figma-bridge"));
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
