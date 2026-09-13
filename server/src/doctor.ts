/**
 * `doctor`: checks the pieces a working bridge needs, in the order they fail,
 * and says what to do about each. It only talks to 127.0.0.1 on the one port
 * it is given, and only reads the token file the leader wrote there.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { ALLOWED_PORTS, TOKEN_HEADER, readToken, tokenPath } from "./auth.js";
import { PLUGIN_MENU_NAME } from "./brand.js";
import { bundledPluginDir, pluginCopyIsStale, stablePluginDir } from "./setup.js";
import { VERSION } from "./version.js";

export type Check = { status: "ok" | "warn" | "fail"; label: string; hint?: string };

export type DoctorOptions = {
  port: number;
  host?: string;
  nodeVersion?: string;
  timeoutMs?: number;
  /** Where the plugin copy lives and where the bundled one is; tests override. */
  pluginDir?: string;
  bundledDir?: string | undefined;
  /** Skip the port-range check (tests run a fake leader on a free port). */
  anyPort?: boolean;
  readTokenFor?: (port: number) => string | undefined;
};

const errorCode = (err: unknown): string | undefined =>
  (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;

export async function runDoctor(opts: DoctorOptions): Promise<Check[]> {
  const { port, host = "127.0.0.1", timeoutMs = 2_000 } = opts;
  const checks: Check[] = [];

  const major = Number((opts.nodeVersion ?? process.versions.node).split(".")[0]);
  checks.push(
    major >= 20
      ? { status: "ok", label: `Node ${opts.nodeVersion ?? process.versions.node}` }
      : { status: "fail", label: `Node ${opts.nodeVersion ?? process.versions.node} is too old`, hint: "Install Node 20 or newer (nodejs.org)." }
  );

  if (!opts.anyPort && !ALLOWED_PORTS.includes(port)) {
    checks.push({
      status: "fail",
      label: `Port ${port} is outside ${ALLOWED_PORTS[0]}–${ALLOWED_PORTS[ALLOWED_PORTS.length - 1]}`,
      hint: "The Figma plugin can only reach those ports. Set FIGMA_BRIDGE_PORT to one of them.",
    });
    checks.push(pluginCheck(opts));
    return checks;
  }

  const base = `http://${host}:${port}`;
  let ping: { status?: string; version?: string } | undefined;
  try {
    const res = await fetch(`${base}/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    ping = res.ok ? ((await res.json().catch(() => undefined)) as typeof ping) : undefined;
    if (ping?.status !== "ok") ping = undefined;
    if (!ping) {
      checks.push({
        status: "fail",
        label: `Port ${port} is used by a program that is not this bridge`,
        hint: `Pick a free port from ${ALLOWED_PORTS.join(", ")}: set FIGMA_BRIDGE_PORT in your AI tool's config and choose the same Port in the plugin panel.`,
      });
    }
  } catch (err) {
    const code = errorCode(err);
    checks.push(
      code === "ECONNREFUSED"
        ? {
            status: "fail",
            label: `No bridge server is running on ${host}:${port}`,
            hint: "Your AI tool starts the server: restart it (or check its MCP settings list this server). If you changed FIGMA_BRIDGE_PORT, run doctor with --port.",
          }
        : {
            status: "fail",
            label: `Could not reach ${host}:${port} (${code ?? (err instanceof Error ? err.message : String(err))})`,
            hint: "Another program may hold the port. Pick a different port in both FIGMA_BRIDGE_PORT and the plugin panel.",
          }
    );
  }

  if (ping) {
    checks.push(
      ping.version === VERSION
        ? { status: "ok", label: `Bridge server ${ping.version} is running on ${host}:${port}` }
        : {
            status: "warn",
            label: `Bridge server on ${host}:${port} is version ${ping.version}; this CLI is ${VERSION}`,
            hint: "Restart every AI tool using the bridge so they all run the same version, then run setup again to update the Figma plugin.",
          }
    );

    const token = (opts.readTokenFor ?? readToken)(port);
    if (!token) {
      checks.push({
        status: "fail",
        label: `No access token at ${tokenPath(port)}`,
        hint: "The server was started by a different OS user, or the temp folder was cleaned. Restart your AI tool.",
      });
    } else {
      checks.push(await filesCheck(base, token, timeoutMs));
    }
  }

  checks.push(pluginCheck(opts));
  return checks;
}

async function filesCheck(base: string, token: string, timeoutMs: number): Promise<Check> {
  try {
    const res = await fetch(`${base}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [TOKEN_HEADER]: token },
      body: JSON.stringify({ tool: "list_files" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) {
      return { status: "fail", label: "The server rejected the token", hint: "Restart your AI tool so the server writes a fresh token." };
    }
    const body = (await res.json()) as { data?: Array<{ fileKey?: string; fileName?: string }>; error?: string };
    if (!res.ok || body.error) return { status: "fail", label: `list_files failed: ${body.error ?? res.status}` };
    const files = body.data ?? [];
    if (files.length === 0) {
      return {
        status: "warn",
        label: "No Figma file is connected",
        hint: `In Figma, open the file and run Plugins → Development → ${PLUGIN_MENU_NAME}; keep its window open (it can be collapsed). The Port in the panel must match. In a browser, allow Chrome's local network access prompt, or use Figma desktop.`,
      };
    }
    return { status: "ok", label: `Connected: ${files.map((f) => `${f.fileName ?? "?"} (${f.fileKey ?? "?"})`).join(", ")}` };
  } catch (err) {
    return { status: "fail", label: `list_files failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function pluginCheck(opts: DoctorOptions): Check {
  const dir = opts.pluginDir ?? stablePluginDir();
  const bundled = "bundledDir" in opts ? opts.bundledDir : bundledPluginDir();
  const manifest = path.join(dir, "manifest.json");
  if (!existsSync(manifest)) {
    return {
      status: "warn",
      label: `Figma plugin not installed at ${dir}`,
      hint: "Run setup, then in Figma desktop: Plugins → Development → Import plugin from manifest… and choose the path it prints. (Skip if you imported the plugin from a repo checkout.)",
    };
  }
  if (bundled && pluginCopyIsStale(bundled, dir)) {
    return {
      status: "warn",
      label: "The installed Figma plugin differs from this version's",
      hint: "Run setup again to update it, then close and re-run the plugin in Figma.",
    };
  }
  return { status: "ok", label: `Figma plugin installed: ${manifest}` };
}

export function formatChecks(checks: Check[]): string {
  const tag = { ok: "[ok]  ", warn: "[warn]", fail: "[fail]" } as const;
  return checks
    .map((c) => `${tag[c.status]} ${c.label}${c.hint ? `\n       → ${c.hint}` : ""}`)
    .join("\n");
}
