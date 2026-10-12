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
# Runs BEFORE claude-cost-tracker's own install.js (step 4): that script creates
# ~/.claude/settings.json itself if it doesn't exist yet, which would make this step's
# own "create fresh file" branch below never trigger on a brand-new machine, silently
# degrading the no-jq case (it'd fall through to "print the snippet, don't write it").
# install.js only ever touches its own 4 hook keys (confirmed by reading it), so running
# it second, against a file this step already created/merged into, is always safe.
CLAUDE_DIR="${HOME}/.claude"
SETTINGS_FILE="${CLAUDE_DIR}/settings.json"
mkdir -p "$CLAUDE_DIR"

if [ ! -f "$SETTINGS_FILE" ]; then
  cp "${KIT_DIR}/tokenwise/settings.snippet.json" "$SETTINGS_FILE"
  echo "==> Created ${SETTINGS_FILE} with the SessionStart hook registered."
elif command -v jq >/dev/null 2>&1; then
  TMP_FILE="$(mktemp)"
  # Dedupe by command string before appending — confirmed live that a plain `+` concat
  # (the original version of this line) duplicates the SessionStart entry every time
  # install.sh is re-run, unlike claude-cost-tracker's own install.js (step 4 below),
  # which explicitly checks for its command before adding. Re-running this must be as
  # safe as re-running that is.
  jq -s '
    .[0] as $existing | .[1] as $snippet |
    $existing * {
      hooks: (($existing.hooks // {}) * {
        SessionStart: (
          ($existing.hooks.SessionStart // []) as $cur |
          ($cur | map(.hooks[]?.command)) as $curCmds |
          $cur + [
            $snippet.hooks.SessionStart[]
            | select((.hooks[]?.command) as $c | ($curCmds | index($c)) == null)
          ]
        )
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

# --- 4. claude-cost-tracker (per-task breakdown), auto-started via launchd on macOS ----
# Fixed install location, deliberately separate from any existing manual install at a
# different path (e.g. a project checkout) — this only guards against the narrower case
# of the kit's OWN fixed path already having real state in it; the broader risk (two
# watcher.js processes running from two different paths, both posting the same tasks
# twice) is caught separately below via pgrep, regardless of where either one lives.
CCT_HOME="${HOME}/.claude-cost-tracker"
if [ -f "${CCT_HOME}/tail-state.json" ] || [ -f "${CCT_HOME}/cost-log.jsonl" ]; then
  echo "==> ${CCT_HOME} already has real claude-cost-tracker state (tail-state.json or"
  echo "    cost-log.jsonl present) — leaving it untouched rather than risk overwriting"
  echo "    it. Skipping claude-cost-tracker setup."
else
  mkdir -p "$CCT_HOME"
  cp "${KIT_DIR}/claude-cost-tracker/collector.js" \
     "${KIT_DIR}/claude-cost-tracker/watcher.js" \
     "${KIT_DIR}/claude-cost-tracker/anti-patterns.js" \
     "${KIT_DIR}/claude-cost-tracker/nr-events.js" \
     "${KIT_DIR}/claude-cost-tracker/pricing.js" \
     "${KIT_DIR}/claude-cost-tracker/install.js" \
     "${KIT_DIR}/claude-cost-tracker/package.json" \
     "$CCT_HOME/"

  # install.js resolves its own __dirname at runtime to build the hook commands it
  # writes — running it FROM the installed location (not the kit's source tree) is
  # what makes those commands point at the right final path. No args = global
  # ~/.claude/settings.json, matching every other hook this kit registers; its own
  # merge logic is idempotent (confirmed by reading it), so re-running this is safe.
  ( cd "$CCT_HOME" && node install.js )
  echo "==> claude-cost-tracker hooks (PreToolUse/PostToolUse/Stop/UserPromptSubmit) registered"

  if command -v launchctl >/dev/null 2>&1; then
    PLIST_DIR="${HOME}/Library/LaunchAgents"
    PLIST_FILE="${PLIST_DIR}/com.aim-hackathon-hooks.watcher.plist"
    mkdir -p "$PLIST_DIR"
    NODE_BIN="$(command -v node)"

    cat > "$PLIST_FILE" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.aim-hackathon-hooks.watcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${CCT_HOME}/watcher.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${CCT_HOME}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NR_INSIGHTS_API_KEY</key>
    <string>${INSIGHTS_KEY}</string>
    <key>NR_ACCOUNT_ID</key>
    <string>${ACCOUNT_ID}</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${CCT_HOME}/watcher.log</string>
  <key>StandardErrorPath</key>
  <string>${CCT_HOME}/watcher.log</string>
</dict>
</plist>
PLIST_EOF

    # Unload before load so re-running install.sh is idempotent — otherwise a second
    # `load` on an already-loaded label is a no-op that leaves a stale copy running
    # instead of picking up any changed EnvironmentVariables.
    launchctl unload "$PLIST_FILE" >/dev/null 2>&1 || true
    launchctl load -w "$PLIST_FILE"
    echo "==> watcher.js now running via launchd (auto-restarts on crash, starts at login)"
    echo "    logs: ${CCT_HOME}/watcher.log"

    OTHER_WATCHERS="$(pgrep -f 'node .*watcher\.js' 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${OTHER_WATCHERS:-0}" -gt 1 ]; then
      echo "==> NOTE: more than one watcher.js process is running on this machine right" >&2
      echo "    now. If one of them is a manually-started claude-cost-tracker at a" >&2
      echo "    different path, stop it — two running at once double-posts every task." >&2
    fi
  else
    echo "==> 'launchctl' not found (not macOS?) — hooks are registered, but you'll need"
    echo "    to start watcher.js yourself: node ${CCT_HOME}/watcher.js &"
  fi

  if [ -z "$ACCOUNT_ID" ]; then
    echo "==> NOTE: no --nr-account-id given, so watcher.js's own nr-events.js will fall"
    echo "    back to its hardcoded default account — pass --nr-account-id to target"
    echo "    your own account instead."
  fi
fi

# --- 5. Limitations, stated once ---------------------------------------------------------
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

5. The claude-cost-tracker auto-start is macOS-only (launchd). On a non-macOS machine
   the hooks still get registered, but you'll need to start watcher.js yourself.

6. If this machine already runs claude-cost-tracker manually from a different path,
   don't let both run at once — two watcher.js processes double-post every task. Stop
   the manual one before relying on this install's launchd-managed instance.

EOF
