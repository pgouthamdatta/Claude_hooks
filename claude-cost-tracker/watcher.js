#!/usr/bin/env node
'use strict';

// Long-running tracker. Run this as a background process (`node watcher.js &`
// or `npm run watch`) while you use Claude Code. It:
//   1. Polls buffer/session-<id>.jsonl (written by collector.js) for new
//      hook events, keyed by session.
//   2. Once a session's transcript_path is known, tails that transcript
//      file directly and extracts real per-turn token usage — the same
//      technique Preflight's ParentTranscriptWatcher uses. No self-reported
//      or estimated tokens anywhere in this path.
//   3. Prices each turn via pricing.js and accumulates cost into the
//      session's currently-open "task".
//   4. Closes a task on a Stop hook event (the authoritative signal — fires once per real
//      turn) or a long idle gap, whichever comes first. The idle gap is a safety net for
//      an abandoned/crashed session where Stop never arrives, not a routine boundary —
//      it used to be 30s, which was short enough to fire mid-turn on any slow-starting
//      response (e.g. a long stretch of reasoning before the first tool call), splitting
//      a turn's prompt and its cost into two separate tasks. Appends one
//      line to cost-log.jsonl, and (if NR_INSIGHTS_API_KEY is set) sends the
//      same record to New Relic as a ClaudeTaskCost event — see nr-events.js.
//   5. Pairs PreToolUse/PostToolUse buffer events (by toolUseId) into
//      ToolCallRecords, accumulates them per task, and on task close runs
//      anti-pattern detection (anti-patterns.js) over that task's calls —
//      logging to anti-patterns.jsonl, printing a running per-type
//      frequency count, and sending each detection to New Relic too.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { calculateCost } = require('./pricing');
const { sendEvent } = require('./nr-events');
const { analyze } = require('./anti-patterns');

const BUFFER_DIR = path.join(__dirname, 'buffer');
const COST_LOG_PATH = path.join(__dirname, 'cost-log.jsonl');
const ANTI_PATTERNS_LOG_PATH = path.join(__dirname, 'anti-patterns.jsonl');
// Persists each session's tailing progress (bufferOffset/transcriptOffset/transcriptPath)
// across restarts. Without this, every restart reset every session back to offset 0 and
// replayed its ENTIRE historical buffer+transcript in one synchronous burst — confirmed
// live as the cause of real prompts/cost clustering into a handful of tasks while the
// rest of a session's turns closed empty (pollTranscript's 1MB-per-call cap, called once
// per buffered line, drains even a huge transcript within the first few dozen lines of a
// backlog — long before most of that backlog's own `stop` lines are even reached, so by
// then there's nothing left to attach to the tasks they close). Written periodically
// (every poll tick) and on a clean shutdown — never required for correctness within a
// single run, only for what a restart resumes from.
const STATE_PATH = path.join(__dirname, 'tail-state.json');
const POLL_INTERVAL_MS = 2000;
// Safety net only — `Stop` (closeTask() called directly from handleBufferEvent) is the
// real, per-turn task boundary and fires well before this in the overwhelming majority
// of turns. This exists purely to flush a task whose session crashed or was abandoned
// before Stop ever arrived. Was 30s — far too short: any gap longer than that between
// hook-driven activity signals (e.g. a stretch of reasoning before the first tool call)
// fired this timer mid-turn, closing the task with the prompt attached but $0 cost, then
// opening a fresh task once real activity resumed — that one got the cost, with no
// prompt. Confirmed live: reproduced on this exact session, prompt-only and cost-only
// tasks landing back to back, ~70s apart.
const IDLE_TIMEOUT_MS = 10 * 60_000; // 10 minutes
const TRANSCRIPT_READ_CAP_BYTES = 1_048_576; // 1 MB per poll — bounds worst-case disk I/O
// Defensive cap on the prompt text sent to New Relic — not a verified exact NRDB
// attribute limit, just a sanity tripwire so one huge pasted prompt can't blow up the
// event (same spirit as jira-proxy-server.js's MAX_FILTER_LENGTH in the other repo).
const MAX_PROMPT_LENGTH = 4000;

