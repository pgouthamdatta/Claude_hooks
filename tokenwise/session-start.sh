#!/usr/bin/env bash
# Tokenwise — Claude Code SessionStart hook (global install, see ~/.claude/settings.json).
#
# Stamps the current git repo + branch (and any Jira key found in the branch) onto the
# OpenTelemetry resource attributes, so every token event Claude Code emits this session
# is attributable to the work it shipped. Also sources this kit's env.sh and emits its
# OTEL exporter vars in the same convention, so a session is fully configured for
# telemetry export with no manual `source env.sh` step.
#
# Also posts a ClaudeSessionBranch event (session_id <-> branch/ticket bridge) the same
# way .claude/hooks/git-branch-context.sh does in the aim-payback-hackethon-2026 repo —
# confirmed live this session that nothing else produces this event type outside that
# one repo's own hook, and the Dev Cost dashboard's cost-rollup query depends entirely on
# it to attribute ClaudeTaskCost/Metric data to a ticket. Unlike that original hook, the
# account id and insights key here are NOT hardcoded — install.sh writes YOUR OWN values
# into env.sh (--nr-account-id / --nr-insights-key), since an Events API POST has to use
# the account the posting key is actually scoped to, confirmed live elsewhere this
# session that a mismatched key/account pair gets rejected outright.
#
# Installed once, globally, by this kit's install.sh — not copied per-repo. It resolves
# repo/branch from whichever directory Claude Code's session actually starts in, so it
# works correctly across every repo on this machine without per-repo setup.
#
# This hook only ADDS attributes/events. It never blocks a session; on any error it
# exits 0 so a coding session is never held hostage by telemetry.

set -uo pipefail

# --- session_id, from the hook's own stdin JSON input (same convention as
# .claude/hooks/git-branch-context.sh) -----------------------------------------------------
HOOK_INPUT="$(cat 2>/dev/null || true)"
session_id=""
if command -v jq >/dev/null 2>&1 && [[ -n "$HOOK_INPUT" ]]; then
  session_id="$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)"
fi

# --- resolve git context (best-effort) --------------------------------------------------
repo="unknown"
branch="unknown"
origin_url=""

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  origin_url="$(git config --get remote.origin.url 2>/dev/null || true)"
  if [[ -n "$origin_url" ]]; then
    repo="$(basename -s .git "$origin_url")"
  else
    repo="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo unknown)")"
  fi
  # symbolic-ref, not rev-parse --abbrev-ref: confirmed live that rev-parse on a
  # zero-commit (unborn HEAD) repo prints "HEAD" to stdout AND exits non-zero, so the
  # `cmd || echo unknown` fallback fires too — both outputs land in $branch, joined by a
  # newline ("HEAD\nunknown"), corrupting the ClaudeSessionBranch event below.
  # symbolic-ref doesn't have this failure mode (same reason check-branch-name.sh uses it).
  branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo unknown)"
fi

# --- derive Jira key from branch (convention: NR-1234-slug, or any PROJECT-1234-slug) ---
jira_key=""
if [[ "$branch" =~ ([A-Z][A-Z0-9]+-[0-9]+) ]]; then
  jira_key="${BASH_REMATCH[1]}"
fi

# --- emit git/Jira resource attributes (OTLP pipeline) -----------------------------------
attrs="repo=${repo},branch=${branch}"
[[ -n "$jira_key" ]] && attrs="${attrs},jira.key=${jira_key}"

existing="${OTEL_RESOURCE_ATTRIBUTES:-}"
if [[ -n "$existing" ]]; then
  merged="${existing},${attrs}"
else
  merged="${attrs}"
fi

echo "OTEL_RESOURCE_ATTRIBUTES=${merged}"
export OTEL_RESOURCE_ATTRIBUTES="${merged}"

# --- also emit this kit's own exporter config, so no manual `source env.sh` is needed ---
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${HOME}/.tokenwise/env.sh"
if [[ ! -f "$ENV_FILE" ]]; then
  ENV_FILE="${HOOK_DIR}/env.sh" # fallback: not yet installed to ~/.tokenwise, use the kit copy directly
fi

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  for var in CLAUDE_CODE_ENABLE_TELEMETRY OTEL_METRICS_EXPORTER OTEL_LOGS_EXPORTER \
             OTEL_EXPORTER_OTLP_PROTOCOL OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_HEADERS; do
    val="${!var:-}"
    [[ -n "$val" ]] && echo "${var}=${val}"
  done
fi

# --- ClaudeSessionBranch: the session<->branch/ticket bridge the dashboard needs --------
# Only attempted if env.sh actually configured an account + key (optional feature — the
# OTLP pipeline above works fully without this). Fire-and-forget: a failure here only
# warns to stderr, same resilience convention as claude-cost-tracker's nr-events.js —
# telemetry must never block or fail a coding session.
if [[ -n "${NR_ACCOUNT_ID:-}" && -n "${NR_INSIGHTS_API_KEY:-}" && -n "$session_id" ]]; then
  insights_endpoint="${NR_INSIGHTS_ENDPOINT:-https://staging-insights-collector.newrelic.com}"
  jira_base_url="${JIRA_BASE_URL:-https://new-relic.atlassian.net/browse}"
  jira_ticket=""
  [[ -n "$jira_key" ]] && jira_ticket="${jira_base_url}/${jira_key}"

  body=$(printf '[{"eventType":"ClaudeSessionBranch","session_id":"%s","git.branch":"%s","git.repo":"%s","git.origin":"%s","jira.ticket":"%s"}]' \
    "$session_id" "$branch" "$repo" "$origin_url" "$jira_ticket")

  curl -s -o /dev/null -w '' --max-time 5 \
    -X POST "${insights_endpoint}/v1/accounts/${NR_ACCOUNT_ID}/events" \
    -H "Api-Key: ${NR_INSIGHTS_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$body" \
    2>/dev/null || echo "[tokenwise] ClaudeSessionBranch POST failed (non-fatal)" >&2
fi

exit 0
