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
const SESSION_DIR = path.join(os.homedir(), '.memory-assistant');
const SESSION_FILE = path.join(SESSION_DIR, 'current-session.json');
const AUTH_TOKEN_FILE = path.join(SESSION_DIR, 'auth-token');

function getAuthToken() {
  try { return fs.readFileSync(AUTH_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

const SENSITIVE_FILE_PATTERNS = [/\.env($|\.)/, /credentials\.json$/, /\.pem$/, /\.key$/, /\.secret$/, /id_rsa/];

function isSensitiveFile(filePath) {
  const basename = path.basename(filePath);
  return SENSITIVE_FILE_PATTERNS.some(p => p.test(basename));
}

function redactSecrets(text) {
  if (!text) return text;
  return text
    .replace(/\b(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|ACCESS_KEY|PRIVATE_KEY)(\s*=\s*)\S+/gi, '$1$2***')
    .replace(/(export\s+\w*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH)\w*\s*=\s*)\S+/gi, '$1***')
    .replace(/(Bearer\s+)\S+/gi, '$1***')
    .replace(/(-p\s+)\S+/g, '$1***')
    .replace(/(--password[=\s]+)\S+/gi, '$1***')
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
      process.exit(0);
    }

    if (!session_id) {
      process.exit(0);
    }

    // Build observation from file edit data
    const filePath = data.file_path || '';

    // Skip sensitive files entirely
    if (isSensitiveFile(filePath)) {
      process.exit(0);
    }

    const edits = data.edits || [];
    const editSummary = edits.map(e => {
      const old = redactSecrets((e.old_string || '').slice(0, 100));
      const new_ = redactSecrets((e.new_string || '').slice(0, 100));
      return `${old} → ${new_}`;
    }).join('; ').slice(0, 500);

    const tool_input = JSON.stringify({ file_path: filePath, edit_count: edits.length }).slice(0, 2000);
    const tool_output = redactSecrets(JSON.stringify({ edits: editSummary }).slice(0, 2000));

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);

    await fetch(`${BASE_URL}/api/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-auth-token': getAuthToken() },
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
