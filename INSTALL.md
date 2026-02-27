# Installation Guide

## Requirements

- **Node.js 18+**
- **Cursor IDE**
- (Optional) `ANTHROPIC_API_KEY` — AI summarization
- (Optional) ChromaDB — semantic search (`pip install chromadb`)

## Quick Install

```bash
git clone https://github.com/jsonsang2/memory-assistant.git
cd memory-assistant
node scripts/install.js
```

This single command will:
1. Create `~/.memory-assistant/` data directory
2. Build the Worker service (`worker/dist/server.js`)
3. Build the MCP server (`mcp/dist/index.js`)
4. Register 4 hooks in `~/.cursor/hooks.json`
5. Register MCP server in `~/.cursor/mcp.json`

After install, **restart Cursor**.

## What Gets Installed

### ~/.cursor/hooks.json

4 Cursor hooks are registered (existing hooks from other plugins are preserved):

| Hook | File | Purpose |
|------|------|---------|
| `beforeSubmitPrompt` | `hooks/before-submit-prompt.js` | Start worker, create/resume session, capture user prompt |
| `afterFileEdit` | `hooks/after-file-edit.js` | Record file edits as observations |
| `beforeShellExecution` | `hooks/before-shell-execution.js` | Record shell commands as observations |
| `stop` | `hooks/stop.js` | Generate per-prompt summary at agent turn end |

### ~/.cursor/mcp.json

MCP server `memory-assistant` is registered with 4 tools:
- `search` — keyword/FTS5 search across observations
- `timeline` — context window around a specific observation
- `get_observations` — full detail for specific observation IDs
- `save_memory` — manually save a memory note

## Optional Setup

### AI Summarization

Set your Anthropic API key to enable AI-powered summaries:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Without this, summaries are generated from observation metadata (tool names + file paths).

### Semantic Search (ChromaDB)

```bash
pip install chromadb
```

ChromaDB enables vector-based semantic search in addition to keyword search. It starts automatically when the worker detects it's available.

## Verify Installation

After restarting Cursor, open a new chat and run a few commands. Then check:

```bash
# Worker should be running
curl http://localhost:37888/api/health

# Check sessions were created
curl http://localhost:37888/api/sessions

# Check observations were recorded
curl http://localhost:37888/api/observations?session_id=1
```

## Uninstall

```bash
node scripts/uninstall.js
```

This removes hooks and MCP server entries from `~/.cursor/`. Your data in `~/.memory-assistant/` is preserved. To remove all data:

```bash
rm -rf ~/.memory-assistant
```

## Troubleshooting

### Worker not starting

The worker auto-starts on first prompt. If it doesn't:

```bash
# Start manually
node /path/to/memory-assistant/worker/dist/server.js &

# Check if port is in use
lsof -i :37888
```

### Hooks not firing

1. Verify `~/.cursor/hooks.json` has the 4 hooks registered
2. Restart Cursor completely (not just reload)
3. Check Cursor version supports hooks (Cursor 2.0+)

### Build errors

Rebuild manually:

```bash
cd worker && npm install && npm run build
cd ../mcp && npm install && npm run build
```

### Re-install (idempotent)

Running `node scripts/install.js` again is safe — it removes old entries and re-adds them. Existing hooks/MCP servers from other plugins are preserved.
