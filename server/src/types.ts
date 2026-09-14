/*
 * Derived from gethopp/figma-mcp-bridge (https://github.com/gethopp/figma-mcp-bridge), MIT License.
 * Copyright (c) 2026 GETHOPP LTD. Modifications Copyright (c) 2026 Murad Yousuf.
 * See LICENSE.md and NOTICE.md.
 */
export interface BridgeRequest {
  type: string;
  requestId: string;
  nodeIds?: string[];
  params?: Record<string, unknown>;
}

export interface BridgeResponse {
  type: string;
  requestId: string;
  data?: unknown;
  error?: string;
}

export interface RPCRequest {
  tool: string;
  nodeIds?: string[];
  params?: Record<string, unknown>;
  fileKey?: string;
  /** How long the leader may wait without hearing from the plugin. */
  idleMs?: number;
}

export interface RPCResponse {
  data?: unknown;
  error?: string;
}

export interface ConnectedFile {
  fileKey: string;
  fileName: string;
  pluginVersion?: string;
  /** Which Figma editor the plugin runs in: figma, dev, figjam or slides. */
  editorType?: string;
  /** Which plugin opened the connection (the design and FigJam/Slides manifests share code). */
  pluginId?: string;
  /** The plugin panel instance; it changes when Figma reloads the plugin. */
  panel?: string;
  connectedSecondsAgo?: number;
}

export enum Role {
  Unknown = 0,
  Leader = 1,
  Follower = 2,
}
