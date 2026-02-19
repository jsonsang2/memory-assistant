#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const CURSOR_HOOKS_PATH = path.join(os.homedir(), '.cursor', 'hooks.json');
const MA_DIR = path.join(os.homedir(), '.memory-assistant');

function main() {
  console.log('Installing memory-assistant...\n');

  // 1. Create ~/.memory-assistant/ directory
  if (!fs.existsSync(MA_DIR)) {
    fs.mkdirSync(MA_DIR, { recursive: true });
    console.log(`✓ Created ${MA_DIR}`);
  }

  // 2. Read existing ~/.cursor/hooks.json or create empty
  let cursorHooks = { version: 1, hooks: {} };
  const cursorDir = path.join(os.homedir(), '.cursor');
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }
  if (fs.existsSync(CURSOR_HOOKS_PATH)) {
    try {
      cursorHooks = JSON.parse(fs.readFileSync(CURSOR_HOOKS_PATH, 'utf8'));
      console.log(`✓ Read existing ${CURSOR_HOOKS_PATH}`);
    } catch (e) {
      console.warn(`Warning: Could not parse existing hooks.json, creating fresh`);
    }
  }

  // 3. Merge memory-assistant hooks
  if (!cursorHooks.hooks) cursorHooks.hooks = {};

  const hooksToAdd = {
    sessionStart: `node ${PLUGIN_DIR}/hooks/session-start.js`,
    postToolUse:  `node ${PLUGIN_DIR}/hooks/post-tool-use.js`,
    stop:         `node ${PLUGIN_DIR}/hooks/stop.js`,
    sessionEnd:   `node ${PLUGIN_DIR}/hooks/session-end.js`,
  };

  for (const [hookName, command] of Object.entries(hooksToAdd)) {
    if (!cursorHooks.hooks[hookName]) {
      cursorHooks.hooks[hookName] = [];
    }
    // Avoid duplicate entries
    const alreadyRegistered = cursorHooks.hooks[hookName].some(
      h => h.command && h.command.includes('memory-assistant')
    );
    if (!alreadyRegistered) {
      cursorHooks.hooks[hookName].push({ command });
      console.log(`✓ Registered ${hookName} hook`);
    } else {
      console.log(`  (skipped ${hookName} - already registered)`);
    }
  }

  // 4. Write back
  fs.writeFileSync(CURSOR_HOOKS_PATH, JSON.stringify(cursorHooks, null, 2));
  console.log(`\n✓ Saved ${CURSOR_HOOKS_PATH}`);

  // 5. Build and install VSCode Extension (uses Cursor built-in model, no API key needed)
  const EXT_SRC_DIR = path.join(PLUGIN_DIR, 'vscode-extension');
  const EXT_VERSION = JSON.parse(fs.readFileSync(path.join(EXT_SRC_DIR, 'package.json'), 'utf8')).version;
  const EXT_DEST_DIR = path.join(os.homedir(), '.cursor', 'extensions', `memory-assistant-vscode-${EXT_VERSION}`);

  try {
    // Build extension if dist doesn't exist or is outdated
    const distPath = path.join(EXT_SRC_DIR, 'dist', 'extension.js');
    if (!fs.existsSync(distPath)) {
      console.log('Building VSCode Extension...');
      execSync('npm install && npm run build', { cwd: EXT_SRC_DIR, stdio: 'inherit' });
    }

    // Copy to ~/.cursor/extensions/
    if (fs.existsSync(EXT_DEST_DIR)) {
      fs.rmSync(EXT_DEST_DIR, { recursive: true });
    }
    fs.mkdirSync(path.join(EXT_DEST_DIR, 'dist'), { recursive: true });
    fs.copyFileSync(path.join(EXT_SRC_DIR, 'package.json'), path.join(EXT_DEST_DIR, 'package.json'));
    fs.copyFileSync(distPath, path.join(EXT_DEST_DIR, 'dist', 'extension.js'));

    console.log(`✓ VSCode Extension installed → ${EXT_DEST_DIR}`);
    console.log('  AI summarization uses Cursor built-in model (no ANTHROPIC_API_KEY needed)');
  } catch (e) {
    console.warn('⚠️  VSCode Extension install failed:', e.message);
    console.warn('   Run manually: cd vscode-extension && npm install && npm run build');
  }

  // 6. Optional: Anthropic SDK fallback info
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('\n✓ ANTHROPIC_API_KEY detected (used as fallback if VSCode Extension is unavailable)');
  }

  console.log('\n✅ memory-assistant installed successfully!');
  console.log('   Restart Cursor to activate.\n');
  console.log('   To uninstall: node scripts/uninstall.js\n');
}

main();
