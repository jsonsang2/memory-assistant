# memory-assistant

Persistent memory across AI IDE sessions. Captures tool use, summarizes sessions, and injects context into new conversations.

## What It Does

- **Captures**: Every tool use (file reads, edits, shell commands) is recorded automatically
- **Summarizes**: At session end, AI generates structured summaries of what was done
- **Remembers**: Next session starts with context from your recent work on the same project
- **Searches**: Query your history with `/mem-search` or via MCP tools

## Architecture

```
Cursor Hooks → Worker Service (Express + SQLite) → AI Summarizer (Claude)
                      ↓
               MCP Server → mem-search skill
```

## Installation

### Prerequisites

- Node.js 18+
- Cursor IDE
- Anthropic API key (for AI summarization)

### Steps

1. Clone or download this repository
2. Build the worker and MCP server:
   ```bash
   cd worker && npm install && npm run build
   cd ../mcp && npm install && npm run build
   ```
3. Install hooks:
   ```bash
   node scripts/install.js
   ```
4. Set your API key:
   ```bash
   export ANTHROPIC_API_KEY=your_key_here
   ```
5. Restart Cursor

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Claude SDK authentication |
| `MEMORY_ASSISTANT_PORT` | 37888 | Worker HTTP port |
| `MEMORY_ASSISTANT_DB` | `~/.memory-assistant/memory-assistant.db` | SQLite database path |

## Usage

### Automatic (happens in background)

- Tool use is captured automatically via `postToolUse` hook
- Previous session context is injected at session start
- AI summary is generated when you stop working

### Manual Search

In Cursor, use the MCP tools via chat:
- `search("authentication bug")` - search history
- `timeline(anchor_id=42)` - see context around a finding
- `get_observations([41, 42, 43])` - full details

## Data Location

- Database: `~/.memory-assistant/memory-assistant.db`
- Worker PID: `~/.memory-assistant/worker.pid`
- Current session: `~/.memory-assistant/current-session.json`

## Extending to Other Editors

The Worker Service and MCP server are editor-agnostic. To add support for another editor:
1. Implement the equivalent hooks for that editor
2. Map hook events to the Worker HTTP API
3. Register `editor` name in session creation

## License

MIT
