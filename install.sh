#!/bin/sh
# AIM-hackathon-hooks — one-time, machine-wide install.
#
# Run once after cloning:
#   ./install.sh --nr-ingest-key YOUR_KEY [--nr-account-id YOUR_ACCOUNT_ID] [--nr-insights-key YOUR_INSIGHTS_KEY]
#   NEW_RELIC_INGEST_KEY=YOUR_KEY ./install.sh --nr-account-id YOUR_ACCOUNT_ID
#
# Same convention as this org's existing `@newrelic/dev-cost init` CLI (cli/src/init.js
# in the aim-payback-hackethon-2026 repo): every installer supplies and owns their own
# New Relic values. Nothing is baked into this kit's source, and nothing you pass here
# ever gets echoed back or logged.
#
# --nr-account-id / --nr-insights-key are OPTIONAL and CLI-flags-only (deliberately no
# $NR_ACCOUNT_ID / $NR_INSIGHTS_API_KEY env var fallback — those exact names are already
# used by claude-cost-tracker's nr-events.js for its own, separate purpose; defaulting
# from them here would silently pick up a value you never meant to pass to this kit).
# They only enable the ClaudeSessionBranch bridge event (session<->branch/ticket), which
# the Dev Cost dashboard's cost-rollup query needs to attribute cost to a ticket — the
# OTLP metrics pipeline below works fully without them. If --nr-insights-key is omitted
# but --nr-account-id is given, the ingest key is reused for both (common when one
# license key covers both OTLP export and the Events API). The account id MUST be the
# one your own insights key is actually scoped to — confirmed live elsewhere this
# session that a mismatched key/account pair gets rejected outright; there's no
# universal correct value, check your own New Relic account picker or Account Settings
# -> API Keys.
#
# What this does:
#   1. Points git's global core.hooksPath at this kit's githooks/ directory, so the
#      branch-name check and the repo-graph rebuild fire in every local repo on this
#      machine, with no per-repo setup.
#   2. Installs the token/cost telemetry hook + its exporter config to ~/.tokenwise/
#      (with YOUR values substituted into env.sh), and registers the hook in
#      ~/.claude/settings.json (merged via jq if available, else printed for you to
#      paste in by hand — never overwritten silently).
#   3. Prints the Limitations below so they're seen once, right when they're relevant.
#
# What this does NOT do: install any per-repo CI check. See templates/ and README.md.

set -eu

KIT_DIR="$(cd "$(dirname "$0")" && pwd)"

INGEST_KEY="${NEW_RELIC_INGEST_KEY:-}"
# No env-var fallback for these two, deliberately: $NR_ACCOUNT_ID / $NR_INSIGHTS_API_KEY
# are the exact same names claude-cost-tracker's nr-events.js uses for its own, separate
# purpose — confirmed live that a shell with those already exported for that tool gets
# silently picked up here too if we default from them. CLI flags only, so this feature
# only ever turns on when explicitly asked for.
ACCOUNT_ID=""
INSIGHTS_KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --nr-ingest-key)
      INGEST_KEY="${2:-}"
      shift 2
      ;;
    --nr-ingest-key=*)
      INGEST_KEY="${1#--nr-ingest-key=}"
      shift
      ;;
    --nr-account-id)
      ACCOUNT_ID="${2:-}"
      shift 2
      ;;
    --nr-account-id=*)
      ACCOUNT_ID="${1#--nr-account-id=}"
      shift
      ;;
    --nr-insights-key)
      INSIGHTS_KEY="${2:-}"
      shift 2
      ;;
    --nr-insights-key=*)
      INSIGHTS_KEY="${1#--nr-insights-key=}"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$INGEST_KEY" ]; then
  echo "Error: missing --nr-ingest-key (or set \$NEW_RELIC_INGEST_KEY)." >&2
  echo "Every installer supplies their own New Relic ingest key — see README.md." >&2
  exit 1
fi

# Reuse the ingest key for the Events API too, unless a separate one was given — common
# when one license key covers both.
if [ -n "$ACCOUNT_ID" ] && [ -z "$INSIGHTS_KEY" ]; then
  INSIGHTS_KEY="$INGEST_KEY"
fi

echo "==> Installing AIM-hackathon-hooks from ${KIT_DIR}"

# --- 1. Global git hooks ----------------------------------------------------------------
git config --global core.hooksPath "${KIT_DIR}/githooks"
echo "==> git config --global core.hooksPath set to ${KIT_DIR}/githooks"

