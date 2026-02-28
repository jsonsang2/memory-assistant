#!/usr/bin/env node
// before-submit-prompt.js - Cursor beforeSubmitPrompt hook
// Input (stdin): { conversation_id, generation_id, prompt, attachments, workspace_roots }
// Replaces session-start.js + user-prompt-submit.js for Cursor

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
const AUTH_TOKEN_FILE = path.join(SESSION_DIR, 'auth-token');
const CHROMA_PID_FILE = path.join(SESSION_DIR, 'chroma.pid');
const CHROMA_DATA_DIR = path.join(SESSION_DIR, 'chroma');
const WORKER_DIST_PATH = path.join(__dirname, '..', 'worker', 'dist', 'server.js');
const WORKER_LOG_FILE = path.join(SESSION_DIR, 'worker.log');

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data.replace(/^\uFEFF/, ''))); } catch { resolve({}); }
    });
    process.stdin.on('error', () => resolve({}));
    setTimeout(() => resolve({}), 1000);
  });
}

function setOwnerOnlyFile(filePath) {
  if (process.platform === 'win32') {
    try {
      const username = require('os').userInfo().username;
      require('child_process').execSync(
        `icacls "${filePath}" /inheritance:r /grant:r "${username}:F" /Q`,
        { stdio: 'pipe' }
      );
    } catch {}
  } else {
    try { fs.chmodSync(filePath, 0o600); } catch {}
  }
}

function ensureAuthToken() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  if (!fs.existsSync(AUTH_TOKEN_FILE)) {
    const token = crypto.randomUUID();
    fs.writeFileSync(AUTH_TOKEN_FILE, token);
    setOwnerOnlyFile(AUTH_TOKEN_FILE);
    return token;
  }
  return fs.readFileSync(AUTH_TOKEN_FILE, 'utf8').trim();
}

function getAuthToken() {
  try {
    return fs.readFileSync(AUTH_TOKEN_FILE, 'utf8').trim();
  } catch {
    return ensureAuthToken();
  }
}

async function safeFetch(url, options = {}, timeoutMs = 3000) {
  const token = getAuthToken();
  const headers = { ...options.headers, 'x-auth-token': token };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, headers, signal: controller.signal });
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
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    // Open a log file for worker stderr so crashes are diagnosable
    const logFd = fs.openSync(WORKER_LOG_FILE, 'a');
    const spawnOpts = {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      cwd: path.join(__dirname, '..', 'worker'),
    };
    const workerProcess = child_process.spawn('node', [WORKER_DIST_PATH], spawnOpts);
    workerProcess.unref();
    fs.closeSync(logFd);
    fs.writeFileSync(PID_FILE, String(workerProcess.pid));
  } catch {}
}

async function isChromaRunning() {
  const result = await safeFetch(`${CHROMA_URL}/api/v2/auth/identity`, {}, 500);
  return result !== null;
}

function findChromaBinary() {
  const isWin = process.platform === 'win32';

  // Static candidates (no globs)
  const staticCandidates = isWin
    ? [path.join(os.homedir(), '.local', 'bin', 'chroma.exe')]
    : [
        path.join(os.homedir(), '.local', 'bin', 'chroma'),
        '/usr/local/bin/chroma',
        '/opt/homebrew/bin/chroma',
      ];

  for (const p of staticCandidates) {
    if (fs.existsSync(p)) return p;
  }

  // Windows: scan known Python install directories for chroma.exe
  if (isWin) {
    // Standard Python installer (e.g. Python312/Scripts)
    const programsDir = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python');
    const found1 = findFileRecursive(programsDir, 'chroma.exe', 3);
    if (found1) return found1;

    // Microsoft Store Python (e.g. PythonSoftwareFoundation.Python.3.13_.../LocalCache/local-packages/Python313/Scripts)
    const packagesDir = path.join(os.homedir(), 'AppData', 'Local', 'Packages');
    try {
      const pyPkgs = fs.readdirSync(packagesDir).filter(e => e.startsWith('PythonSoftwareFoundation.Python'));
      for (const pkg of pyPkgs) {
        const found2 = findFileRecursive(path.join(packagesDir, pkg), 'chroma.exe', 5);
        if (found2) return found2;
      }
    } catch {}
  }

  // Fallback: try system PATH via where/which
  try {
    const cmd = isWin ? 'where chroma' : 'which chroma';
    const result = child_process.execSync(cmd, { stdio: 'pipe', timeout: 3000 }).toString().trim();
    const firstLine = result.split(/\r?\n/)[0];
    if (firstLine && fs.existsSync(firstLine)) return firstLine;
  } catch {}

  return 'chroma';
}

function findFileRecursive(dir, filename, maxDepth) {
  if (maxDepth <= 0) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === filename) return fullPath;
      if (entry.isDirectory()) {
        const found = findFileRecursive(fullPath, filename, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

function spawnChroma() {
  try {
    fs.mkdirSync(CHROMA_DATA_DIR, { recursive: true });
    const chromaBin = findChromaBinary();
    const chromaProcess = child_process.spawn(
      chromaBin,
      ['run', '--path', CHROMA_DATA_DIR, '--host', 'localhost', '--port', String(CHROMA_PORT)],
      { detached: true, stdio: 'ignore', windowsHide: true }
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

    // Ensure auth token exists early (before any early exit)
    ensureAuthToken();

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
