/*
 * Derived from gethopp/figma-mcp-bridge (https://github.com/gethopp/figma-mcp-bridge), MIT License.
 * Copyright (c) 2026 GETHOPP LTD. Modifications Copyright (c) 2026 Murad Yousuf.
 * See LICENSE.md and NOTICE.md.
 */
import http from "node:http";
import type { Duplex } from "node:stream";
import { Bridge } from "./bridge.js";
import { validateRpc } from "./schema.js";
import { validateFeatureRpc } from "./features.js";
import { TOKEN_HEADER, createToken, isAllowedSocketOrigin, tokenPath } from "./auth.js";
import { SERVER_SIDE_TOOLS, runServerSideTool } from "./assets.js";
import type { RPCRequest, RPCResponse } from "./types.js";
import { VERSION } from "./version.js";

/**
 * Leader owns the WebSocket bridge to Figma and exposes HTTP endpoints for followers.
 * Endpoints:
 *   /ws   — WebSocket upgrade for the Figma plugin
 *   /ping — Health check
 *   /rpc  — JSON RPC for follower tool calls
 */
export class Leader {
  private bridge: Bridge;
  private server: http.Server | null = null;
  private token: string | null = null;

  constructor(private port: number) {
    this.bridge = new Bridge();
  }

  getBridge(): Bridge {
    return this.bridge;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.url === "/ping" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", version: VERSION }));
          return;
        }

        if (req.url === "/rpc" && req.method === "POST") {
          this.handleRPC(req, res);
          return;
        }

        res.writeHead(404);
        res.end("Not found");
      });

      server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
        const pathname = new URL(req.url ?? "", "http://localhost").pathname;
        if (pathname === "/ws") {
          if (!isAllowedSocketOrigin(req.headers.origin)) {
            console.error(`Refused a WebSocket from origin ${req.headers.origin}`);
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
          }
          this.bridge.handleUpgrade(req, socket, head);
        } else {
          socket.destroy();
        }
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${this.port} already in use`));
        } else {
          console.error("Leader HTTP server error:", err);
          if (!this.server) reject(err);
        }
      });

      // Loopback only — the plugin and followers are all on this machine.
      server.listen(this.port, "127.0.0.1", () => {
        this.server = server;
        this.token = createToken(this.port);
        console.error(`Leader listening on 127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  private handleRPC(req: http.IncomingMessage, res: http.ServerResponse): void {
    // See auth.ts: browsers send Origin, only JSON forces a preflight, and only
    // local processes can read the token file.
    if (req.headers.origin !== undefined) {
      this.sendJSON(res, 403, { error: "Browser requests are not accepted" });
      req.resume();
      return;
    }
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      this.sendJSON(res, 415, { error: "Content-Type must be application/json" });
      req.resume();
      return;
    }
    if (!this.token || req.headers[TOKEN_HEADER] !== this.token) {
      this.sendJSON(res, 401, { error: `Missing or wrong ${TOKEN_HEADER}; read it from ${tokenPath(this.port)}` });
      req.resume();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        const rpcReq: RPCRequest = JSON.parse(body);

        if (rpcReq.tool === "list_files") {
          this.sendJSON(res, 200, {
            data: this.bridge.listConnectedFiles(),
          });
          return;
        }

        // Feature tools keep their ids inside params; the legacy validator
        // would strip a `nodeId` param, so they validate separately.
        const validation =
          validateFeatureRpc(rpcReq.tool, rpcReq.params) ??
          validateRpc(rpcReq.tool, rpcReq.nodeIds, rpcReq.params);
        if (validation.error) {
          this.sendJSON(res, 400, { error: validation.error });
          return;
        }

        // Forward the schema's output, not the caller's raw object: schemas may
        // normalise input (e.g. the create_* field aliases), and the plugin only
        // understands the canonical spelling.
        const validatedParams = validation.params ?? rpcReq.params;
        const fileKey = rpcReq.fileKey;

        if (SERVER_SIDE_TOOLS.has(rpcReq.tool)) {
          const sender = {
            sendWithParams: (
              requestType: string,
              nodeIds?: string[],
              sendParams?: Record<string, unknown>,
              idleMs?: number
            ) => this.bridge.sendWithParams(requestType, nodeIds, sendParams, fileKey, idleMs),
          };
          const result = await runServerSideTool(rpcReq.tool, sender, validatedParams ?? {});
          this.sendJSON(res, 200, { data: result });
          return;
        }

        const resp = await this.bridge.sendWithParams(
          rpcReq.tool,
          rpcReq.nodeIds,
          validatedParams,
          fileKey,
          rpcReq.idleMs
        );

        this.sendJSON(res, 200, resp.error ? { error: resp.error } : { data: resp.data });
      } catch (err) {
        this.sendJSON(res, 200, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  private sendJSON(res: http.ServerResponse, status: number, body: RPCResponse): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  stop(): void {
    this.bridge.close();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