# --- 2. Token/cost telemetry hook, installed to ~/.tokenwise/ ---------------------------
TOKENWISE_HOME="${HOME}/.tokenwise"
mkdir -p "$TOKENWISE_HOME"
cp "${KIT_DIR}/tokenwise/session-start.sh" "${TOKENWISE_HOME}/session-start.sh"
cp "${KIT_DIR}/tokenwise/prices.json" "${TOKENWISE_HOME}/prices.json"

# Substitute the installer's own values — never echoed, never logged. sed writes to a
# temp file first so a mid-write failure can't leave a partially-substituted env.sh
# behind. Account id / insights key stay empty (not a literal placeholder) when not
# supplied — session-start.sh's own `[[ -n ... ]]` check treats that as "feature off."
TMP_ENV="$(mktemp)"
sed \
  -e "s|__NR_INGEST_KEY__|${INGEST_KEY}|" \
  -e "s|__NR_ACCOUNT_ID__|${ACCOUNT_ID}|" \
  -e "s|__NR_INSIGHTS_KEY__|${INSIGHTS_KEY}|" \
  "${KIT_DIR}/tokenwise/env.sh" > "$TMP_ENV"
mv "$TMP_ENV" "${TOKENWISE_HOME}/env.sh"

chmod 600 "${TOKENWISE_HOME}/env.sh"
chmod +x "${TOKENWISE_HOME}/session-start.sh"
echo "==> Telemetry hook installed to ${TOKENWISE_HOME} (env.sh is chmod 600, nothing printed above)"
if [ -n "$ACCOUNT_ID" ]; then
  echo "==> ClaudeSessionBranch bridge enabled, posting to account ${ACCOUNT_ID}"
else
  echo "==> ClaudeSessionBranch bridge NOT enabled (no --nr-account-id given) — OTLP metrics"
  echo "    still work, but the Dev Cost dashboard's cost-rollup query won't be able to"
  echo "    attribute them to a ticket. Re-run with --nr-account-id to enable it."
fi

# --- 3. Register the SessionStart hook in ~/.claude/settings.json -----------------------
CLAUDE_DIR="${HOME}/.claude"
SETTINGS_FILE="${CLAUDE_DIR}/settings.json"
mkdir -p "$CLAUDE_DIR"

if [ ! -f "$SETTINGS_FILE" ]; then
  cp "${KIT_DIR}/tokenwise/settings.snippet.json" "$SETTINGS_FILE"
  echo "==> Created ${SETTINGS_FILE} with the SessionStart hook registered."
elif command -v jq >/dev/null 2>&1; then
  TMP_FILE="$(mktemp)"
  jq -s '
    .[0] as $existing | .[1] as $snippet |
    $existing * {
      hooks: (($existing.hooks // {}) * {
        SessionStart: (($existing.hooks.SessionStart // []) + $snippet.hooks.SessionStart)
      })
    }
  ' "$SETTINGS_FILE" "${KIT_DIR}/tokenwise/settings.snippet.json" > "$TMP_FILE"
  mv "$TMP_FILE" "$SETTINGS_FILE"
  echo "==> Merged the SessionStart hook into existing ${SETTINGS_FILE} (via jq)."
else
  echo "==> ${SETTINGS_FILE} already exists and 'jq' isn't available to merge automatically." >&2
  echo "    Add this by hand under the top-level \"hooks\" object:" >&2
  echo "" >&2
  cat "${KIT_DIR}/tokenwise/settings.snippet.json" >&2
  echo "" >&2
fi

# --- 4. Limitations, stated once ---------------------------------------------------------
cat <<'EOF'

==> Install complete. Limitations to know about:

1. CI enforcement is never global. GitHub Actions and branch protection are
   per-repository (or per-org, with org-admin access to an "organization-level required
   workflow" — separate setup this kit doesn't do). This install makes the LOCAL
   branch-name check and the telemetry/repo-graph hooks work in every repo automatically.
   It cannot make a PR merge-blocking check appear in a repo you don't separately
   configure — see templates/ for what to copy into a specific repo for that.

2. A repo with its own core.hooksPath (e.g. Husky) silently wins over this global one.
   Git applies local repo config over global config, with no warning. In such a repo,
   these hooks simply won't run until that repo's maintainer adds one documented line
   from templates/pre-commit-line.sh to its own hook.

3. Your ingest key lives in ~/.tokenwise/env.sh, chmod 600 (unreadable by other local
   users) but not encrypted — it's your own key, for your own account, same as running
   `dev-cost init` yourself. Treat that file the way you'd treat any other local
   credential file.

4. The repo-graph hook's output is still per-repo: it writes .tokenwise/repo-graph.json
   inside whichever repo just merged, not anywhere inside this kit.

EOF
