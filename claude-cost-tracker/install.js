#!/usr/bin/env node
'use strict';

// Adds this tool's hook entries to Claude Code's settings.json — strictly
// additive. Claude Code's `hooks` field is `{ [eventName]: HookEntry[] }`;
// multiple entries can coexist under the same event name and Claude Code
// runs all of them, so this only ever pushes a new entry onto the existing
// array. Every pre-existing entry (your other hooks) and every other
// top-level settings key is left exactly as it was.
//
// Usage:
//   node install.js              # add hooks to ~/.claude/settings.json
//   node install.js --project    # add hooks to ./.claude/settings.json instead
//   node install.js --uninstall  # remove only this tool's entries
//   node install.js --uninstall --project

const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const projectScoped = args.includes('--project');

const settingsPath = projectScoped
  ? path.join(process.cwd(), '.claude', 'settings.json')
  : path.join(os.homedir(), '.claude', 'settings.json');

const collectorPath = path.join(__dirname, 'collector.js');

const EVENTS = [
  { name: 'PreToolUse', subcommand: 'pre-tool' },
  { name: 'PostToolUse', subcommand: 'post-tool' },
  { name: 'Stop', subcommand: 'stop' },
  { name: 'UserPromptSubmit', subcommand: 'prompt' },
];

function commandFor(subcommand) {
  return `node "${collectorPath}" ${subcommand}`;
}

function loadSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf-8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

function hasOurCommand(entry, command) {
  return Array.isArray(entry.hooks) && entry.hooks.some((h) => h.command === command);
}

function main() {
  const settings = loadSettings();
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};

  let changed = false;

  for (const { name, subcommand } of EVENTS) {
    const command = commandFor(subcommand);
    const existing = Array.isArray(settings.hooks[name]) ? settings.hooks[name] : [];
    const alreadyPresent = existing.some((entry) => hasOurCommand(entry, command));

    if (uninstall) {
      if (!alreadyPresent) {
        console.log(`${name}: no claude-cost-tracker entry found — nothing to remove`);
        continue;
      }
      const filtered = existing.filter((entry) => !hasOurCommand(entry, command));
      settings.hooks[name] = filtered;
      console.log(`${name}: removed claude-cost-tracker entry (${existing.length} -> ${filtered.length} entries)`);
      changed = true;
      continue;
    }

    if (alreadyPresent) {
      console.log(`${name}: claude-cost-tracker entry already present — skipping`);
      continue;
    }

    settings.hooks[name] = [...existing, { hooks: [{ type: 'command', command }] }];
    console.log(
      `${name}: adding claude-cost-tracker entry (${existing.length} existing entr${existing.length === 1 ? 'y' : 'ies'} untouched)`,
    );
    changed = true;
  }

  if (!changed) {
    console.log('\nNothing to do.');
    return;
  }

  saveSettings(settings);
  console.log(`\nWrote ${settingsPath}`);

  if (!uninstall) {
    console.log('Restart Claude Code (or start a new session) for the hooks to take effect.');
    console.log(`Cost log will be written to: ${path.join(__dirname, 'cost-log.jsonl')}`);
    console.log('Run "npm run watch" (or "node watcher.js") in a separate terminal to start tracking.');
  }
}

main();
