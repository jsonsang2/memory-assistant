#!/usr/bin/env node
// before-shell-execution.js - Cursor beforeShellExecution hook
// Input (stdin): { conversation_id, generation_id, command, cwd, workspace_roots }
// Saves shell command as observation, always allows execution

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = process.env.MEMORY_ASSISTANT_PORT || 37888;
const BASE_URL = `http://localhost:${PORT}`;
const SESSION_DIR = path.join(os.homedir(), '.memory-assistant');
const SESSION_FILE = path.join(SESSION_DIR, 'current-session.json');
const AUTH_TOKEN_FILE = path.join(SESSION_DIR, 'auth-token');

function getAuthToken() {
  try { return fs.readFileSync(AUTH_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

function redactSecrets(text) {
  if (!text) return text;
  return text
    // KEY=value, SECRET=value, TOKEN=value, PASSWORD=value patterns
    .replace(/\b(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|ACCESS_KEY|PRIVATE_KEY)(\s*=\s*)\S+/gi, '$1$2***')
    // export VAR=value
    .replace(/(export\s+\w*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH)\w*\s*=\s*)\S+/gi, '$1***')
    // Bearer tokens
    .replace(/(Bearer\s+)\S+/gi, '$1***')
    // -p password flags
    .replace(/(-p\s+)\S+/g, '$1***')
    // --password=value
    .replace(/(--password[=\s]+)\S+/gi, '$1***')
    // connection strings with passwords
    .replace(/:\/\/([^:]+):([^@]+)@/g, '://$1:***@');
}

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
      // No session - still allow execution
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    if (!session_id) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const command = redactSecrets((data.command || '').slice(0, 2000));
    const cwd = data.cwd || '';

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2000);

    // Output allow immediately so Cursor doesn't wait
    process.stdout.write(JSON.stringify({ continue: true }));

    // Then save observation (awaited to ensure it completes before exit)
    await fetch(`${BASE_URL}/api/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': getAuthToken() },
      body: JSON.stringify({
        session_id,
        tool_name: 'Shell',
        tool_input: command,
        tool_output: '',
        cwd,
        duration_ms: 0,
        prompt_number,
      }),
      signal: controller.signal,
    }).catch(() => {});
  } catch {
    // On error, still allow execution
    process.stdout.write(JSON.stringify({ continue: true }));
  }
  process.exit(0);
}

main();
