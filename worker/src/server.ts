import express from 'express';
import db from './db/schema.js';
import { upsertSession, getSession, completeSession, getRecentSessions } from './db/sessions.js';
import {
  insertObservation,
  getUnsummarizedObservations,
  getUnsummarizedObservationsByPrompt,
  getObservationsByPrompt,
  updateObservationSummary,
  getObservationsByIds,
  getObservationContext,
} from './db/observations.js';
import { createSummarizer } from './ai/summarizer.js';
import { initChroma, isChromaAvailable, semanticSearch, upsertObservationVector } from './db/vectors.js';

const app = express();
const PORT = parseInt(process.env.MEMORY_ASSISTANT_PORT || '37888', 10);

app.use(express.json({ limit: '5mb' }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '0.1.0',
    uptime_s: Math.floor(process.uptime()),
    db_size_bytes: 0,
  });
});

// Upsert session
app.post('/api/sessions', (req, res) => {
  try {
    const { session_id, editor = 'cursor', project_path = null } = req.body;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required', code: 'MISSING_SESSION_ID' });
      return;
    }
    const session = upsertSession(session_id, editor, project_path);
    res.status(200).json(session);
  } catch (e: any) {
    console.error('POST /api/sessions error:', e);
    res.status(500).json({ error: e.message, code: 'SESSION_ERROR' });
  }
});

// Insert observation
app.post('/api/observations', (req, res) => {
  try {
    const { session_id, tool_name, tool_input, tool_output, cwd, duration_ms, prompt_number } = req.body;
    if (!session_id || !tool_name) {
      res.status(400).json({ error: 'session_id and tool_name are required', code: 'MISSING_FIELDS' });
      return;
    }
    const result = insertObservation({ session_id, tool_name, tool_input, tool_output, cwd, duration_ms, prompt_number });
    res.status(201).json(result);
  } catch (e: any) {
    console.error('POST /api/observations error:', e);
    res.status(500).json({ error: e.message, code: 'OBSERVATION_ERROR' });
  }
});

// Batch fetch observations by IDs
app.post('/api/observations/batch', (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) {
      res.status(400).json({ error: 'ids must be an array', code: 'INVALID_IDS' });
      return;
    }
    const observations = getObservationsByIds(ids);
    res.status(200).json(observations);
  } catch (e: any) {
    console.error('POST /api/observations/batch error:', e);
    res.status(500).json({ error: e.message, code: 'BATCH_ERROR' });
  }
});

// Get prompts that need summary (all observations summarized, no prompt summary yet)
app.get('/api/prompts/pending', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string || '5', 10);
    const rows = db.prepare(`
      SELECT DISTINCT o.session_id, o.prompt_number, s.session_id as session_id_text,
        s.project_path,
        COUNT(*) as observation_count,
        GROUP_CONCAT(o.ai_summary, ' | ') as combined_summaries
      FROM observations o
      JOIN sessions s ON o.session_id = s.id
      WHERE o.prompt_number > 0
        AND o.ai_summary IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM observations o2
          WHERE o2.session_id = o.session_id
            AND o2.prompt_number = o.prompt_number
            AND o2.ai_summary IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM prompt_summaries ps
          WHERE ps.session_id = o.session_id
            AND ps.prompt_number = o.prompt_number
        )
      GROUP BY o.session_id, o.prompt_number
      ORDER BY MAX(o.observed_at) ASC
      LIMIT ?
    `).all(limit);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message, code: 'PENDING_PROMPTS_ERROR' });
  }
});

