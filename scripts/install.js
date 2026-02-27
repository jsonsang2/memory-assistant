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

function main() {
  console.log('');
  console.log('  memory-assistant installer');
  console.log('  =========================');
  console.log('');

  // 1. Create ~/.memory-assistant/ with secure permissions
  if (!fs.existsSync(MA_DIR)) {
    fs.mkdirSync(MA_DIR, { recursive: true, mode: 0o700 });
    console.log('  [1/5] Created ~/.memory-assistant/ (mode 700)');
  } else {
    console.log('  [1/5] ~/.memory-assistant/ already exists');
  }

  // 2. Build Worker
  console.log('  [2/5] Building Worker...');
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
  console.log('  [3/5] Building MCP Server...');
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
  console.log('  [4/5] Registering Cursor hooks...');
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

  // 5. Register MCP Server
  console.log('  [5/5] Registering MCP server...');
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

  // Done
  console.log('');
  console.log('  ✅ memory-assistant installed successfully!');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Restart Cursor');
  console.log('    2. (Optional) Set ANTHROPIC_API_KEY for AI summarization');
  console.log('    3. (Optional) Install ChromaDB for semantic search:');
  console.log('       pip install chromadb');
  console.log('');
  console.log('  To uninstall: node scripts/uninstall.js');
  console.log('');
}

main();
