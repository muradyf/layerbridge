/*
 * Derived from gethopp/figma-mcp-bridge (https://github.com/gethopp/figma-mcp-bridge), MIT License.
 * Copyright (c) 2026 GETHOPP LTD. Modifications Copyright (c) 2026 Murad Yousuf.
 * See LICENSE.md and NOTICE.md.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

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
  editorType?: string;
};

type Phase = "waiting" | "connecting" | "connected" | "disconnected" | "replaced";

type Activity = { text: string; tone: "idle" | "busy" | "error" };

// `||` (not `??`) so an empty build-time value falls back to the default.
// A custom endpoint must also be listed in manifest.json's
// networkAccess.allowedDomains or Figma will block the connection.
/** Must match the manifest's allowedDomains and the server's FIGMA_BRIDGE_PORT. */
const PORTS = [1995, 1996, 1997, 1998, 1999];
const DEFAULT_PORT = 1995;
const wsUrl = (port: number) => import.meta.env.VITE_FIGMA_BRIDGE_WS || `ws://localhost:${port}/ws`;

/** Close code the server uses when a newer plugin window took this file's slot. */
const REPLACED_CODE = 4000;

const PHASE_LABEL: Record<Phase, string> = {
  waiting: "Waiting for Figma…",
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Server not running",
  replaced: "Taken over",
};

const post = (pluginMessage: Record<string, unknown>) => parent.postMessage({ pluginMessage }, "*");

const Chevron = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Glyph = ({ error }: { error: boolean }) => (
  <svg className="glyph" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    {error ? (
      <>
        <circle cx="6" cy="6" r="5" stroke="currentColor" />
        <path d="M6 3.5v3M6 8.25v.25" stroke="currentColor" strokeLinecap="round" />
      </>
    ) : (
      <circle cx="6" cy="6" r="5" stroke="currentColor" />
    )}
  </svg>
);

