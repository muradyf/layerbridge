import React, { useEffect, useRef, useState } from "react";

type ServerRequest = {
  type: string;
  requestId: string;
  nodeIds?: string[];
  params?: Record<string, unknown>;
};

type PluginStatus = {
  fileName: string;
  fileKey: string;
  selectionCount: number;
  pageName?: string;
  pluginVersion?: string;
};

type Activity = { text: string; tone: "idle" | "busy" | "error" };

// `||` (not `??`) so an empty build-time value falls back to the default.
// A custom endpoint must also be listed in manifest.json's
// networkAccess.allowedDomains or Figma will block the connection.
const WS_BASE_URL = import.meta.env.VITE_FIGMA_BRIDGE_WS || "ws://localhost:1995/ws";

/** Close code the server uses when a newer plugin window took this file's slot. */
const REPLACED_CODE = 4000;

export default function App() {
  const [connected, setConnected] = useState(false);
  const [replaced, setReplaced] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<PluginStatus>({
    fileName: "Unknown file",
    fileKey: "",
    selectionCount: 0,
  });
  const [activity, setActivity] = useState<Activity>({ text: "Idle", tone: "idle" });
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const inFlight = useRef(new Map<string, string>());

  const statusLabel = connected
    ? "Connected"
    : replaced
      ? "Taken over by another window"
      : "Disconnected";

  const statusBadge = (
    <div className={`badge ${connected ? "connected" : "disconnected"}`}>
      <span className="dot" />
      <span className="badge-text">{statusLabel}</span>
    </div>
  );

  const refreshActivity = () => {
    const pending = [...inFlight.current.values()];
    if (pending.length === 0) {
      setActivity((prev) => (prev.tone === "error" ? prev : { text: "Idle", tone: "idle" }));
    } else {
      setActivity({ text: pending[pending.length - 1], tone: "busy" });
    }
  };

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data?.pluginMessage;
      if (!msg) return;

      if (msg.type === "plugin-status") {
        setStatus(msg.payload);
        return;
      }

      if (msg.type === "ui-collapse-state") {
        setCollapsed(msg.payload?.collapsed === true);
        return;
      }

      if (!("requestId" in msg)) {
        return;
      }

      if (msg.type === "progress") {
        inFlight.current.set(msg.requestId, msg.message);
        refreshActivity();
      } else {
        inFlight.current.delete(msg.requestId);
        if (msg.error) {
          setActivity({ text: `${msg.type}: ${msg.error}`, tone: "error" });
        }
        refreshActivity();
      }

      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
        return;
      }
      socketRef.current.send(JSON.stringify(msg));
    };

    window.addEventListener("message", handleMessage);
    parent.postMessage({ pluginMessage: { type: "request-ui-state" } }, "*");
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((previous) => {
      const next = !previous;
      parent.postMessage({ pluginMessage: { type: "set-ui-collapsed", collapsed: next } }, "*");
      return next;
    });
  };

  useEffect(() => {
    if (!status.fileKey) return;

    let disposed = false;

    const connect = () => {
      if (disposed) return;

      if (socketRef.current) {
        const previousSocket = socketRef.current;
        previousSocket.onopen = null;
        previousSocket.onclose = null;
        previousSocket.onerror = null;
        previousSocket.onmessage = null;
        previousSocket.close();
      }

      const query = new URLSearchParams({
        fileKey: status.fileKey,
        fileName: status.fileName,
        pluginVersion: status.pluginVersion ?? "unknown",
      });
      const ws = new WebSocket(`${WS_BASE_URL}?${query.toString()}`);
      socketRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setReplaced(false);
        parent.postMessage({ pluginMessage: { type: "ui-ready" } }, "*");
      };

      ws.onclose = (event) => {
        if (disposed || socketRef.current !== ws) return;
        setConnected(false);
        inFlight.current.clear();
        refreshActivity();
        // Reconnecting after being replaced is what made two plugin windows
        // evict each other forever. Stay down until asked.
        if (event.code === REPLACED_CODE) {
          setReplaced(true);
          return;
        }
        if (reconnectTimer.current === null) {
          reconnectTimer.current = window.setTimeout(() => {
            reconnectTimer.current = null;
            connect();
          }, 1500);
        }
      };

      ws.onerror = () => {
        if (disposed || socketRef.current !== ws) return;
        setConnected(false);
      };

      ws.onmessage = (event) => {
        if (disposed || socketRef.current !== ws) return;
        let payload: ServerRequest;
        try {
          payload = JSON.parse(event.data) as ServerRequest;
        } catch {
          return;
        }
        inFlight.current.set(payload.requestId, payload.type);
        refreshActivity();
        parent.postMessage({ pluginMessage: { type: "server-request", payload } }, "*");
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer.current !== null) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (socketRef.current) {
        const ws = socketRef.current;
        ws.onopen = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
        socketRef.current = null;
      }
    };
  }, [status.fileKey, status.fileName, status.pluginVersion, attempt]);

  return (
    <div className={`container ${collapsed ? "collapsed" : ""}`}>
      {collapsed && <div className="titlebar">{statusBadge}</div>}

      <button
        type="button"
        className="collapse-toggle"
        onClick={toggleCollapsed}
        title={collapsed ? "Restore" : "Minimize"}
        aria-label={collapsed ? "Restore" : "Minimize"}
        aria-expanded={!collapsed}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M1 3.5 L5 7 L9 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div className="body">
        <div className="info-section">
          <div className="info-row">
            <span className="info-label">File:</span>
            <span className="info-value">{status.fileName}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Page:</span>
            <span className="info-value">{status.pageName ?? "—"}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Selection:</span>
            <span className="info-value">{status.selectionCount} node(s)</span>
          </div>
          <div className="info-row">
            <span className="info-label">Activity:</span>
            <span className={`info-value activity ${activity.tone}`}>{activity.text}</span>
          </div>
        </div>

        <div className="footer">
          {statusBadge}
          {replaced ? (
            <button
              type="button"
              className="reconnect"
              onClick={() => {
                setReplaced(false);
                setAttempt((n) => n + 1);
              }}
            >
              Reconnect here
            </button>
          ) : (
            <span className="version">{status.pluginVersion ?? ""}</span>
          )}
        </div>
      </div>
    </div>
  );
}
