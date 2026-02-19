#!/usr/bin/env node
// session-end.js - Cursor sessionEnd hook
// Input (stdin): { session_id, reason, duration_ms, is_background_agent, final_status }

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
    await readStdin();

    // Read session file
    let session_id;
    try {
      const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      session_id = sessionData.session_id;
    } catch {
      process.exit(0);
    }

    if (!session_id) {
      process.exit(0);
    }

    // POST with 3s timeout (awaited - we want to complete before deleting)
    await safeFetch(`${BASE_URL}/api/sessions/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id }),
    }, 3000);

    // Delete session file
    try {
      fs.unlinkSync(SESSION_FILE);
    } catch {
      // ignore if already gone
    }
  } catch {
    // ignore all errors
  }
  process.exit(0);
}

main();
