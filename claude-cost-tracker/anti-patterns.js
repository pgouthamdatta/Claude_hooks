'use strict';

// Simplified anti-pattern detection over one task's tool-call sequence —
// the same five patterns Preflight's own AntiPatternDetector looks for,
// ported standalone (no dependency on that repo's vendored code). Operates
// on ToolCallRecord[] built by watcher.js from paired PreToolUse/PostToolUse
// buffer events (see collector.js for exactly which fields each record
// carries, and watcher.js's handleBufferEvent()/handlePostToolUse() for the
// pairing logic).
//
// Each ToolCallRecord looks like:
//   { toolUseId, toolName, timestamp, filePath?, command?, isTestCommand?,
//     isBuildCommand?, isLintCommand?, success, agentInterrupted? }

const THRESHOLD = 3; // same threshold Preflight uses uniformly across all five

// ---------------------------------------------------------------------------
// Thrashing: Edit/Write(file) -> Bash(test, fail) repeated on the same file
// ---------------------------------------------------------------------------

function detectThrashing(calls) {
  const fileCycles = new Map();
  const flagged = new Map();
  let lastEditFile = null;

  for (const call of calls) {
    if (call.toolName === 'Edit' || call.toolName === 'Write') {
      lastEditFile = call.filePath || null;
    } else if (call.toolName === 'Bash' && call.isTestCommand && lastEditFile) {
      if (call.success === false) {
        const count = (fileCycles.get(lastEditFile) || 0) + 1;
        fileCycles.set(lastEditFile, count);
        if (count >= THRESHOLD) flagged.set(lastEditFile, count);
      } else {
        fileCycles.set(lastEditFile, 0); // test passed — reset, keep watching the file
      }
    }
  }

  return [...flagged].map(([file, iterations]) => ({
    type: 'thrashing',
    file,
    iterations,
    suggestion: 'Consider reading the test output more carefully before editing again',
  }));
}

// ---------------------------------------------------------------------------
// Re-reading: same file read >= threshold times
// ---------------------------------------------------------------------------

function detectReReading(calls) {
  const counts = new Map();
  for (const call of calls) {
    if (call.toolName === 'Read' && call.filePath) {
      counts.set(call.filePath, (counts.get(call.filePath) || 0) + 1);
    }
  }
  return [...counts]
    .filter(([, count]) => count >= THRESHOLD)
    .map(([file, readCount]) => ({
      type: 're_reading',
      file,
      readCount,
      suggestion: 'Context may have been lost — consider breaking the task into smaller pieces',
    }));
}

// ---------------------------------------------------------------------------
// Stuck loop: same Bash command run consecutively >= threshold times
// ---------------------------------------------------------------------------

function detectStuckLoop(calls) {
  const flagged = new Map();
  let lastCommand = null;
  let consecutive = 0;

  for (const call of calls) {
    if (call.toolName !== 'Bash' || !call.command) continue;
    if (call.command === lastCommand) {
      consecutive++;
      if (consecutive >= THRESHOLD) flagged.set(call.command, consecutive);
    } else {
      lastCommand = call.command;
      consecutive = 1;
    }
  }

  return [...flagged].map(([command, repeatCount]) => ({
    type: 'stuck_loop',
    command,
    repeatCount,
    suggestion: 'The same command is being run repeatedly — try a different approach',
  }));
}

// ---------------------------------------------------------------------------
// Blind editing: >= threshold consecutive edits to a file with no
// intervening Read or passing test/build/lint verification
// ---------------------------------------------------------------------------

function detectBlindEditing(calls) {
  const streaks = new Map();
  const flagged = new Map();

  for (const call of calls) {
    if (call.toolName === 'Edit' || call.toolName === 'Write') {
      if (!call.filePath) continue;
      const count = (streaks.get(call.filePath) || 0) + 1;
      streaks.set(call.filePath, count);
      if (count >= THRESHOLD) flagged.set(call.filePath, count);
    } else if (call.toolName === 'Read' && call.filePath) {
      streaks.delete(call.filePath);
    } else if (
      call.toolName === 'Bash' &&
      (call.isTestCommand || call.isBuildCommand || call.isLintCommand) &&
      call.success !== false
    ) {
      // A passing verification clears every file's streak, not just one —
      // it typically validates the whole pending batch of edits.
      streaks.clear();
    }
  }

  return [...flagged].map(([file, editCount]) => ({
    type: 'blind_editing',
    file,
    editCount,
    suggestion: 'Verify changes with tests between edits',
  }));
}

// ---------------------------------------------------------------------------
// Over-delegation: repeated sub-agent (Agent tool) spawns that failed or
// were interrupted
// ---------------------------------------------------------------------------

function detectOverDelegation(calls) {
  const agentCount = calls.filter(
    (c) => c.toolName === 'Agent' && (c.success === false || c.agentInterrupted === true),
  ).length;

  if (agentCount >= THRESHOLD) {
    return [
      {
        type: 'over_delegation',
        agentCount,
        suggestion:
          'Multiple sub-agent spawns failed or were interrupted — investigate before spawning more',
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {Array<Record<string, unknown>>} calls — one task's tool calls, in order
 * @returns {Array<Record<string, unknown>>} detected patterns
 */
function analyze(calls) {
  return [
    ...detectThrashing(calls),
    ...detectReReading(calls),
    ...detectStuckLoop(calls),
    ...detectBlindEditing(calls),
    ...detectOverDelegation(calls),
  ];
}

module.exports = { analyze };
