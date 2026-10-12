'use strict';

// Sends completed-task cost records to New Relic's Events API — the same
// mechanism ~/.claude/hooks/git-branch-context.sh already uses (a direct
// POST with an Insights API key), not OpenTelemetry/OTLP. Kept dependency-
// free by using Node's built-in `https` module.
//
// Config (env vars, read at call time so a running watcher.js picks up
// changes on the next task close without a restart):
//   NR_INSIGHTS_API_KEY  — required. If unset, sending is silently skipped
//                          (local cost-log.jsonl is unaffected either way).
//   NR_ACCOUNT_ID        — defaults to 12700570, the account the existing
//                          git-branch-context.sh hook already posts to.
//   NR_INSIGHTS_ENDPOINT — defaults to the STAGING Insights collector, to
//                          match the existing hook's own key/target
//                          (verified 2026-09-28: the production collector
//                          returns 403 for this key; staging returns 200
//                          for both ClaudeTaskCost and the existing hook's
//                          ClaudeSessionBranch). Override if that changes.

const https = require('https');

const DEFAULT_ENDPOINT = 'https://staging-insights-collector.newrelic.com';
const DEFAULT_ACCOUNT_ID = '12700570';
const REQUEST_TIMEOUT_MS = 5000;

let warnedMissingKey = false;

function getConfig() {
  return {
    apiKey: process.env.NR_INSIGHTS_API_KEY,
    accountId: process.env.NR_ACCOUNT_ID || DEFAULT_ACCOUNT_ID,
    endpoint: process.env.NR_INSIGHTS_ENDPOINT || DEFAULT_ENDPOINT,
  };
}

/**
 * Fire-and-forget: POST one custom event to New Relic. Never throws and
 * never rejects — a New Relic outage, a missing key, or a network error all
 * just log a warning (once, for the missing-key case) and resolve, so this
 * can never take down the watcher loop or block a task close.
 *
 * @param {string} eventType
 * @param {Record<string, string | number | boolean>} fields
 * @returns {Promise<void>}
 */
function sendEvent(eventType, fields) {
  const { apiKey, accountId, endpoint } = getConfig();

  if (!apiKey) {
    if (!warnedMissingKey) {
      console.warn(
        '[claude-cost-tracker] NR_INSIGHTS_API_KEY not set — skipping New Relic export (local cost-log.jsonl still gets every task)',
      );
      warnedMissingKey = true;
    }
    return Promise.resolve();
  }

  let url;
  try {
    url = new URL(`${endpoint}/v1/accounts/${accountId}/events`);
  } catch (err) {
    console.warn('[claude-cost-tracker] Invalid NR_INSIGHTS_ENDPOINT:', err.message);
    return Promise.resolve();
  }

  const body = JSON.stringify([{ eventType, ...fields }]);

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Api-Key': apiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        res.resume(); // drain the response body — we don't need it
        if (res.statusCode && res.statusCode >= 400) {
          console.warn(`[claude-cost-tracker] New Relic Events API returned HTTP ${res.statusCode} (${endpoint})`);
        } else {
          console.log(`[claude-cost-tracker] New Relic accepted ${eventType} — HTTP ${res.statusCode} (${endpoint}, account ${accountId})`);
        }
        resolve();
      },
    );
    req.on('timeout', () => {
      req.destroy();
      console.warn('[claude-cost-tracker] New Relic Events API request timed out');
      resolve();
    });
    req.on('error', (err) => {
      console.warn('[claude-cost-tracker] New Relic Events API request failed:', err.message);
      resolve();
    });
    req.write(body);
    req.end();
  });
}

module.exports = { sendEvent };
