#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const CURSOR_DIR = path.join(os.homedir(), '.cursor');
const CURSOR_HOOKS_PATH = path.join(CURSOR_DIR, 'hooks.json');
const CURSOR_MCP_PATH = path.join(CURSOR_DIR, 'mcp.json');
const MA_DIR = path.join(os.homedir(), '.memory-assistant');
const IS_WINDOWS = process.platform === 'win32';

/**
 * Set owner-only permissions on a file or directory.
 * Unix: mode 0o700 (dir) / 0o600 (file)
 * Windows: icacls to grant current user Full and remove inheritance
 */
function setOwnerOnly(targetPath, isDir) {
  if (IS_WINDOWS) {
    try {
      const username = os.userInfo().username;
      // Remove inherited permissions + grant only current user
      execSync(`icacls "${targetPath}" /inheritance:r /grant:r "${username}:(OI)(CI)F" /T /Q`, { stdio: 'pipe' });
    } catch {
      console.warn(`        Warning: Could not set Windows ACL on ${targetPath}`);
    }
  } else {
    try {
      fs.chmodSync(targetPath, isDir ? 0o700 : 0o600);
    } catch {}
  }
}

/**
 * Attempt to install ChromaDB via pip.
 * Returns true if installed successfully, false if Python/pip not available.
 */
function installChromaDB() {
  // Find a working pip command
  const pipCandidates = IS_WINDOWS
    ? ['pip', 'pip3', 'python -m pip', 'python3 -m pip']
    : ['pip3', 'pip', 'python3 -m pip', 'python -m pip'];

  let pipCmd = null;
  for (const cmd of pipCandidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'pipe', timeout: 10000 });
      pipCmd = cmd;
      break;
    } catch {}
  }

  if (!pipCmd) return false;

  // Check if chromadb is already installed
  try {
    execSync(`${pipCmd} show chromadb`, { stdio: 'pipe', timeout: 10000 });
    console.log('        ChromaDB already installed');
    return true;
  } catch {}

  // Install chromadb
  try {
    execSync(`${pipCmd} install chromadb`, { stdio: 'pipe', timeout: 300000 });
    return true;
  } catch (e) {
    console.warn('        Warning: pip install chromadb failed');
    return false;
  }
}

