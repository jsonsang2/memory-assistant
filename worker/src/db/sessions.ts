import db from './schema.js';
import type { Session } from '../types.js';

export interface SessionWithDetails extends Session {
  observation_count: number;
  summary: string | null;        // keep for backward compat
  key_learnings: string | null;  // keep for backward compat
  prompt_summaries: string | null; // JSON array of prompt summaries
}

export function upsertSession(session_id: string, editor: string, project_path: string | null): Session {
  db.prepare(`
    INSERT OR IGNORE INTO sessions (session_id, editor, project_path)
    VALUES (?, ?, ?)
  `).run(session_id, editor, project_path);

  return db.prepare(`
    SELECT * FROM sessions WHERE session_id = ?
  `).get(session_id) as Session;
}

export function getSession(session_id: string): Session | null {
  return db.prepare(`
    SELECT * FROM sessions WHERE session_id = ?
  `).get(session_id) as Session | null;
}

export function completeSession(session_id: string): { observation_count: number } {
  db.prepare(`
    UPDATE sessions
    SET status = 'completed', ended_at = datetime('now')
    WHERE session_id = ?
  `).run(session_id);

  const session = getSession(session_id);
  if (!session) {
    return { observation_count: 0 };
  }

  const result = db.prepare(`
    SELECT COUNT(*) as count FROM observations WHERE session_id = ?
  `).get(session.id) as { count: number };

  return { observation_count: result.count };
}

export function getRecentSessions(
  project_path: string | null,
  limit: number = 10
): SessionWithDetails[] {
  let query = `
    SELECT
      s.*,
      COALESCE((SELECT COUNT(*) FROM observations o WHERE o.session_id = s.id), 0) as observation_count,
      ss.summary,
      ss.key_learnings,
      (
        SELECT json_group_array(json_object(
          'prompt_number', ps2.prompt_number,
          'summary', ps2.summary,
          'key_learnings', ps2.key_learnings,
          'user_prompt', ps2.user_prompt
        ))
        FROM (
          SELECT * FROM prompt_summaries
          WHERE session_id = s.id
          ORDER BY prompt_number ASC
        ) ps2
      ) as prompt_summaries
    FROM sessions s
    LEFT JOIN session_summaries ss ON ss.session_id = s.id
  `;

  const params: any[] = [];

  if (project_path) {
    query += ` WHERE s.project_path = ?`;
    params.push(project_path);
  }

  query += ` ORDER BY s.started_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(query).all(...params) as SessionWithDetails[];
}