// Save prompt summary (from VS Code Extension)
app.patch('/api/prompts/summary', (req, res) => {
  try {
    const { session_id, prompt_number, summary, key_learnings, user_prompt, assistant_response } = req.body;
    if (!session_id || prompt_number === undefined || !summary) {
      res.status(400).json({ error: 'session_id, prompt_number, and summary are required', code: 'MISSING_FIELDS' });
      return;
    }

    const userPrompt = user_prompt ? String(user_prompt).slice(0, 2000) : null;
    const assistantResponse = assistant_response ? String(assistant_response).slice(0, 2000) : null;
    const key_learnings_json = JSON.stringify(key_learnings || []);

    // Resolve string session_id to integer DB ID
    let dbSessionId: number | string = session_id;
    if (typeof session_id === 'string' && isNaN(Number(session_id))) {
      const session = getSession(session_id);
      if (!session) {
        res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }
      dbSessionId = session.id;
    }

    db.prepare(`
      INSERT INTO prompt_summaries (session_id, prompt_number, summary, key_learnings, user_prompt, assistant_response)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, prompt_number) DO UPDATE SET
        summary = COALESCE(excluded.summary, prompt_summaries.summary),
        key_learnings = COALESCE(excluded.key_learnings, prompt_summaries.key_learnings),
        user_prompt = COALESCE(excluded.user_prompt, prompt_summaries.user_prompt),
        assistant_response = COALESCE(excluded.assistant_response, prompt_summaries.assistant_response)
    `).run(dbSessionId, prompt_number, summary, key_learnings_json, userPrompt, assistantResponse);

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message, code: 'SAVE_PROMPT_SUMMARY_ERROR' });
  }
});

