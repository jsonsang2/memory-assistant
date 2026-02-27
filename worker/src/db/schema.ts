import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DB_DIR = path.join(os.homedir(), '.memory-assistant');
const DB_PATH = process.env.MEMORY_ASSISTANT_DB || path.join(DB_DIR, 'memory-assistant.db');

// ---------- better-sqlite3 compatibility wrapper ----------

class PreparedStatement {
  private _db: SqlJsDatabase;
  private _sql: string;
  private _saveFn: () => void;

  constructor(db: SqlJsDatabase, sql: string, saveFn: () => void) {
    this._db = db;
    this._sql = sql;
    this._saveFn = saveFn;
  }

  run(...params: any[]) {
    this._db.run(this._sql, params);
    this._saveFn();
    const meta = this._db.exec("SELECT last_insert_rowid() AS lid, changes() AS ch");
    const lastInsertRowid = meta[0]?.values[0]?.[0] ?? 0;
    const changes = meta[0]?.values[0]?.[1] ?? 0;
    return { lastInsertRowid, changes };
  }

  get(...params: any[]): any {
    const stmt = this._db.prepare(this._sql);
    try {
      if (params.length > 0) stmt.bind(params);
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  all(...params: any[]): any[] {
    const stmt = this._db.prepare(this._sql);
    try {
      if (params.length > 0) stmt.bind(params);
      const results: any[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      return results;
    } finally {
      stmt.free();
    }
  }
}

class SqliteCompat {
  private _db: SqlJsDatabase;
  private _dbPath: string;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(db: SqlJsDatabase, dbPath: string) {
    this._db = db;
    this._dbPath = dbPath;

    // Save on process exit
    process.on('exit', () => this.save());
  }

  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this._db, sql, () => this.scheduleSave());
  }

  exec(sql: string): void {
    this._db.exec(sql);
    this.scheduleSave();
  }

  pragma(pragmaStr: string): void {
    try {
      this._db.exec(`PRAGMA ${pragmaStr}`);
    } catch {
      // Some pragmas (like WAL) not supported in sql.js
    }
  }

  private scheduleSave(): void {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this.save();
      this._saveTimer = null;
    }, 100);
  }

  save(): void {
    try {
      const data = this._db.export();
      const dir = path.dirname(this._dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._dbPath, Buffer.from(data));
    } catch (e) {
      console.error('Failed to save database:', e);
    }
  }
}

// ---------- Singleton with lazy proxy ----------

let _instance: SqliteCompat | null = null;

export async function initDb(): Promise<SqliteCompat> {
  if (_instance) return _instance;

  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Locate WASM file explicitly — needed when bundled with esbuild (external)
  // require.resolve('sql.js') -> .../sql.js/dist/sql-wasm.js, so dirname is already the dist folder
  const sqlJsDistDir = path.dirname(require.resolve('sql.js'));
  const wasmPath = path.join(sqlJsDistDir, 'sql-wasm.wasm');
  const locateFile = fs.existsSync(wasmPath)
    ? (file: string) => path.join(sqlJsDistDir, file)
    : undefined;
  const SQL = await initSqlJs(locateFile ? { locateFile } : undefined);

  let sqlDb: SqlJsDatabase;
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    sqlDb = new SQL.Database(fileBuffer);
  } else {
    sqlDb = new SQL.Database();
  }

  _instance = new SqliteCompat(sqlDb, DB_PATH);

  // WAL not meaningful for sql.js (in-memory), skip
  _instance.pragma('foreign_keys = ON');

  // Create tables
  _instance.exec(`
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
    _instance.prepare(`SELECT prompt_number FROM observations LIMIT 1`).get();
  } catch {
    _instance.exec(`ALTER TABLE observations ADD COLUMN prompt_number INTEGER NOT NULL DEFAULT 0`);
  }

  _instance.exec(`CREATE INDEX IF NOT EXISTS idx_observations_session_prompt ON observations(session_id, prompt_number)`);

  // Migration: add user_prompt column to prompt_summaries
  try {
    _instance.prepare(`SELECT user_prompt FROM prompt_summaries LIMIT 1`).get();
  } catch {
    _instance.exec(`ALTER TABLE prompt_summaries ADD COLUMN user_prompt TEXT`);
  }

  // Migration: add assistant_response column to prompt_summaries
  try {
    _instance.prepare(`SELECT assistant_response FROM prompt_summaries LIMIT 1`).get();
  } catch {
    _instance.exec(`ALTER TABLE prompt_summaries ADD COLUMN assistant_response TEXT`);
  }

  return _instance;
}

export function getDb(): SqliteCompat {
  if (!_instance) throw new Error('Database not initialized. Call initDb() first.');
  return _instance;
}

// Proxy-based default export: backward compatible with `import db from './schema.js'`
// All access is forwarded to the initialized instance.
const db: any = new Proxy({}, {
  get(_target, prop: string) {
    const instance = getDb();
    const val = (instance as any)[prop];
    if (typeof val === 'function') return val.bind(instance);
    return val;
  }
});

export default db;
