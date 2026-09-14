/*
 * Derived from gethopp/figma-mcp-bridge (https://github.com/gethopp/figma-mcp-bridge), MIT License.
 * Copyright (c) 2026 GETHOPP LTD. Modifications Copyright (c) 2026 Murad Yousuf.
 * See LICENSE.md and NOTICE.md.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { BridgeRequest, BridgeResponse, ConnectedFile } from "./types.js";

/**
 * How long a request may go WITHOUT HEARING FROM THE PLUGIN before it fails.
 * Upstream used a flat 3 minutes from send; a long scan then either timed out
 * while still working or a dead request sat for 3 minutes. The plugin now posts
 * `progress` messages during long work, and each one re-arms this timer.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

/** Close code sent to a plugin window whose file slot a newer window took. */
export const REPLACED_CLOSE_CODE = 4000;

interface PendingRequest {
  type: string;
  resolve: (resp: BridgeResponse) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  idleMs: number;
  ws: WebSocket;
  lastProgress?: string;
}

interface ConnectionEntry {
  ws: WebSocket;
  fileKey: string;
  fileName: string;
  pluginVersion: string;
  editorType?: string;
  client: PluginClient;
  connectedAt: number;
  isAlive: boolean;
}

/** Which plugin and panel opened a connection, as the plugin reports it. */
interface PluginClient {
  pluginId?: string;
  /** The port the panel had selected when it dialled. */
  uiPort?: string;
  /** A new value per panel instance, so reloads are visible. */
  uiSession?: string;
}

export class Bridge {
  private wss: WebSocketServer;
  private connections = new Map<string, ConnectionEntry>();
  private pending = new Map<string, PendingRequest>();
  private counter = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
    this.wss.on("error", (err) => {
      console.error("WebSocketServer error:", err);
    });

    this.pingTimer = setInterval(() => {
      for (const [fileKey, entry] of this.connections) {
        if (!entry.isAlive) {
          entry.ws.terminate();
          this.connections.delete(fileKey);
          console.error(`Plugin dead (no pong): ${entry.fileName} (${fileKey})`);
          continue;
        }
        entry.isAlive = false;
        entry.ws.ping();
      }
    }, 30_000);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (request.url == undefined) {
      console.error("Plugin connected without url, rejecting");
      socket.destroy();
      return;
    }

    const url = new URL(request.url, "http://localhost");
    const {
      fileKey,
      fileName = "Unknown",
      pluginVersion = "unknown",
      editorType,
      pluginId,
      uiPort,
      uiSession,
    } = Object.fromEntries(url.searchParams);