// POST /api/prompts/user-prompt - capture user prompt text from UserPromptSubmit hook
app.post('/api/prompts/user-prompt', (req, res) => {
  try {
    const { session_id, prompt_number, user_prompt } = req.body;
    if (!session_id || !prompt_number || !user_prompt) {
      res.status(400).json({ error: 'session_id, prompt_number, and user_prompt are required' });
      return;
    }

    const session = getSession(session_id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const truncatedPrompt = String(user_prompt).slice(0, 2000);

    db.prepare(`
      INSERT INTO prompt_summaries (session_id, prompt_number, summary, user_prompt)
      VALUES (?, ?, '', ?)
      ON CONFLICT(session_id, prompt_number) DO UPDATE SET
        user_prompt = excluded.user_prompt
    `).run(session.id, prompt_number, truncatedPrompt);

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/prompts/summarize-ai - fire-and-forget AI summarization
app.post('/api/prompts/summarize-ai', (req, res) => {
  try {
    const { session_id, prompt_number } = req.body;
    if (!session_id || prompt_number === undefined) {
      res.status(400).json({ error: 'session_id and prompt_number are required' });
      return;
    }

    // Return immediately, process in background
    res.status(202).json({ message: 'AI summarization started' });

    setImmediate(async () => {
      try {
        if (!process.env.ANTHROPIC_API_KEY) return;

        const summarizer = createSummarizer();

        const session = getSession(session_id);
        if (!session) return;

        // Read existing prompt summary for user_prompt and assistant_response
        const promptRow = db.prepare(`
          SELECT user_prompt, assistant_response FROM prompt_summaries
          WHERE session_id = ? AND prompt_number = ?
        `).get(session.id, prompt_number) as { user_prompt: string | null; assistant_response: string | null } | undefined;

        const userPrompt = promptRow?.user_prompt || '';
        const assistantResponse = promptRow?.assistant_response || '';

        // Get observations for this prompt
        const observations = getObservationsByPrompt(session_id, prompt_number);

        // Run AI summarization
        const structured = await summarizer.summarizePromptStructured(
          userPrompt, assistantResponse, observations
        );

        // Format into summary string
        const aiSummary = [
          structured.request,
          `Investigated: ${structured.investigated}`,
          `Learned: ${structured.learned}`,
          `Completed: ${structured.completed}`,
          `Next: ${structured.next_steps}`,
        ].join(' | ');

        const keyLearnings = [structured.learned, structured.next_steps].filter(s => s && s !== 'N/A');

        // Update prompt summary with AI result
        db.prepare(`
          UPDATE prompt_summaries SET summary = ?, key_learnings = ?
          WHERE session_id = ? AND prompt_number = ?
        `).run(aiSummary, JSON.stringify(keyLearnings), session.id, prompt_number);

      } catch (err) {
        console.error('AI summarization failed:', err);
      }
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Summarize a specific prompt (async)
app.post('/api/prompts/summarize', (req, res) => {
  const { session_id, prompt_number } = req.body;
  if (!session_id || prompt_number === undefined) {
    res.status(400).json({ error: 'session_id and prompt_number are required', code: 'MISSING_FIELDS' });
    return;
  }

  res.status(202).json({ message: 'Prompt summarization started' });

  setImmediate(async () => {
    try {
      const summarizer = createSummarizer();
      const observations = getUnsummarizedObservationsByPrompt(session_id, prompt_number);
      if (observations.length === 0) return;

      // Summarize individual observations
      const summaries = await summarizer.summarizeObservations(observations);
      for (const s of summaries) {
        updateObservationSummary(s.id, s.summary);
      }

      // Generate prompt-level summary
      const session = getSession(session_id);
      if (!session) return;

      const allPromptObservations = getObservationsByPrompt(session_id, prompt_number);
      const promptSummary = await summarizer.summarizePrompt(session, prompt_number, allPromptObservations);

      db.prepare(`
        INSERT OR REPLACE INTO prompt_summaries (session_id, prompt_number, summary, key_learnings)
        VALUES (?, ?, ?, ?)
      `).run(session.id, prompt_number, promptSummary.summary, JSON.stringify(promptSummary.key_learnings));
    } catch (e) {
      console.error('Prompt summarize failed:', e);
    }
  });
});

// Summarize session (async)
app.post('/api/sessions/summarize', (req, res) => {
  const { session_id } = req.body;
  if (!session_id) {
    res.status(400).json({ error: 'session_id is required', code: 'MISSING_SESSION_ID' });
    return;
  }

  res.status(202).json({ message: 'Summarization started' });

  setImmediate(async () => {
    try {
      const summarizer = createSummarizer();
      const observations = getUnsummarizedObservations(session_id);
      if (observations.length === 0) return;

      const summaries = await summarizer.summarizeObservations(observations);
      for (const s of summaries) {
        updateObservationSummary(s.id, s.summary);
      }

      const session = getSession(session_id);
      if (!session) return;

      const allObservations = db.prepare(`
        SELECT * FROM observations WHERE session_id = ? ORDER BY observed_at ASC
      `).all(session.id) as any[];

      const sessionSummary = await summarizer.summarizeSession(session, allObservations);

      db.prepare(`
        INSERT OR REPLACE INTO session_summaries (session_id, summary, key_learnings)
        VALUES (?, ?, ?)
      `).run(session.id, sessionSummary.summary, JSON.stringify(sessionSummary.key_learnings));
    } catch (e) {
      console.error('Summarize failed:', e);
    }
  });
});

// GET /api/observations/unsummarized - for VSCode Extension polling
app.get('/api/observations/unsummarized', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string || '10', 10);
    const sessionIdText = req.query.session_id as string | undefined;
    const promptNumber = req.query.prompt_number ? parseInt(req.query.prompt_number as string, 10) : undefined;

    let query = `
      SELECT o.*, s.session_id as session_id_text
      FROM observations o
      JOIN sessions s ON o.session_id = s.id
      WHERE o.ai_summary IS NULL
    `;
    const params: any[] = [];

    if (sessionIdText) {
      query += ` AND s.session_id = ?`;
      params.push(sessionIdText);
    }
    if (promptNumber !== undefined) {
      query += ` AND o.prompt_number = ?`;
      params.push(promptNumber);
    }

    query += ` ORDER BY o.observed_at ASC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message, code: 'UNSUMMARIZED_ERROR' });
  }
});

// PATCH /api/observations/:id/summary - for VSCode Extension write-back
app.patch('/api/observations/:id/summary', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { summary } = req.body;
    if (!summary) {
      res.status(400).json({ error: 'summary is required', code: 'MISSING_SUMMARY' });
      return;
    }
    updateObservationSummary(id, summary);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message, code: 'UPDATE_SUMMARY_ERROR' });
  }
});

// Complete session
app.post('/api/sessions/complete', (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) {
      res.status(400).json({ error: 'session_id is required', code: 'MISSING_SESSION_ID' });
      return;
    }
    const result = completeSession(session_id);
    res.status(200).json(result);
  } catch (e: any) {
    console.error('POST /api/sessions/complete error:', e);
    res.status(500).json({ error: e.message, code: 'COMPLETE_ERROR' });
  }
});

// Recent sessions context
app.get('/api/context/recent', (req, res) => {
  try {
    const project = req.query.project as string | undefined;
    const limit = parseInt(req.query.limit as string || '10', 10);
    const sessions = getRecentSessions(project || null, limit);
    res.status(200).json(sessions);
  } catch (e: any) {
    console.error('GET /api/context/recent error:', e);
    res.status(500).json({ error: e.message, code: 'CONTEXT_ERROR' });
  }
});

// FTS5 search
app.get('/api/search', (req, res) => {
  try {
    const { query, project, limit = '20', offset = '0', date_gte, date_lte } = req.query as Record<string, string>;

    if (!query) {
      res.status(400).json({ error: 'query is required', code: 'MISSING_QUERY' });
      return;
    }

    let sql = `
      SELECT
        o.*,
        snippet(observations_fts, 0, '<b>', '</b>', '...', 10) as snippet,
        rank,
        s.session_id as session_id_text
      FROM observations_fts
      JOIN observations o ON observations_fts.rowid = o.id
      JOIN sessions s ON o.session_id = s.id
      WHERE observations_fts MATCH ?
    `;

    const params: any[] = [query];

    if (project) {
      sql += ` AND s.project_path = ?`;
      params.push(project);
    }

    if (date_gte) {
      sql += ` AND o.observed_at >= ?`;
      params.push(date_gte);
    }

    if (date_lte) {
      sql += ` AND o.observed_at <= ?`;
      params.push(date_lte);
    }

    sql += ` ORDER BY rank LIMIT ? OFFSET ?`;
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const results = db.prepare(sql).all(...params);
    res.status(200).json(results);
  } catch (e: any) {
    console.error('GET /api/search error:', e);
    res.status(500).json({ error: e.message, code: 'SEARCH_ERROR' });
  }
});

// Timeline context
app.get('/api/timeline', (req, res) => {
  try {
    const { session_id, anchor_id, before = '3', after = '3' } = req.query as Record<string, string>;

    if (anchor_id) {
      const context = getObservationContext(
        parseInt(anchor_id, 10),
        parseInt(before, 10),
        parseInt(after, 10)
      );
      res.status(200).json(context);
      return;
    }

    if (session_id) {
      const session = getSession(session_id);
      if (!session) {
        res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }
      const observations = db.prepare(`
        SELECT * FROM observations WHERE session_id = ? ORDER BY observed_at ASC
      `).all(session.id);
      res.status(200).json(observations);
      return;
    }

    res.status(400).json({ error: 'session_id or anchor_id is required', code: 'MISSING_PARAMS' });
  } catch (e: any) {
    console.error('GET /api/timeline error:', e);
    res.status(500).json({ error: e.message, code: 'TIMELINE_ERROR' });
  }
});

// Sync existing observations to ChromaDB (backfill)
app.post('/api/chroma/sync', async (_req, res) => {
  if (!isChromaAvailable()) {
    res.status(503).json({ error: 'ChromaDB not available', code: 'CHROMA_UNAVAILABLE' });
    return;
  }

  res.status(202).json({ message: 'Sync started' });

  setImmediate(async () => {
    try {
      const rows = db.prepare(`
        SELECT o.id, o.tool_name, o.tool_input, o.ai_summary, o.session_id
        FROM observations o
      `).all() as any[];

      console.log(`Syncing ${rows.length} observations to ChromaDB...`);
      for (const row of rows) {
        await upsertObservationVector(row);
      }
      console.log('ChromaDB sync complete');
    } catch (e) {
      console.error('ChromaDB sync failed:', e);
    }
  });
});

// Semantic search (requires ChromaDB)
app.get('/api/search/semantic', async (req, res) => {
  if (!isChromaAvailable()) {
    res.status(503).json({ error: 'Semantic search unavailable. Start ChromaDB: chroma run --path ~/.memory-assistant/chroma', code: 'CHROMA_UNAVAILABLE' });
    return;
  }

  const { query, limit = '10' } = req.query as Record<string, string>;
  if (!query) {
    res.status(400).json({ error: 'query is required', code: 'MISSING_QUERY' });
    return;
  }

  try {
    const ids = await semanticSearch(query, parseInt(limit, 10));
    const observations = getObservationsByIds(ids);
    res.json(observations);
  } catch (e: any) {
    res.status(500).json({ error: e.message, code: 'SEMANTIC_SEARCH_ERROR' });
  }
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message, code: 'INTERNAL_ERROR' });
});

app.listen(PORT, () => {
  console.log(`memory-assistant worker listening on port ${PORT}`);
  // Init ChromaDB connection (non-blocking)
  void initChroma();
});

export default app;