/**
 * Reduces a prompt to just its first and last word before it's sent to NRDB — e.g.
 * "Suppose the server is down, what should I check first" becomes "Suppose *** first".
 * The point is that NRDB (an external, cloud-hosted destination) never receives or
 * stores the actual prompt content, only this fixed, non-sensitive shape; cost-log.jsonl
 * (local-only, never leaves this machine) keeps the real text unmasked for your own
 * debugging — only the sendEvent('ClaudeTaskCost', ...) call below uses this.
 */
function maskPromptForNrdb(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words[0] ?? '';
  return `${words[0]} *** ${words[words.length - 1]}`;
}

/** @type {Map<string, SessionState>} */
const sessionStates = new Map();

/** Cumulative count per anti-pattern type, for this process's lifetime. */
const antiPatternFrequency = new Map();

// ---------------------------------------------------------------------------
// Tailing checkpoint (survives restarts — see STATE_PATH above)
// ---------------------------------------------------------------------------

/** @returns {Record<string, {bufferOffset: number, transcriptPath: string | null, transcriptOffset: number}>} */
function loadPersistedState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return {}; // missing or malformed — start every session fresh, same as before this existed
  }
}

// Loaded once at startup, before any getState() call seeds a new session from it. Not
// re-read afterward — sessionStates (in-memory) is the single source of truth once running.
const persistedState = loadPersistedState();

/** Dumps only what's needed to resume tailing — not seenMessageIds/seenPromptUuids (those
 *  exist purely to guard against re-reading bytes the offset already accounts for; trusting
 *  the offset means a fresh empty Set on restart is correct, not a gap). */
function persistState() {
  const out = {};
  for (const [sessionId, state] of sessionStates) {
    out[sessionId] = {
      bufferOffset: state.bufferOffset,
      transcriptPath: state.transcriptPath,
      transcriptOffset: state.transcriptOffset,
    };
  }
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(out));
  } catch (err) {
    console.error('[claude-cost-tracker] Failed to write tail-state.json:', err.message);
  }
}

/**
 * @typedef {{
 *   bufferOffset: number,
 *   transcriptPath: string | null,
 *   transcriptOffset: number,
 *   seenMessageIds: Set<string>,
 *   seenPromptUuids: Set<string>,
 *   pendingToolCalls: Map<string, Record<string, unknown>>,
 *   activeTask: { taskId: string, startTime: number, costUsd: number, tokens: number, toolCalls: Array<Record<string, unknown>>, prompts: string[] } | null,
 *   idleTimer: NodeJS.Timeout | null,
 * }} SessionState
 */

