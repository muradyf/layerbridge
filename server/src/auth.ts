/**
 * Local-only access control.
 *
 * The leader listens on 127.0.0.1, so nothing off the machine can reach it —
 * but a web page open in the user's browser can. Two browser attacks matter:
 *
 *  - /rpc: a page can POST a "simple" request (text/plain, no preflight) and
 *    drive Figma without reading the answer — delete_nodes included. So /rpc
 *    requires a JSON content type (which forces a CORS preflight the server
 *    never answers), rejects any request carrying an Origin header, and
 *    requires a token only local processes can read.
 *  - /ws: a page can open a WebSocket to localhost and pretend to be the
 *    plugin. Browsers always send Origin on a WebSocket; the Figma plugin's
 *    iframe sends "null" (or figma.com), so everything else is refused.
 *
 * The token lives in a per-user temp file created with owner-only permissions.
 * Followers (another MCP client's server) and scripts/rpc.mjs read it.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Ports the plugin's manifest allows. Anything else is unreachable from Figma. */
export const ALLOWED_PORTS = [1995, 1996, 1997, 1998, 1999];

export const TOKEN_HEADER = "x-bridge-token";

const tokenDir = () => {
  let user = "user";
  try {
    user = os.userInfo().username.replace(/[^\w.-]/g, "_");
  } catch {
    // no user info in some sandboxes
  }
  return path.join(os.tmpdir(), `layerbridge-${user}`);
};

export const tokenPath = (port: number) => path.join(tokenDir(), `${port}.token`);

export function createToken(port: number): string {
  const token = randomBytes(24).toString("hex");
  mkdirSync(tokenDir(), { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath(port), token, { mode: 0o600 });
  return token;
}

export function readToken(port: number): string | undefined {
  try {
    return readFileSync(tokenPath(port), "utf8").trim();
  } catch {
    return undefined;
  }
}

const PLUGIN_ORIGINS = new Set(["null", "https://www.figma.com", "https://figma.com"]);

/** WebSocket upgrades: no Origin (a native client) or the plugin iframe's. */
export const isAllowedSocketOrigin = (origin: string | undefined) => origin === undefined || PLUGIN_ORIGINS.has(origin);
