import db from './schema.js';
import { getSession } from './sessions.js';
import type { Observation } from '../types.js';
import { upsertObservationVector } from './vectors.js';

function truncate(value: any, maxLen: number): string | null {
  if (value === undefined || value === null) return null;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen);
}

export function insertObservation(data: {
  session_id: string;
  tool_name: string;
  tool_input: any;
  tool_output: any;
  cwd?: string;
  duration_ms?: number;
  prompt_number?: number;
}): { id: number } {
  const session = getSession(data.session_id);
  if (!session) {
    throw new Error(`Session not found: ${data.session_id}`);
  }

  const result = db.prepare(`
    INSERT INTO observations (session_id, tool_name, tool_input, tool_output, cwd, duration_ms, prompt_number)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    data.tool_name,
    truncate(data.tool_input, 2000),
    truncate(data.tool_output, 2000),
    data.cwd || null,
    data.duration_ms || null,
    data.prompt_number || 0
  );

  const id = Number(result.lastInsertRowid);

  // Async: upsert to ChromaDB (fire-and-forget)
  void upsertObservationVector({
    id,
    tool_name: data.tool_name,
    tool_input: truncate(data.tool_input, 500),
    ai_summary: null,
    session_id: session.id,
  });

  return { id };
}

export function getUnsummarizedObservations(session_id: string): Observation[] {
  const session = getSession(session_id);
  if (!session) return [];

  return db.prepare(`
    SELECT * FROM observations
    WHERE session_id = ? AND ai_summary IS NULL
    ORDER BY observed_at ASC
  `).all(session.id) as Observation[];
}

export function getUnsummarizedObservationsByPrompt(session_id: string, prompt_number: number): Observation[] {
  const session = getSession(session_id);
  if (!session) return [];

  return db.prepare(`
    SELECT * FROM observations
    WHERE session_id = ? AND prompt_number = ? AND ai_summary IS NULL
    ORDER BY observed_at ASC
  `).all(session.id, prompt_number) as Observation[];
}

export function getObservationsByPrompt(session_id: string, prompt_number: number): Observation[] {
  const session = getSession(session_id);
  if (!session) return [];

  return db.prepare(`
    SELECT * FROM observations
    WHERE session_id = ? AND prompt_number = ?
    ORDER BY observed_at ASC
  `).all(session.id, prompt_number) as Observation[];
}

export function updateObservationSummary(id: number, summary: string): void {
  db.prepare(`
    UPDATE observations SET ai_summary = ? WHERE id = ?
  `).run(summary, id);

  // Re-upsert to ChromaDB with updated summary
  const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as Observation | undefined;
  if (obs) {
    void upsertObservationVector({
      id: obs.id,
      tool_name: obs.tool_name,
      tool_input: obs.tool_input,
      ai_summary: summary,
      session_id: obs.session_id,
    });
  }
}

export function getObservationsByIds(ids: number[]): Observation[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT * FROM observations WHERE id IN (${placeholders}) ORDER BY observed_at ASC
  `).all(...ids) as Observation[];
}

export function getObservationContext(
  anchor_id: number,
  before: number = 3,
  after: number = 3
): { anchor: Observation; before: Observation[]; after: Observation[] } {
  const anchor = db.prepare(`
    SELECT * FROM observations WHERE id = ?
  `).get(anchor_id) as Observation | undefined;

  if (!anchor) {
    throw new Error(`Observation not found: ${anchor_id}`);
  }

  const beforeRows = db.prepare(`
    SELECT * FROM observations
    WHERE session_id = ? AND observed_at < ? AND id != ?
    ORDER BY observed_at DESC
    LIMIT ?
  `).all(anchor.session_id, anchor.observed_at, anchor.id, before) as Observation[];

  const afterRows = db.prepare(`
    SELECT * FROM observations
    WHERE session_id = ? AND observed_at > ? AND id != ?
    ORDER BY observed_at ASC
    LIMIT ?
  `).all(anchor.session_id, anchor.observed_at, anchor.id, after) as Observation[];

  return {
    anchor,
    before: beforeRows.reverse(),
    after: afterRows,
  };
}