/** @returns {SessionState} */
function getState(sessionId) {
  let state = sessionStates.get(sessionId);
  if (!state) {
    const saved = persistedState[sessionId];
    state = {
      bufferOffset: saved?.bufferOffset ?? 0,
      transcriptPath: saved?.transcriptPath ?? null,
      transcriptOffset: saved?.transcriptOffset ?? 0,
      seenMessageIds: new Set(),
      seenPromptUuids: new Set(),
      pendingToolCalls: new Map(),
      activeTask: null,
      idleTimer: null,
    };
    sessionStates.set(sessionId, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Buffer file draining (collector.js's output)
// ---------------------------------------------------------------------------

function pollBuffers() {
  let files;
  try {
    files = fs.readdirSync(BUFFER_DIR);
  } catch {
    return; // buffer dir doesn't exist yet — nothing has hooked in
  }

  for (const file of files) {
    const match = /^session-([a-zA-Z0-9_-]{1,128})\.jsonl$/.exec(file);
    if (!match) continue;
    processBufferFile(match[1], path.join(BUFFER_DIR, file));
  }
}

function processBufferFile(sessionId, filePath) {
  const state = getState(sessionId);

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }
  if (stat.size < state.bufferOffset) state.bufferOffset = 0; // rotated
  if (stat.size <= state.bufferOffset) return;

  const length = stat.size - state.bufferOffset;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, state.bufferOffset);
    state.bufferOffset = stat.size;

    for (const line of buf.toString('utf-8').split('\n')) {
      if (line) handleBufferEvent(sessionId, state, line);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function handleBufferEvent(sessionId, state, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  if (event.transcriptPath && !state.transcriptPath) {
    state.transcriptPath = event.transcriptPath;
  }

  // Catch the transcript up to "now" before acting on this event — not just
  // once per tick, after the fact. Without this, a backlog of buffered
  // events (e.g. the watcher was restarted mid-session, or started late)
  // gets drained by pollBuffers() in one synchronous pass: several tasks
  // can open AND close back-to-back before pollTranscripts() ever runs for
  // this tick, finalizing each one's cost at $0 even though real usage for
  // it is already sitting in the transcript. Polling inline, per event,
  // means every closeTask() sees whatever usage has landed so far.
  if (state.transcriptPath) {
    pollTranscript(sessionId, state);
  }

  if (event.mode === 'stop') {
    closeTask(sessionId, state);
    return;
  }

  // Any other hook (PreToolUse, PostToolUse, UserPromptSubmit) counts as
  // activity: open a task if none is active, and push the idle timer out.
  touchActivity(sessionId, state);

  if (event.mode === 'pretooluse' && event.toolUseId) {
    // Stash the pre-event's detail (tool name, file path, command,
    // test/build/lint classification) until the matching post-event
    // arrives with the success/failure outcome.
    state.pendingToolCalls.set(event.toolUseId, event);
  } else if (
    (event.mode === 'posttooluse' || event.mode === 'posttoolusefailure') &&
    event.toolUseId
  ) {
    const pre = state.pendingToolCalls.get(event.toolUseId);
    state.pendingToolCalls.delete(event.toolUseId);

    const record = {
      toolUseId: event.toolUseId,
      toolName: (pre && pre.toolName) || event.toolName,
      timestamp: (pre && pre.timestamp) || event.timestamp,
      filePath: pre && pre.filePath,
      command: pre && pre.command,
      isTestCommand: pre && pre.isTestCommand,
      isBuildCommand: pre && pre.isBuildCommand,
      isLintCommand: pre && pre.isLintCommand,
      // Absence of an explicit failure signal means success — matches
      // Claude Code's own convention (PostToolUseFailure is the distinct
      // failure signal for most tools; this collector also reads
      // tool_response.success/exitCode where available).
      success: event.success !== false,
      agentInterrupted: event.agentInterrupted === true,
    };

    // Only tool calls that complete while a task is open get attributed to
    // it — a post-event arriving after the task already closed (rare: the
    // idle timer fired mid-flight) is simply dropped rather than guessed at.
    if (state.activeTask) {
      state.activeTask.toolCalls.push(record);
    }
  }
}

// ---------------------------------------------------------------------------
// Transcript tailing — the real usage source
// ---------------------------------------------------------------------------

function pollTranscripts() {
  for (const [sessionId, state] of sessionStates) {
    if (state.transcriptPath) pollTranscript(sessionId, state);
  }
}

function pollTranscript(sessionId, state) {
  let stat;
  try {
    stat = fs.statSync(state.transcriptPath);
  } catch {
    return; // not written yet, or rotated away
  }
  if (stat.size < state.transcriptOffset) state.transcriptOffset = 0; // rotated/truncated
  if (stat.size <= state.transcriptOffset) return;

  const readSize = Math.min(stat.size - state.transcriptOffset, TRANSCRIPT_READ_CAP_BYTES);
  const fd = fs.openSync(state.transcriptPath, 'r');
  try {
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, state.transcriptOffset);
    const chunk = buf.toString('utf-8');

    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) return; // no complete line yet — wait for more

    const complete = chunk.slice(0, lastNewline + 1);
    state.transcriptOffset += Buffer.byteLength(complete, 'utf-8');

    for (const line of complete.split('\n')) {
      if (line) handleTranscriptLine(sessionId, state, line);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Real, non-sidechain, human-typed prompt line, or null. Claude Code's transcript
 * represents both a typed prompt AND a tool result as `type: "user"` — the two are told
 * apart by `origin.kind === 'human'` (tool-result lines carry no `origin` key at all) and
 * `message.content` being a plain string (a tool-result's content is always an array of
 * `{type: "tool_result", ...}` blocks, never a bare string). Confirmed against a real
 * transcript: both signals agreed on every one of ~1,500 checked lines, no ambiguous case.
 */
function parseHumanPromptLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry.type !== 'user') return null;
  if (entry.isSidechain === true) return null;
  if (entry.origin?.kind !== 'human') return null;

  const content = entry.message?.content;
  if (typeof content !== 'string') return null;

  const uuid = entry.uuid;
  if (!uuid) return null;

  return { uuid, text: content };
}

/** Real, non-sidechain assistant turn with a usable model + message id + usage object, or null. */
function parseAssistantUsageLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry.type !== 'assistant') return null;
  if (entry.isSidechain === true) return null; // subagent turns are inlined too — skip to avoid double-counting

  const message = entry.message;
  if (!message) return null;

  const model = message.model;
  if (!model || model === '<synthetic>') return null;

  const usage = message.usage;
  if (!usage) return null;

  const messageId = message.id;
  if (!messageId) return null;

  return { model, usage, messageId };
}

function handleTranscriptLine(sessionId, state, line) {
  const prompt = parseHumanPromptLine(line);
  if (prompt) {
    if (!state.seenPromptUuids.has(prompt.uuid)) {
      state.seenPromptUuids.add(prompt.uuid);
      touchActivity(sessionId, state);
      state.activeTask.prompts.push(prompt.text);
    }
    return; // a line is never both a prompt and an assistant-usage line
  }

  const parsed = parseAssistantUsageLine(line);
  if (!parsed) return;
  if (state.seenMessageIds.has(parsed.messageId)) return;
  state.seenMessageIds.add(parsed.messageId);

  const cost = calculateCost(parsed.usage, parsed.model);
  if (!cost) {
    console.warn(`[claude-cost-tracker] Unknown model "${parsed.model}" — add it to pricing.js`);
    return;
  }

  touchActivity(sessionId, state);
  state.activeTask.costUsd += cost.totalCost;
  state.activeTask.tokens +=
    (parsed.usage.input_tokens || 0) +
    (parsed.usage.output_tokens || 0) +
    (parsed.usage.cache_read_input_tokens || 0) +
    (parsed.usage.cache_creation_input_tokens || 0);
}

// ---------------------------------------------------------------------------
// Task boundary detection
// ---------------------------------------------------------------------------

function touchActivity(sessionId, state) {
  if (!state.activeTask) {
    state.activeTask = {
      taskId: crypto.randomUUID(),
      startTime: Date.now(),
      costUsd: 0,
      tokens: 0,
      toolCalls: [],
      prompts: [],
    };
  }
  resetIdleTimer(sessionId, state);
}

function resetIdleTimer(sessionId, state) {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => closeTask(sessionId, state), IDLE_TIMEOUT_MS);
}

