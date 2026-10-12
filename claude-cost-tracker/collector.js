#!/usr/bin/env node
'use strict';

// Hook entrypoint Claude Code invokes on PreToolUse / PostToolUse / Stop /
// UserPromptSubmit. Deliberately fast: read the hook JSON from stdin, write
// one line to this session's buffer file, exit. All real work (transcript
// tailing, cost calculation, task detection, anti-pattern detection)
// happens in watcher.js — never here, and never anything that could block
// or fail Claude Code.
//
// Beyond the original mode/timestamp/sessionId/transcriptPath fields, this
// also now extracts per-tool-call detail (tool name, file path, command,
// test/build/lint classification, success) needed for anti-pattern
// detection in anti-patterns.js. Extraction is best-effort and defensive —
// an unrecognized tool or a missing field just means fewer fields on the
// event, never an error.

const fs = require('fs');
const path = require('path');

const BUFFER_DIR = path.join(__dirname, 'buffer');
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

// Same classification regexes Preflight uses (ported, not copied — that
// repo's shared code is vendored and off-limits to edit, and this tool has
// no dependency on it).
const TEST_COMMAND_RE =
  /\b(jest|vitest|mocha|pytest|go\s+test|npm\s+test|npm\s+run\s+test|npx\s+jest|npx\s+vitest|cargo\s+test|bun\s+test|bun\s+run\s+test|pnpm\s+test|pnpm\s+run\s+test|yarn\s+test)\b/i;
const BUILD_COMMAND_RE =
  /\b(tsc|npm\s+run\s+build|make\b|cargo\s+build|go\s+build|webpack|vite\s+build)\b/i;
const LINT_COMMAND_RE =
  /\b(eslint|prettier|pylint|golangci-lint|rubocop|clippy|biome\s+(check|lint))\b/i;

// Reading /dev/stdin directly avoids an EAGAIN some platforms raise when
// reading fd 0 synchronously while it's a pipe; fall back to the fd on
// platforms (e.g. native Windows) where /dev/stdin doesn't exist.
function readStdinSync() {
  if (process.platform === 'win32') {
    return fs.readFileSync(0, 'utf-8');
  }
  try {
    return fs.readFileSync('/dev/stdin', 'utf-8');
  } catch {
    return fs.readFileSync(0, 'utf-8');
  }
}

/** Extract only what anti-pattern detection needs from tool_input, for the PreToolUse side. */
function extractInputFields(toolName, input) {
  const fields = {};
  if (input === null || input === undefined || typeof input !== 'object') return fields;

  if (typeof input.file_path === 'string') fields.filePath = input.file_path;

  if (toolName === 'Bash' && typeof input.command === 'string') {
    fields.command = input.command;
    fields.isTestCommand = TEST_COMMAND_RE.test(input.command);
    fields.isBuildCommand = BUILD_COMMAND_RE.test(input.command);
    fields.isLintCommand = LINT_COMMAND_RE.test(input.command);
  }

  return fields;
}

/** Extract only what anti-pattern detection needs from tool_response, for the PostToolUse side. */
function extractOutputFields(toolName, output) {
  const fields = {};
  if (output === null || output === undefined || typeof output !== 'object') return fields;

  if (toolName === 'Bash') {
    if (typeof output.exitCode === 'number') fields.success = output.exitCode === 0;
    else if (typeof output.exitCode === 'string') {
      const parsed = Number(output.exitCode);
      if (!Number.isNaN(parsed)) fields.success = parsed === 0;
    }
  } else if (toolName === 'Edit') {
    // Claude Code's own Edit tool sets tool_response.success: false when a
    // find-and-replace doesn't match — a genuine failure worth surfacing.
    if (typeof output.success === 'boolean') fields.success = output.success;
  } else if (toolName === 'Agent') {
    if (typeof output.interrupted === 'boolean') fields.agentInterrupted = output.interrupted;
    if (typeof output.completed === 'boolean' && output.completed === false) {
      fields.success = false;
    }
  }

  return fields;
}

function main() {
  const raw = readStdinSync();
  if (!raw.trim()) return;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return; // malformed input — never block Claude Code
  }

  const sessionId = data.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    return; // no usable session id to key the buffer file on
  }

  const eventName =
    typeof data.hook_event_name === 'string' ? data.hook_event_name.toLowerCase() : 'unknown';
  const toolName = typeof data.tool_name === 'string' ? data.tool_name : undefined;
  const toolUseId = typeof data.tool_use_id === 'string' ? data.tool_use_id : undefined;

  const event = {
    mode: eventName,
    timestamp: Date.now(),
    sessionId,
  };
  if (typeof data.transcript_path === 'string' && data.transcript_path.length > 0) {
    event.transcriptPath = data.transcript_path;
  }
  if (toolName) event.toolName = toolName;
  if (toolUseId) event.toolUseId = toolUseId;

  if (eventName === 'pretooluse' && toolName) {
    Object.assign(event, extractInputFields(toolName, data.tool_input));
  } else if (eventName === 'posttooluse' && toolName) {
    Object.assign(event, extractOutputFields(toolName, data.tool_response));
  } else if (eventName === 'posttoolusefailure' && toolName) {
    event.success = false;
  }

  fs.mkdirSync(BUFFER_DIR, { recursive: true, mode: 0o700 });
  const bufferPath = path.join(BUFFER_DIR, `session-${sessionId}.jsonl`);
  fs.appendFileSync(bufferPath, JSON.stringify(event) + '\n', { mode: 0o600 });
}

try {
  main();
} catch {
  // Absolute last resort — never throw back to Claude Code.
}