function main() {
  console.log('');
  console.log('  memory-assistant installer');
  console.log('  =========================');
  console.log('');

  // 1. Create ~/.memory-assistant/ with secure permissions
  if (!fs.existsSync(MA_DIR)) {
    fs.mkdirSync(MA_DIR, { recursive: true });
    setOwnerOnly(MA_DIR, true);
    console.log('  [1/7] Created ~/.memory-assistant/ (owner-only access)');
  } else {
    console.log('  [1/7] ~/.memory-assistant/ already exists');
  }

  // 2. Build Worker
  console.log('  [2/7] Building Worker...');
  try {
    execSync('npm install && npm run build', {
      cwd: path.join(PLUGIN_DIR, 'worker'),
      stdio: 'pipe',
    });
    console.log('        Worker built successfully');
  } catch (e) {
    console.error('        ERROR: Worker build failed');
    console.error('        Run manually: cd worker && npm install && npm run build');
    process.exit(1);
  }

  // 3. Build MCP Server
  console.log('  [3/7] Building MCP Server...');
  try {
    execSync('npm install && npm run build', {
      cwd: path.join(PLUGIN_DIR, 'mcp'),
      stdio: 'pipe',
    });
    console.log('        MCP Server built successfully');
  } catch (e) {
    console.error('        ERROR: MCP build failed');
    console.error('        Run manually: cd mcp && npm install && npm run build');
    process.exit(1);
  }

  // 4. Register Cursor Hooks
  console.log('  [4/7] Registering Cursor hooks...');
  if (!fs.existsSync(CURSOR_DIR)) {
    fs.mkdirSync(CURSOR_DIR, { recursive: true });
  }

  let cursorHooks = { version: 1, hooks: {} };
  if (fs.existsSync(CURSOR_HOOKS_PATH)) {
    // Backup before modifying
    const backupPath = CURSOR_HOOKS_PATH + '.bak';
    fs.copyFileSync(CURSOR_HOOKS_PATH, backupPath);
    console.log(`        Backed up hooks.json → hooks.json.bak`);
    try {
      cursorHooks = JSON.parse(fs.readFileSync(CURSOR_HOOKS_PATH, 'utf8'));
    } catch {
      console.error('        ERROR: Could not parse existing hooks.json. Backup saved at hooks.json.bak');
      console.error('        Aborting hook registration to avoid data loss.');
      process.exit(1);
    }
  }
  if (!cursorHooks.hooks) cursorHooks.hooks = {};

  const hooksToAdd = {
    beforeSubmitPrompt:   `node ${PLUGIN_DIR}/hooks/before-submit-prompt.js`,
    afterFileEdit:        `node ${PLUGIN_DIR}/hooks/after-file-edit.js`,
    beforeShellExecution: `node ${PLUGIN_DIR}/hooks/before-shell-execution.js`,
    stop:                 `node ${PLUGIN_DIR}/hooks/stop.js`,
  };

  // Remove old memory-assistant hooks (Claude Code names)
  const oldHookNames = ['sessionStart', 'userPromptSubmit', 'postToolUse', 'sessionEnd'];
  for (const hookName of oldHookNames) {
    if (cursorHooks.hooks[hookName]) {
      cursorHooks.hooks[hookName] = cursorHooks.hooks[hookName].filter(
        h => !h.command || !h.command.includes('memory-assistant')
      );
      if (cursorHooks.hooks[hookName].length === 0) {
        delete cursorHooks.hooks[hookName];
      }
    }
  }

  for (const [hookName, command] of Object.entries(hooksToAdd)) {
    if (!cursorHooks.hooks[hookName]) {
      cursorHooks.hooks[hookName] = [];
    }
    // Remove existing memory-assistant entry and re-add (in case path changed)
    cursorHooks.hooks[hookName] = cursorHooks.hooks[hookName].filter(
      h => !h.command || !h.command.includes('memory-assistant')
    );
    cursorHooks.hooks[hookName].push({ command });
  }

  fs.writeFileSync(CURSOR_HOOKS_PATH, JSON.stringify(cursorHooks, null, 2));
  console.log('        Hooks registered: beforeSubmitPrompt, afterFileEdit, beforeShellExecution, stop');

  // 5. Install ChromaDB (optional — skipped if Python/pip unavailable)
  console.log('  [5/7] Installing ChromaDB for semantic search...');
  const chromaInstalled = installChromaDB();
  if (chromaInstalled) {
    console.log('        ChromaDB installed successfully');
  } else {
    console.log('        Skipped: Python/pip not found. Semantic search disabled.');
    console.log('        To enable later: pip install chromadb');
  }

  // 6. Register MCP Server
  console.log('  [6/7] Registering MCP server...');
  let mcpConfig = { mcpServers: {} };
  if (fs.existsSync(CURSOR_MCP_PATH)) {
    // Backup before modifying
    const mcpBackupPath = CURSOR_MCP_PATH + '.bak';
    fs.copyFileSync(CURSOR_MCP_PATH, mcpBackupPath);
    console.log(`        Backed up mcp.json → mcp.json.bak`);
    try {
      mcpConfig = JSON.parse(fs.readFileSync(CURSOR_MCP_PATH, 'utf8'));
    } catch {
      console.error('        ERROR: Could not parse existing mcp.json. Backup saved at mcp.json.bak');
      console.error('        Aborting MCP registration to avoid data loss.');
      process.exit(1);
    }
  }
  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};

  mcpConfig.mcpServers['memory-assistant'] = {
    command: 'node',
    args: [path.join(PLUGIN_DIR, 'mcp', 'dist', 'index.js')],
  };

  fs.writeFileSync(CURSOR_MCP_PATH, JSON.stringify(mcpConfig, null, 2));
  console.log('        MCP server registered: memory-assistant');

  // 7. Done
  console.log('');
  console.log('  [7/7] Installation complete!');
  console.log('');
  console.log('  ✅ memory-assistant installed successfully!');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Restart Cursor');
  console.log('    2. (Optional) Set ANTHROPIC_API_KEY for AI summarization');
  if (!chromaInstalled) {
    console.log('    3. (Optional) Install ChromaDB for semantic search:');
    console.log('       pip install chromadb');
  }
  console.log('');
  console.log('  To uninstall: node scripts/uninstall.js');
  console.log('');
}

main();
