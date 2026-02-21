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

상세 아키텍처(훅·Worker·DB·MCP·데이터 흐름)는 **[ARCHITECTURE.md](./ARCHITECTURE.md)** 를 참고하세요.

## Installation

### Prerequisites

- Node.js 18+
- Cursor IDE
- (선택) Anthropic API key — AI 요약 활성화 시 필요
- (선택) ChromaDB — semantic search 활성화 시 필요

### Steps

1. Clone or download this repository
2. Build the worker and MCP server:
   ```bash
   cd worker && npm install && npm run build
   cd ../mcp && npm install && npm run build
   ```
3. `hooks/hooks.json`을 참고하여 `~/.cursor/hooks.json`에 훅 등록 (`PLUGIN_PATH`를 실제 경로로 교체)
4. (선택) AI 요약 활성화:
   ```bash
   export ANTHROPIC_API_KEY=your_key_here
   ```
5. Cursor 재시작 — Worker와 ChromaDB는 첫 프롬프트 전송 시 자동 기동됩니다

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (선택) | Claude API key — AI 요약 활성화 |
| `MEMORY_ASSISTANT_PORT` | 37888 | Worker HTTP port |
| `MEMORY_ASSISTANT_DB` | `~/.memory-assistant/memory-assistant.db` | SQLite database path |

## Usage

### Automatic (happens in background)

- 파일 편집/셸 명령이 `afterFileEdit`/`beforeShellExecution` 훅으로 자동 기록
- 사용자 프롬프트가 `beforeSubmitPrompt` 훅으로 캡처
- Agent 턴 종료 시 `stop` 훅이 프롬프트 요약 생성 (AI 요약은 `ANTHROPIC_API_KEY` 설정 시 활성화)

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

## Action Items

- [ ] **AI 요약 품질 개선**: 현재 `ai_summary`가 `[Edit] {"file_path":"..."}` 형태의 단순 포맷으로 저장되어 ChromaDB semantic search 정밀도가 낮음. `ANTHROPIC_API_KEY` 없이도 observation의 맥락을 풍부하게 요약하는 방안 필요 (예: tool_input에서 파일명·편집 내용을 자연어로 변환하는 로직 추가)
- [ ] **Cursor 컨텍스트 자동 주입**: Cursor의 `beforeSubmitPrompt`는 stdout을 무시하므로 Claude Code의 `sessionStart`처럼 이전 세션 컨텍스트를 자동 주입할 수 없음. 대안 필요 (예: MCP tool 자동 호출, Rules 파일 활용 등)

## License

MIT
