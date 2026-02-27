#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CURSOR_DIR = path.join(os.homedir(), '.cursor');
const CURSOR_HOOKS_PATH = path.join(CURSOR_DIR, 'hooks.json');
const CURSOR_MCP_PATH = path.join(CURSOR_DIR, 'mcp.json');

function main() {
  console.log('');
  console.log('  memory-assistant uninstaller');
  console.log('  ===========================');
  console.log('');

  // 1. Remove Cursor Hooks
  console.log('  [1/2] Removing Cursor hooks...');
  if (fs.existsSync(CURSOR_HOOKS_PATH)) {
    try {
      const cursorHooks = JSON.parse(fs.readFileSync(CURSOR_HOOKS_PATH, 'utf8'));
      if (cursorHooks.hooks) {
        const hookNames = Object.keys(cursorHooks.hooks);
        for (const hookName of hookNames) {
          cursorHooks.hooks[hookName] = cursorHooks.hooks[hookName].filter(
            h => !h.command || !h.command.includes('memory-assistant')
          );
          if (cursorHooks.hooks[hookName].length === 0) {
            delete cursorHooks.hooks[hookName];
          }
        }
        fs.writeFileSync(CURSOR_HOOKS_PATH, JSON.stringify(cursorHooks, null, 2));
        console.log('        Hooks removed');
      }
    } catch {
      console.warn('        Warning: Could not parse hooks.json');
    }
  } else {
    console.log('        No hooks.json found, skipping');
  }

  // 2. Remove MCP Server
  console.log('  [2/2] Removing MCP server...');
  if (fs.existsSync(CURSOR_MCP_PATH)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(CURSOR_MCP_PATH, 'utf8'));
      if (mcpConfig.mcpServers && mcpConfig.mcpServers['memory-assistant']) {
        delete mcpConfig.mcpServers['memory-assistant'];
        fs.writeFileSync(CURSOR_MCP_PATH, JSON.stringify(mcpConfig, null, 2));
        console.log('        MCP server removed');
      } else {
        console.log('        MCP server not found, skipping');
      }
    } catch {
      console.warn('        Warning: Could not parse mcp.json');
    }
  } else {
    console.log('        No mcp.json found, skipping');
  }

  console.log('');
  console.log('  memory-assistant uninstalled.');
  console.log('');
  console.log('  Note:');
  console.log('    - ~/.memory-assistant/ (database) was NOT deleted.');
  console.log('      To remove all data: rm -rf ~/.memory-assistant');
  console.log('    - Restart Cursor to apply changes.');
  console.log('');
}

main();