function closeTask(sessionId, state) {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }

  const task = state.activeTask;
  if (!task) return;
  state.activeTask = null;

  // More than one user turn can land inside a single idle-gap task window — join rather
  // than keep only the first/last, so nothing typed is silently dropped.
  const joinedPrompt = task.prompts.join('\n\n---\n\n');
  const prompt =
    joinedPrompt.length > MAX_PROMPT_LENGTH
      ? `${joinedPrompt.slice(0, MAX_PROMPT_LENGTH)}…[truncated]`
      : joinedPrompt;

  const record = {
    taskId: task.taskId,
    sessionId,
    startTime: task.startTime,
    endTime: Date.now(),
    totalCostUsd: Math.round(task.costUsd * 1e6) / 1e6,
    totalTokens: task.tokens,
    ...(prompt && { prompt }),
  };

  try {
    fs.appendFileSync(COST_LOG_PATH, JSON.stringify(record) + '\n');
  } catch (err) {
    console.error('[claude-cost-tracker] Failed to write cost-log.jsonl:', err.message);
  }

  console.log(
    `[claude-cost-tracker] task closed  $${record.totalCostUsd.toFixed(4)}  ${record.totalTokens} tokens  (${task.taskId})`,
  );

  // Fire-and-forget — mirrors ~/.claude/hooks/git-branch-context.sh's own
  // mechanism (NR Events API, not OTel). Never awaited: a slow or failed
  // New Relic call must never delay the next poll cycle.
  const maskedPrompt = prompt ? maskPromptForNrdb(prompt) : prompt;
  sendEvent('ClaudeTaskCost', {
    session_id: record.sessionId,
    task_id: record.taskId,
    cost_usd: record.totalCostUsd,
    tokens: record.totalTokens,
    duration_ms: record.endTime - record.startTime,
    ...(maskedPrompt && { prompt: maskedPrompt }),
  });

  for (const pattern of analyze(task.toolCalls)) {
    recordAntiPattern(sessionId, task.taskId, pattern);
  }
}