export default function App() {
  const [phase, setPhase] = useState<Phase>("waiting");
  const [collapsed, setCollapsed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [port, setPort] = useState(DEFAULT_PORT);
  const [status, setStatus] = useState<PluginStatus>({
    fileName: "",
    fileKey: "",
    selectionCount: 0,
  });
  const [activity, setActivity] = useState<Activity>({ text: "Idle", tone: "idle" });
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const inFlight = useRef(new Map<string, string>());
  const panelRef = useRef<HTMLDivElement | null>(null);

  const refreshActivity = () => {
    const pending = [...inFlight.current.values()];
    if (pending.length === 0) {
      setActivity((prev) => (prev.tone === "error" ? prev : { text: "Idle", tone: "idle" }));
    } else {
      setActivity({ text: pending[pending.length - 1], tone: "busy" });
    }
  };

  // Size the plugin window to the content instead of a hard-coded height.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const report = () => post({ type: "ui-height", height: Math.ceil(panel.getBoundingClientRect().height) });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data?.pluginMessage;
      if (!msg) return;

      if (msg.type === "plugin-status") {
        setStatus(msg.payload);
        return;
      }

      if (msg.type === "bridge-port") {
        if (PORTS.includes(msg.port)) setPort(msg.port);
        return;
      }

      if (msg.type === "ui-collapse-state") {
        setCollapsed(msg.payload?.collapsed === true);
        return;
      }

      if (!("requestId" in msg)) return;

      if (msg.type === "progress") {
        inFlight.current.set(msg.requestId, msg.message);
      } else {
        inFlight.current.delete(msg.requestId);
        if (msg.error) setActivity({ text: msg.error, tone: "error" });
      }
      refreshActivity();

      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify(msg));
      }
    };

    window.addEventListener("message", handleMessage);
    // The main thread's first status message can arrive before this listener
    // exists — upstream then sat on "Unknown file" until the selection changed.
    // Ask for both status and collapse state once we are listening.
    post({ type: "request-ui-state" });
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((previous) => {
      const next = !previous;
      post({ type: "set-ui-collapsed", collapsed: next });
      return next;
    });
  };

  useEffect(() => {
    if (!status.fileKey) return;

    let disposed = false;

    const connect = () => {
      if (disposed) return;

      if (socketRef.current) {
        const previous = socketRef.current;
        previous.onopen = previous.onclose = previous.onerror = previous.onmessage = null;
        previous.close();
      }

      setPhase((p) => (p === "connected" ? p : "connecting"));
      const query = new URLSearchParams({
        fileKey: status.fileKey,
        fileName: status.fileName,
        pluginVersion: status.pluginVersion ?? "unknown",
        editorType: status.editorType ?? "unknown",
      });
      const ws = new WebSocket(`${wsUrl(port)}?${query.toString()}`);
      socketRef.current = ws;

      ws.onopen = () => {
        setPhase("connected");
        post({ type: "ui-ready" });
      };

      ws.onclose = (event) => {
        if (disposed || socketRef.current !== ws) return;
        inFlight.current.clear();
        refreshActivity();
        // Reconnecting after being replaced is what made two plugin windows
        // evict each other forever. Stay down until asked.
        if (event.code === REPLACED_CODE) {
          setPhase("replaced");
          return;
        }
        setPhase("disconnected");
        if (reconnectTimer.current === null) {
          reconnectTimer.current = window.setTimeout(() => {
            reconnectTimer.current = null;
            connect();
          }, 1500);
        }
      };

      ws.onerror = () => {
        if (disposed || socketRef.current !== ws) return;
        setPhase("disconnected");
      };

      ws.onmessage = (event) => {
        if (disposed || socketRef.current !== ws) return;
        let payload: ServerRequest;
        try {
          payload = JSON.parse(event.data) as ServerRequest;
        } catch {
          return;
        }
        inFlight.current.set(payload.requestId, payload.type.replace(/_/g, " "));
        refreshActivity();
        post({ type: "server-request", payload });
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer.current !== null) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      const ws = socketRef.current;
      if (ws) {
        ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
        ws.close();
        socketRef.current = null;
      }
    };
  }, [status.fileKey, status.fileName, status.pluginVersion, status.editorType, attempt, port]);

  const selection =
    status.selectionCount === 1 ? "1 layer" : `${status.selectionCount} layers`;

  return (
    <div ref={panelRef} className={`panel ${collapsed ? "collapsed" : ""}`}>
      <div className="header">
        <div className="status" title={PHASE_LABEL[phase]}>
          <span className={`dot ${phase}`} />
          <span className="status-label">{PHASE_LABEL[phase]}</span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={toggleCollapsed}
          title={collapsed ? "Expand" : "Collapse"}
          aria-label={collapsed ? "Expand" : "Collapse"}
          aria-expanded={!collapsed}
        >
          <Chevron />
        </button>
      </div>

      <div className="section">
        <div className="row">
          <span className="row-label">File</span>
          <span className={`row-value ${status.fileName ? "" : "muted"}`} title={status.fileName}>
            {status.fileName || "—"}
          </span>
        </div>
        <div className="row">
          <span className="row-label">Page</span>
          <span className={`row-value ${status.pageName ? "" : "muted"}`} title={status.pageName}>
            {status.pageName || "—"}
          </span>
        </div>
        <div className="row">
          <span className="row-label">Selection</span>
          <span className="row-value">{selection}</span>
        </div>
        <div className="row">
          <span className="row-label">Port</span>
          <select
            className="select"
            value={port}
            aria-label="Server port"
            onChange={(e) => {
              const next = Number(e.target.value);
              setPort(next);
              post({ type: "set-bridge-port", port: next });
            }}
          >
            {PORTS.map((p) => (
              <option key={p} value={p}>
                localhost:{p}
              </option>
            ))}
          </select>
          <span className="row-value muted version-inline">{status.pluginVersion ?? ""}</span>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Activity</div>
        {phase === "replaced" ? (
          <div className="notice">
            <span className="notice-text">Another plugin window took over this file.</span>
            <button
              type="button"
              className="button"
              onClick={() => {
                setPhase("connecting");
                setAttempt((n) => n + 1);
              }}
            >
              Reconnect
            </button>
          </div>
        ) : (
          <div className={`activity ${activity.tone}`}>
            {activity.tone === "busy" ? <span className="spinner" /> : <Glyph error={activity.tone === "error"} />}
            <span className="activity-text" title={activity.text}>
              {activity.text}
            </span>
            {activity.tone === "error" && (
              <button
                type="button"
                className="button"
                onClick={() => setActivity({ text: "Idle", tone: "idle" })}
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
