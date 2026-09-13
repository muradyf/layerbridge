---
name: troubleshoot-bridge
description: Diagnose the Figma bridge when its tools fail, time out or see no file — plugin not connected, wrong port, Chrome local network access prompt, Dev Mode read-only, "Taken over" windows, several files connected, stuck exports. Use when a Figma bridge tool errors or the user says Figma is not connecting.
---

# Troubleshoot the Figma bridge

How it fits together: the AI tool starts the MCP server → the server listens on `127.0.0.1` port 1995 (1995–1999) → the Figma plugin, open in a file, connects to it over a WebSocket. Every tool call needs all three.

## Start with `health`

It returns the server version, role (leader/follower), port, working directory, connected files, and a live test export from the plugin. Pass `nodeId` to test a specific node.

## Symptoms

| What you see | Cause and fix |
|---|---|
| `files` is empty / "no file connected" | The plugin is not running in that file. In Figma: open the file → Plugins → Development → the bridge plugin. Keep its window open (it can be collapsed). |
| Panel shows "Server not running" | The AI tool has not started the server, or the ports differ. Restart the AI tool; make the panel's **Port** match `FIGMA_BRIDGE_PORT` (default 1995). |
| Panel shows "Taken over" | The same file opened the plugin in another window, which now holds the connection. Close one of them. |
| Figma in a browser never connects | Chrome asks before a page can reach `localhost` (Local Network Access). Allow the prompt, or use Figma desktop. |
| "Dev Mode is read-only" | Editing tools need the design editor. Reads, exports, annotations and dev resources work in Dev Mode. |
| "several files are connected" / wrong file | Call `list_files` and pass `fileKey`. |
| An export times out but `health`'s test export works | That node is the problem (very large, hidden, heavy effects). Try a smaller node, lower `scale`, or `clip: true`. The error names the node that stalled. |
| "outside the allowed directories" | Writes are limited to the server's working directory and `FIGMA_BRIDGE_OUTPUT_ROOTS`. Add the folder to that variable. |
| Tools missing after an update | Restart the AI tool, re-run setup (it refreshes the plugin copy), close and re-run the plugin. |
| REST tools missing | They register only when `FIGMA_ACCESS_TOKEN` is set. |

## From a terminal

- `npx -y figma-bridge-ours@latest doctor` checks Node, whether the port is held by the bridge or another program, the access token, connected files, and whether the installed Figma plugin copy matches the server. Add `--port 1996` for another port.
- `npx -y figma-bridge-ours@latest setup` prints the plugin manifest path and client config again.

Several AI-tool windows can share one connection: the first server is the leader and the others forward to it. If the leader's tool is closed, another takes over within a few seconds.

Report what you found and the single next step for the user.
