#!/usr/bin/env node
// user-prompt-submit.js - UserPromptSubmit hook
// Input (stdin): { session_id, prompt, transcript_path, cwd, ... }
// Captures user prompt text and stores via Worker API

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
    const stdinData = await readStdin();
    const userPrompt = (stdinData.prompt || '').slice(0, 2000);
    if (!userPrompt) {
      process.exit(0);
    }

    // Read session file for session_id and prompt_number
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

    // Send user prompt to worker (with timeout)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      await fetch(`${BASE_URL}/api/prompts/user-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id, prompt_number, user_prompt: userPrompt }),
        signal: controller.signal,
      });
    } catch {
      // ignore network errors
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // ignore all errors
  }
  process.exit(0);
}

main();
