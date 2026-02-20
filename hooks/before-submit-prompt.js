#!/usr/bin/env node
// before-submit-prompt.js - Cursor beforeSubmitPrompt hook
// Input (stdin): { conversation_id, generation_id, prompt, attachments, workspace_roots }
// Replaces session-start.js + user-prompt-submit.js for Cursor

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const child_process = require('child_process');

const PORT = process.env.MEMORY_ASSISTANT_PORT || 37888;
const CHROMA_PORT = process.env.CHROMA_PORT || 8000;
const BASE_URL = `http://localhost:${PORT}`;
const CHROMA_URL = `http://localhost:${CHROMA_PORT}`;
const SESSION_DIR = path.join(os.homedir(), '.memory-assistant');
const SESSION_FILE = path.join(SESSION_DIR, 'current-session.json');
const PID_FILE = path.join(SESSION_DIR, 'worker.pid');
const CHROMA_PID_FILE = path.join(SESSION_DIR, 'chroma.pid');
const CHROMA_DATA_DIR = path.join(SESSION_DIR, 'chroma');
const WORKER_DIST_PATH = path.join(__dirname, '..', 'worker', 'dist', 'server.js');

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

async function safeFetch(url, options = {}, timeoutMs = 3000) {
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

async function isWorkerRunning() {
  const result = await safeFetch(`${BASE_URL}/api/health`, {}, 500);
  return result !== null;
}

function spawnWorker() {
  try {
    const workerProcess = child_process.spawn('node', [WORKER_DIST_PATH], {
      detached: true,
      stdio: 'ignore',
    });
    workerProcess.unref();
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(workerProcess.pid));
  } catch {}
}

async function isChromaRunning() {
  const result = await safeFetch(`${CHROMA_URL}/api/v2/auth/identity`, {}, 500);
  return result !== null;
}

function findChromaBinary() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'chroma'),
    '/usr/local/bin/chroma',
    '/opt/homebrew/bin/chroma',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'chroma';
}

function spawnChroma() {
  try {
    fs.mkdirSync(CHROMA_DATA_DIR, { recursive: true });
    const chromaBin = findChromaBinary();
    const chromaProcess = child_process.spawn(
      chromaBin,
      ['run', '--path', CHROMA_DATA_DIR, '--host', 'localhost', '--port', String(CHROMA_PORT)],
      { detached: true, stdio: 'ignore' }
    );
    chromaProcess.unref();
    fs.writeFileSync(CHROMA_PID_FILE, String(chromaProcess.pid));
  } catch {}
}

async function main() {
  try {
    const data = await readStdin();
    const conversationId = data.conversation_id;
    const userPrompt = (data.prompt || '').slice(0, 2000);

    if (!conversationId) {
      process.exit(0);
    }

    const projectPath = (data.workspace_roots && data.workspace_roots[0]) || process.cwd();

    // Ensure session dir exists
    fs.mkdirSync(SESSION_DIR, { recursive: true });

    // Auto-start ChromaDB if not running
    const chromaRunning = await isChromaRunning();
    if (!chromaRunning) {
      spawnChroma();
    }

    // Auto-start worker if not running
    const running = await isWorkerRunning();
    if (!running) {
      spawnWorker();
      await new Promise(r => setTimeout(r, 300));
    }

    // Check if this is the same conversation or a new one
    let sessionData;
    let isNewSession = true;
    try {
      sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (sessionData.session_id === conversationId) {
        // Same conversation, new prompt
        isNewSession = false;
        sessionData.prompt_number = (sessionData.prompt_number || 0) + 1;
      }
    } catch {
      sessionData = null;
    }

    if (isNewSession) {
      // New conversation
      sessionData = {
        session_id: conversationId,
        project_path: projectPath,
        started_at: new Date().toISOString(),
        prompt_number: 1,
      };

      // Register session with worker
      await safeFetch(`${BASE_URL}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionData),
      }, 2000);
    }

    // Write updated session file
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData));

    // Save user prompt
    if (userPrompt) {
      await safeFetch(`${BASE_URL}/api/prompts/user-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: conversationId,
          prompt_number: sessionData.prompt_number,
          user_prompt: userPrompt,
        }),
      }, 2000);
    }
  } catch {}
  process.exit(0);
}

main();
