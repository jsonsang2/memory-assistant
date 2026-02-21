# memory-assistant Plugin Architecture

이 문서는 **memory-assistant** 플러그인이 Cursor IDE와 함께 어떻게 동작하는지 전반적인 아키텍처를 설명합니다.

---

## 1. 개요

memory-assistant는 **AI IDE 세션 간 지속 메모리**를 제공합니다. 도구 사용(파일 편집, 셸 명령 등)을 자동으로 기록하고, 프롬프트 종료 시 요약하며, MCP를 통해 과거 작업 기록을 검색할 수 있습니다.

---

## 2. 전체 구조도

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Cursor IDE                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │beforeSubmit  │  │afterFileEdit │  │beforeShell      │  │    stop     │  │
│  │Prompt (hook) │  │   (hook)     │  │Execution (hook) │  │   (hook)    │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘  └──────┬──────┘  │
│         │                 │                   │                  │         │
│  ┌──────▼─────────────────▼───────────────────▼──────────────────▼──────┐  │
│  │  hooks/*.js (Node) — stdin/stdout, ~/.memory-assistant/current-session│  │
│  └────────────────────────────────┬─────────────────────────────────────┘  │
└───────────────────────────────────┼────────────────────────────────────────┘
                                    │ HTTP (localhost:37888)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Worker Service (Express, Node) — worker/dist/server.js                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ /api/sessions│  │/api/observat.│  │/api/context  │  │ /api/search    │  │
│  │ /complete    │  │ /prompts/*   │  │ /recent      │  │ /timeline      │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                 │                 │                  │           │
│         ▼                 ▼                 ▼                  ▼           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ SQLite       │  │ AI Summarizer│  │ FTS5 search  │  │ ChromaDB       │  │
│  │ (sessions,   │  │ (Claude)     │  │ (keyword)    │  │ (semantic)     │  │
│  │  observat.)  │  │              │  │              │  │ optional       │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └────────────────┘  │
└───────────────────────────────────────┬─────────────────────────────────────┘
                                        │ HTTP (same port)
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  MCP Server (stdio) — mcp/dist/index.js                                     │
│  Tools: search, timeline, get_observations, semantic_search → Worker API    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 컴포넌트별 역할

### 3.1 Cursor Hooks (`hooks/`)

Cursor Agent가 특정 이벤트에서 실행하는 **Node.js 스크립트**입니다. `~/.cursor/hooks.json`에 등록합니다.

> **참고**: Cursor와 Claude Code는 훅 이벤트 이름이 다릅니다. 아래 표는 Cursor 기준입니다.

| Cursor 훅 이름 | 스크립트 | 시점 | 역할 |
|---------------|----------|------|------|
| **beforeSubmitPrompt** | `before-submit-prompt.js` | 사용자가 프롬프트 전송 직전 | Worker·Chroma 미기동 시 자동 기동, `conversation_id` 기반 세션 생성/유지, `prompt_number` 증가, 사용자 프롬프트 텍스트 저장 |
| **afterFileEdit** | `after-file-edit.js` | 파일 편집 직후 | 파일 편집을 observation으로 기록 (tool_name: `Edit`) |
| **beforeShellExecution** | `before-shell-execution.js` | 셸 명령 실행 직전 | 명령을 observation으로 기록 (tool_name: `Shell`), `{ "continue": true }`로 실행 허용 |
| **stop** | `stop.js` | Agent 턴 종료 시 | 현재 프롬프트에 대한 기본 요약 저장 + AI 요약 비동기 트리거 |

**`~/.cursor/hooks.json` 설정 예시:**
```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [{ "command": "node <PLUGIN_PATH>/hooks/before-submit-prompt.js" }],
    "afterFileEdit":      [{ "command": "node <PLUGIN_PATH>/hooks/after-file-edit.js" }],
    "beforeShellExecution": [{ "command": "node <PLUGIN_PATH>/hooks/before-shell-execution.js" }],
    "stop":               [{ "command": "node <PLUGIN_PATH>/hooks/stop.js" }]
  }
}
```

**Cursor vs Claude Code 훅 이벤트 대응표:**

| 기능 | Cursor 훅 | Claude Code 훅 |
|------|-----------|----------------|
| 세션 시작 + 컨텍스트 주입 | ❌ 없음 | `sessionStart` |
| 프롬프트 캡처 + 세션 관리 | `beforeSubmitPrompt` | `userPromptSubmit` |
| 파일 편집 기록 | `afterFileEdit` | `postToolUse` |
| 셸 명령 기록 | `beforeShellExecution` | `postToolUse` |
| 턴 종료 / 요약 | `stop` | `stop` |
| 세션 종료 | ❌ 없음 | `sessionEnd` |

모든 훅은 **stdin으로 JSON**을 받고, 필요한 경우 **stdout으로 JSON**을 반환합니다. 세션 식별은 `~/.memory-assistant/current-session.json`의 `session_id`, `prompt_number`로 이루어집니다.

> **제약사항**: Cursor의 `beforeSubmitPrompt`는 stdout 출력을 무시합니다. 따라서 Claude Code의 `sessionStart`처럼 컨텍스트를 자동 주입하는 것은 불가능하며, 대신 MCP를 통해 과거 기록을 검색할 수 있습니다.

---

### 3.2 Worker Service (`worker/`)

**Express HTTP 서버**로, 기본 포트 `37888`에서 동작합니다. 훅과 MCP에서만 사용하며, 브라우저 등 외부 노출은 가정하지 않습니다.

- **역할**
  - 세션 생성/완료, observation 저장
  - 사용자 프롬프트/프롬프트 요약 저장
  - **AI 요약**: 미요약 observation → Claude로 요약 → DB 반영 (선택적으로 ChromaDB 벡터 업서트)
  - 키워드 검색(FTS5), 타임라인, 배치 조회
  - ChromaDB 연동 시 **의미 검색** (`/api/search/semantic`)

- **주요 API**
  - `POST /api/sessions` — 세션 생성 (beforeSubmitPrompt에서 호출)
  - `POST /api/sessions/complete` — 세션 완료
  - `POST /api/observations` — observation 추가 (afterFileEdit, beforeShellExecution에서 호출)
  - `POST /api/prompts/user-prompt` — 사용자 프롬프트 저장 (beforeSubmitPrompt에서 호출)
  - `PATCH /api/prompts/summary` — 프롬프트 요약 저장 (stop에서 기본 요약 저장)
  - `POST /api/prompts/summarize-ai` — 해당 프롬프트에 대한 AI 요약 비동기 실행 (stop에서 트리거)
  - `GET /api/context/recent?project=&limit=` — 최근 요약 목록 조회
  - `GET /api/search`, `GET /api/timeline`, `POST /api/observations/batch` — MCP 검색/타임라인/배치
  - `GET /api/search/semantic` — ChromaDB 의미 검색 (선택)

Worker는 **ChromaDB가 없어도** 동작하며, 이 경우 의미 검색만 비활성화됩니다.

---

### 3.3 데이터 저장소

- **SQLite** (`~/.memory-assistant/memory-assistant.db`)
  - **sessions**: `session_id`, `editor`, `project_path`, `status`, `started_at`, `ended_at`
  - **observations**: `session_id`, `tool_name`, `tool_input`, `tool_output`, `cwd`, `duration_ms`, `prompt_number`, `ai_summary`, `observed_at`
  - **observations_fts**: FTS5 가상 테이블로 키워드 검색
  - **prompt_summaries**: 프롬프트 단위 요약 (`summary`, `key_learnings`, `user_prompt`, `assistant_response`)
  - **session_summaries**: 세션 단위 요약

- **ChromaDB** (선택, 기본 포트 8000)
  - observation 텍스트 임베딩 저장
  - Worker가 `initChroma()`로 연결 후, 요약 완료 시 벡터 업서트

- **로컬 파일**
  - `~/.memory-assistant/current-session.json` — 현재 세션 id, project_path, prompt_number (훅에서 읽기/쓰기)
  - `~/.memory-assistant/worker.pid` — Worker 프로세스 PID
  - `~/.memory-assistant/chroma.pid`, `~/.memory-assistant/chroma/` — ChromaDB 프로세스 및 데이터 디렉터리

---

### 3.4 AI Summarizer (`worker/src/ai/summarizer.ts`)

- **Observation 요약**: 도구 사용 내용을 1–2문장으로 요약해 `observations.ai_summary`에 저장.
- **프롬프트 요약 (구조화)**: `summarizePromptStructured`로 사용자 프롬프트·assistant 응답·해당 프롬프트의 observations를 묶어 "요청/조사/학습/완료/다음 단계" 형태로 요약해 `prompt_summaries`에 반영.
- **세션 요약**: 한 세션의 모든 observation을 묶어 세션 요약·핵심 학습을 생성.

Claude API(`ANTHROPIC_API_KEY`)를 사용하며, API 키가 없으면 AI 요약만 스킵되고 나머지 플로우는 정상 동작합니다.

---

### 3.5 MCP Server (`mcp/`)

**stdio 기반 MCP 서버**로, Cursor에서 MCP로 등록하면 채팅에서 도구를 호출할 수 있습니다.

- **search**: Worker `GET /api/search` (FTS5 키워드 검색)
- **timeline**: Worker `GET /api/timeline` (anchor_id 기준 전후 observation)
- **get_observations**: Worker `POST /api/observations/batch` (ID 목록으로 상세 조회)
- **semantic_search**: Worker `GET /api/search/semantic` (ChromaDB 의미 검색, ChromaDB 기동 시)

모든 호출은 **Worker의 HTTP API**로 프록시됩니다.

---

## 4. 데이터 흐름 요약

1. **프롬프트 전송**
   `beforeSubmitPrompt` → Worker/Chroma 미기동 시 자동 기동 → `conversation_id` 기반 세션 생성 또는 `prompt_number` 증가 → `POST /api/prompts/user-prompt`로 사용자 프롬프트 저장.

2. **도구 사용**
   `afterFileEdit` / `beforeShellExecution` → `POST /api/observations`로 observation 적재.

3. **Agent 턴 종료**
   `stop` → 미요약 observation 기본 요약 저장 → `PATCH /api/prompts/summary` → `POST /api/prompts/summarize-ai`로 해당 프롬프트 AI 요약 비동기 실행.

4. **검색**
   사용자가 MCP 도구 호출 → MCP가 Worker의 `/api/search`, `/api/timeline`, `/api/observations/batch`, `/api/search/semantic` 호출 → 결과를 채팅에 반환.

---

## 5. 설치

1. Worker 빌드: `cd worker && npm install && npm run build`
2. MCP 빌드: `cd mcp && npm install && npm run build`
3. `hooks/hooks.json`을 참고하여 `~/.cursor/hooks.json`에 훅 등록 (`PLUGIN_PATH`를 실제 경로로 교체)
4. Cursor MCP 설정에 MCP 서버 등록
5. (선택) `ANTHROPIC_API_KEY` 환경변수 설정 시 AI 요약 활성화
6. (선택) ChromaDB 설치 시 의미 검색 활성화

Worker와 ChromaDB는 첫 프롬프트 전송 시 `beforeSubmitPrompt` 훅이 자동으로 기동합니다.