    if (!fileKey) {
      console.error("Plugin connected without fileKey, rejecting");
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.handleConnection(ws, fileKey, fileName, pluginVersion, editorType, { pluginId, uiPort, uiSession });
    });
  }

  private handleConnection(
    ws: WebSocket,
    fileKey: string,
    fileName: string,
    pluginVersion: string,
    editorType: string | undefined,
    client: PluginClient
  ): void {
    const who = [client.pluginId, client.uiSession && `panel ${client.uiSession}`].filter(Boolean).join(", ");
    // A newer window for the same file wins. The close code tells the old
    // window not to reconnect — without it two windows evict each other forever.
    const existing = this.connections.get(fileKey);
    if (existing) {
      existing.ws.close(REPLACED_CLOSE_CODE, "replaced by a newer plugin window for this file");
    }
    this.connections.set(fileKey, {
      ws,
      fileKey,
      fileName,
      pluginVersion,
      editorType,
      client,
      connectedAt: Date.now(),
      isAlive: true,
    });
    console.error(`Plugin connected: ${fileName} (${fileKey}) v${pluginVersion}${who ? ` [${who}]` : ""}`);

    ws.on("pong", () => {
      const entry = this.connections.get(fileKey);
      if (entry && entry.ws === ws) entry.isAlive = true;
    });

    ws.on("message", (data) => {
      let msg: BridgeResponse & { message?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.error("Invalid response from plugin");
        return;
      }
      const entry = this.connections.get(fileKey);
      if (entry && entry.ws === ws) entry.isAlive = true;

      const pending = this.pending.get(msg.requestId);
      if (!pending) return;

      if (msg.type === "progress") {
        pending.lastProgress = msg.message;
        this.arm(msg.requestId, pending);
        return;
      }

      clearTimeout(pending.timeout);
      this.pending.delete(msg.requestId);
      pending.resolve(msg);
    });

    ws.on("close", () => {
      const current = this.connections.get(fileKey);
      if (current?.ws === ws) {
        this.connections.delete(fileKey);
        console.error(`Plugin disconnected: ${fileName} (${fileKey})${who ? ` [${who}]` : ""}`);
      }
      this.rejectPendingForSocket(
        ws,
        `The Figma plugin disconnected (${fileName}) before answering. Re-run the plugin in Figma.`
      );
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
      const current = this.connections.get(fileKey);
      if (current?.ws === ws) {
        this.connections.delete(fileKey);
      }
      this.rejectPendingForSocket(ws, `Plugin connection error (${fileName}): ${err.message}`);
    });
  }

  private arm(requestId: string, pending: PendingRequest): void {
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      this.pending.delete(requestId);
      const last = pending.lastProgress ? ` Last progress: "${pending.lastProgress}".` : "";
      pending.reject(
        new Error(
          `${pending.type}: the Figma plugin went ${Math.round(pending.idleMs / 1000)}s without answering.${last} ` +
            `Run the health tool: if the plugin does not answer it either, re-run the plugin in Figma.`
        )
      );
    }, pending.idleMs);
  }

  private rejectPendingForSocket(ws: WebSocket, reason: string): void {
    for (const [id, p] of this.pending) {
      if (p.ws === ws) {
        clearTimeout(p.timeout);
        this.pending.delete(id);
        p.reject(new Error(reason));
      }
    }
  }

  /**
   * Resolve which connection to use.
   * - If fileKey is provided, use that specific connection.
   * - If only one file is connected and no fileKey given, use it (backward compat).
   * - If multiple files connected and no fileKey, throw with a helpful message.
   */
  private resolveConnection(fileKey?: string): WebSocket {
    if (fileKey) {
      const entry = this.connections.get(fileKey);
      if (!entry) {
        const available = this.listConnectedFiles();
        const hint =
          available.length > 0
            ? ` Connected files: ${available.map((f) => `"${f.fileName}" (fileKey: ${f.fileKey})`).join(", ")}`
            : " No files are currently connected.";
        throw new Error(`No plugin connected for fileKey "${fileKey}".${hint}`);
      }
      return entry.ws;
    }

    if (this.connections.size === 0) {
      throw new Error(
        "No plugin connected. In Figma desktop run Plugins → Development → Layerbridge in the file you want."
      );
    }

    if (this.connections.size === 1) {
      const entry = this.connections.values().next().value!;
      return entry.ws;
    }

    const files = this.listConnectedFiles();
    throw new Error(
      `Multiple files connected. Specify a fileKey to choose which file to query. Connected files: ${files.map((f) => `"${f.fileName}" (fileKey: ${f.fileKey})`).join(", ")}. Use the list_files tool to see all connected files.`
    );
  }

  listConnectedFiles(): ConnectedFile[] {
    return [...this.connections.values()].map((entry) => ({
      fileKey: entry.fileKey,
      fileName: entry.fileName,
      pluginVersion: entry.pluginVersion,
      ...(entry.editorType ? { editorType: entry.editorType } : {}),
      ...(entry.client.pluginId ? { pluginId: entry.client.pluginId } : {}),
      ...(entry.client.uiSession ? { panel: entry.client.uiSession } : {}),
      connectedSecondsAgo: Math.round((Date.now() - entry.connectedAt) / 1000),
    }));
  }

  send(requestType: string, nodeIds?: string[], fileKey?: string): Promise<BridgeResponse> {
    return this.sendWithParams(requestType, nodeIds, undefined, fileKey);
  }

  sendWithParams(
    requestType: string,
    nodeIds?: string[],
    params?: Record<string, unknown>,
    fileKey?: string,
    idleMs: number = DEFAULT_IDLE_TIMEOUT_MS
  ): Promise<BridgeResponse> {
    return new Promise((resolve, reject) => {
      let conn: WebSocket;
      try {
        conn = this.resolveConnection(fileKey);
      } catch (err) {
        reject(err);
        return;
      }

      if (conn.readyState !== WebSocket.OPEN) {
        reject(new Error("Plugin not connected"));
        return;
      }

      const requestId = this.nextId();
      const request: BridgeRequest = {
        type: requestType,
        requestId,
      };
      if (nodeIds && nodeIds.length > 0) {
        request.nodeIds = nodeIds;
      }
      if (params && Object.keys(params).length > 0) {
        request.params = params;
      }

      const pending: PendingRequest = {
        type: requestType,
        resolve,
        reject,
        timeout: setTimeout(() => {}, 0),
        idleMs,
        ws: conn,
      };
      this.pending.set(requestId, pending);
      this.arm(requestId, pending);

      conn.send(JSON.stringify(request), (err) => {
        if (err) {
          clearTimeout(pending.timeout);
          this.pending.delete(requestId);
          reject(err);
        }
      });
    });
  }

  private nextId(): string {
    this.counter++;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return `req-${hh}${mm}${ss}-${this.counter}`;
  }

  close(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    for (const [, { reject, timeout }] of this.pending) {
      clearTimeout(timeout);
      reject(new Error("Bridge closed"));
    }
    this.pending.clear();

    for (const [, entry] of this.connections) {
      entry.ws.close();
    }
    this.connections.clear();
    this.wss.close();
  }
}
