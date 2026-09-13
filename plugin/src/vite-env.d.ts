/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the WebSocket the plugin panel dials, e.g. ws://localhost:1995/ws. */
  readonly VITE_FIGMA_BRIDGE_WS?: string;
}