function recordAntiPattern(sessionId, taskId, pattern) {
  const frequency = (antiPatternFrequency.get(pattern.type) || 0) + 1;
  antiPatternFrequency.set(pattern.type, frequency);

  const record = { sessionId, taskId, timestamp: Date.now(), ...pattern };

  try {
    fs.appendFileSync(ANTI_PATTERNS_LOG_PATH, JSON.stringify(record) + '\n');
  } catch (err) {
    console.error('[claude-cost-tracker] Failed to write anti-patterns.jsonl:', err.message);
  }

  const detail = pattern.file || pattern.command || '';
  console.log(
    `[claude-cost-tracker] anti-pattern: ${pattern.type}${detail ? `  (${detail})` : ''}  — ${frequency} total this session`,
  );

  sendEvent('ClaudeAntiPattern', {
    session_id: sessionId,
    task_id: taskId,
    pattern_type: pattern.type,
    ...(pattern.file !== undefined && { file: pattern.file }),
    ...(pattern.command !== undefined && { command: pattern.command }),
    ...(pattern.iterations !== undefined && { iterations: pattern.iterations }),
    ...(pattern.readCount !== undefined && { read_count: pattern.readCount }),
    ...(pattern.repeatCount !== undefined && { repeat_count: pattern.repeatCount }),
    ...(pattern.editCount !== undefined && { edit_count: pattern.editCount }),
    ...(pattern.agentCount !== undefined && { agent_count: pattern.agentCount }),
  });
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

console.log(`[claude-cost-tracker] watching ${BUFFER_DIR}`);
console.log(`[claude-cost-tracker] logging completed tasks to ${COST_LOG_PATH}`);
console.log(`[claude-cost-tracker] logging anti-patterns to ${ANTI_PATTERNS_LOG_PATH}`);
if (Object.keys(persistedState).length) {
  console.log(
    `[claude-cost-tracker] resuming tailing checkpoint for ${Object.keys(persistedState).length} session(s) from ${STATE_PATH}`,
  );
}

setInterval(() => {
  pollBuffers();
  pollTranscripts();
  persistState();
}, POLL_INTERVAL_MS);

// A clean Ctrl+C / `kill` (not `kill -9`) flushes the checkpoint immediately rather than
// relying on the next poll tick — closes the window between "last periodic save" and
// "process actually stops" to ~0 for the common restart path (this is exactly how this
// process gets restarted every time watcher.js itself is edited).
function shutdown() {
  persistState();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
