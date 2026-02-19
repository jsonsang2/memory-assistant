#!/usr/bin/env node
// post-tool-use.js - Cursor postToolUse hook
// Input (stdin): { tool_name, tool_input, tool_output, tool_use_id, cwd, duration, model }

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
    let session_id;
    let prompt_number = 1;
    try {
      const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      session_id = sessionData.session_id;
      prompt_number = sessionData.prompt_number || 1;
    } catch {
      // No session file - exit silently
      process.exit(0);
    }

    if (!session_id) {
      process.exit(0);
    }

    const tool_output = JSON.stringify(data.tool_output || '').slice(0, 2000);
    const tool_input = JSON.stringify(data.tool_input || '').slice(0, 2000);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);

    await fetch(`${BASE_URL}/api/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id,
        tool_name: data.tool_name || '',
        tool_input,
        tool_output,
        cwd: data.cwd || '',
        duration_ms: data.duration || 0,
        prompt_number,
      }),
      signal: controller.signal,
    }).catch(() => {});
  } catch {
    // ignore all errors
  }
  process.exit(0);
}

main();
