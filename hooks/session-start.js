#!/usr/bin/env node
// session-start.js - Cursor sessionStart hook
// Input (stdin): { session_id?, is_background_agent, composer_mode }
// Output (stdout): { "additional_context": "..." }

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
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
  } catch {
    // ignore spawn errors
  }
}

async function isChromaRunning() {
  const result = await safeFetch(`${CHROMA_URL}/api/v2/auth/identity`, {}, 500);
  return result !== null;
}

function findChromaBinary() {
  // uv tool install puts chroma here by default
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'chroma'),
    '/usr/local/bin/chroma',
    '/opt/homebrew/bin/chroma',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback: hope it's in PATH
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
  } catch {
    // ignore spawn errors
  }
}

function formatContext(recent) {
  if (!recent || !Array.isArray(recent) || recent.length === 0) {
    return '';
  }
  const lines = ['Recent memory-assistant context:'];
  for (const item of recent) {
    // Prefer prompt-level summaries over session-level
    let promptSummaries = [];
    try {
      if (item.prompt_summaries) {
        promptSummaries = JSON.parse(item.prompt_summaries);
      }
    } catch {}

    if (Array.isArray(promptSummaries) && promptSummaries.length > 0 && promptSummaries[0].summary) {
      lines.push(`Session (${item.started_at || 'unknown'}):`);
      for (const ps of promptSummaries) {
        lines.push(`  - Prompt #${ps.prompt_number}: ${ps.summary}`);
      }
    } else {
      const summary = item.summary || item.content || item.observation || JSON.stringify(item);
      lines.push(`- ${summary}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  try {
    // Read stdin (we don't use most fields, but parse anyway)
    await readStdin();

    const projectPath =
      process.env.CURSOR_PROJECT_DIR ||
      process.env.CLAUDE_PROJECT_DIR ||
      process.cwd();

    const session_id = crypto.randomUUID();
    const started_at = new Date().toISOString();

    // Ensure session dir exists
    fs.mkdirSync(SESSION_DIR, { recursive: true });

    // Check if ChromaDB is running, spawn if not (fire-and-forget)
    const chromaRunning = await isChromaRunning();
    if (!chromaRunning) {
      spawnChroma();
    }

    // Check if worker is running, spawn if not
    const running = await isWorkerRunning();
    if (!running) {
      spawnWorker();
      // Give worker a moment to start before continuing
      await new Promise(r => setTimeout(r, 300));
    }

    // Write session file (overwrite if exists)
    const sessionData = { session_id, project_path: projectPath, started_at, prompt_number: 1 };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData));

    // Non-blocking: register session with worker
    safeFetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionData),
    }, 500).catch(() => {});

    // Fetch recent context
    const encodedPath = encodeURIComponent(projectPath);
    const recent = await safeFetch(
      `${BASE_URL}/api/context/recent?project=${encodedPath}&limit=5`,
      {},
      1000
    );

    const contextString = formatContext(recent);

    process.stdout.write(JSON.stringify({ additional_context: contextString }));
  } catch {
    process.stdout.write(JSON.stringify({ additional_context: '' }));
  }
  process.exit(0);
}

main();
