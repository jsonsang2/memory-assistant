#!/usr/bin/env node
// stop.js - Stop hook (compatible with both Cursor and Claude Code)
// Cursor stdin: { conversation_id, generation_id, status, workspace_roots }
// Claude Code stdin: { status, loop_count, last_assistant_message }
// Saves basic summary and triggers AI summarization

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const PORT = process.env.MEMORY_ASSISTANT_PORT || 37888;
const BASE_URL = `http://localhost:${PORT}`;
const SESSION_FILE = path.join(os.homedir(), '.memory-assistant', 'current-session.json');

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    process.stdin.on('error', () => resolve({}));
    setTimeout(() => resolve({}), 1000);
  });
}

async function safeFetch(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  try {
    const stdinData = await readStdin();
    // Claude Code provides last_assistant_message; Cursor does not
    const assistantResponse = (stdinData.last_assistant_message || '').slice(0, 2000) || null;

    // Read session file
    let sessionData;
    try {
      sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    } catch {
      process.exit(0);
    }

    const session_id = sessionData.session_id;
    const prompt_number = sessionData.prompt_number || 1;

    if (!session_id) {
      process.exit(0);
    }

    // Wait for summarization to complete before exiting
    await summarizePrompt(session_id, prompt_number, assistantResponse).catch(() => {});

  } catch {
    // ignore all errors
  }
}

async function summarizePrompt(session_id, prompt_number, assistantResponse) {
  // Fetch unsummarized observations for this specific session + prompt
  const promptObs = await safeFetch(
    `${BASE_URL}/api/observations/unsummarized?session_id=${encodeURIComponent(session_id)}&prompt_number=${prompt_number}&limit=50`
  );

  // Build basic summary even if no observations (we might still have user_prompt)
  let basicSummary;
  if (promptObs && Array.isArray(promptObs) && promptObs.length > 0) {
    const toolCounts = {};
    for (const o of promptObs) {
      toolCounts[o.tool_name] = (toolCounts[o.tool_name] || 0) + 1;
    }
    const toolDesc = Object.entries(toolCounts)
      .map(([name, count]) => `${name}(${count})`)
      .join(', ');
    basicSummary = `Prompt #${prompt_number}: ${promptObs.length} tool calls — ${toolDesc}`;
  } else {
    basicSummary = `Prompt #${prompt_number}: conversation only`;
  }

  // Save prompt summary (PATCH upserts with COALESCE)
  await safeFetch(`${BASE_URL}/api/prompts/summary`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id,
      prompt_number,
      summary: basicSummary,
      key_learnings: [],
      assistant_response: assistantResponse,
    }),
  });

  // Save individual observation summaries
  if (promptObs && Array.isArray(promptObs)) {
    for (const obs of promptObs) {
      const obsSummary = `[${obs.tool_name}] ${(obs.tool_input || '').slice(0, 100)}`;
      await safeFetch(`${BASE_URL}/api/observations/${obs.id}/summary`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: obsSummary }),
      });
    }
  }

  // Fire-and-forget: trigger AI summarization in worker (non-blocking)
  safeFetch(`${BASE_URL}/api/prompts/summarize-ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id, prompt_number }),
  }, 1000).catch(() => {});
}

main();
