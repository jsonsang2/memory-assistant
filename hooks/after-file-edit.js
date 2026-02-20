#!/usr/bin/env node
// after-file-edit.js - Cursor afterFileEdit hook
// Input (stdin): { conversation_id, generation_id, file_path, edits, workspace_roots }
// Saves file edit as observation

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

async function main() {
  try {
    const data = await readStdin();

    // Read session file
    let session_id, prompt_number;
    try {
      const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      session_id = sessionData.session_id;
      prompt_number = sessionData.prompt_number || 1;
    } catch {
      process.exit(0);
    }

    if (!session_id) {
      process.exit(0);
    }

    // Build observation from file edit data
    const filePath = data.file_path || '';
    const edits = data.edits || [];
    const editSummary = edits.map(e => {
      const old = (e.old_string || '').slice(0, 100);
      const new_ = (e.new_string || '').slice(0, 100);
      return `${old} → ${new_}`;
    }).join('; ').slice(0, 500);

    const tool_input = JSON.stringify({ file_path: filePath, edit_count: edits.length }).slice(0, 2000);
    const tool_output = JSON.stringify({ edits: editSummary }).slice(0, 2000);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);

    await fetch(`${BASE_URL}/api/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id,
        tool_name: 'Edit',
        tool_input,
        tool_output,
        cwd: '',
        duration_ms: 0,
        prompt_number,
      }),
      signal: controller.signal,
    }).catch(() => {});
  } catch {}
  process.exit(0);
}

main();
