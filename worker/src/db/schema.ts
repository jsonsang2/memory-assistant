import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DB_DIR = path.join(os.homedir(), '.memory-assistant');
const DB_PATH = process.env.MEMORY_ASSISTANT_DB || path.join(DB_DIR, 'memory-assistant.db');

// Ensure the directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode and foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL UNIQUE,
    editor       TEXT NOT NULL DEFAULT 'cursor',
    project_path TEXT,
    status       TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','aborted')),
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS observations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL REFERENCES sessions(id),
    tool_name    TEXT NOT NULL,
    tool_input   TEXT,
    tool_output  TEXT,
    cwd          TEXT,
    duration_ms  INTEGER,
    prompt_number INTEGER NOT NULL DEFAULT 0,
    ai_summary   TEXT,
    observed_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
    tool_name, tool_input, tool_output, ai_summary,
    content='observations', content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, tool_name, tool_input, tool_output, ai_summary)
    VALUES (new.id, new.tool_name, new.tool_input, new.tool_output, new.ai_summary);
  END;

  CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, tool_name, tool_input, tool_output, ai_summary)
    VALUES ('delete', old.id, old.tool_name, old.tool_input, old.tool_output, old.ai_summary);
    INSERT INTO observations_fts(rowid, tool_name, tool_input, tool_output, ai_summary)
    VALUES (new.id, new.tool_name, new.tool_input, new.tool_output, new.ai_summary);
  END;

  CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, tool_name, tool_input, tool_output, ai_summary)
    VALUES ('delete', old.id, old.tool_name, old.tool_input, old.tool_output, old.ai_summary);
  END;

  CREATE TABLE IF NOT EXISTS session_summaries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    INTEGER NOT NULL UNIQUE REFERENCES sessions(id),
    summary       TEXT NOT NULL,
    key_learnings TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prompt_summaries (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     INTEGER NOT NULL REFERENCES sessions(id),
    prompt_number  INTEGER NOT NULL,
    summary        TEXT NOT NULL,
    key_learnings  TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, prompt_number)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_project_status ON sessions(project_path, status);
  CREATE INDEX IF NOT EXISTS idx_observations_session_observed ON observations(session_id, observed_at);
`);

// Migration: add prompt_number column to existing observations table
try {
  db.prepare(`SELECT prompt_number FROM observations LIMIT 1`).get();
} catch {
  db.exec(`ALTER TABLE observations ADD COLUMN prompt_number INTEGER NOT NULL DEFAULT 0`);
}

// Create index on prompt_number (after migration ensures column exists)
db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_session_prompt ON observations(session_id, prompt_number)`);

export function getDb() {
  return db;
}

export default db;
