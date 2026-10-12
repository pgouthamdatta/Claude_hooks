# AIM-hackathon-hooks

One clone, one install step, and four things work in every repo on this machine from
then on:

1. **Branch-name enforcement** — every branch must start with a Jira key
   (`NR-12345-description`).
2. **Token/cost + Jira correlation telemetry** — a Claude Code `SessionStart` hook that
   stamps `OTEL_RESOURCE_ATTRIBUTES` with the current repo/branch/Jira key and configures
   OTLP export, so Claude Code usage is attributable to the ticket it shipped.
3. **Repo-knowledge-graph rebuild** — a git `post-merge` hook that rebuilds a diff-aware
   graph of whichever repo just merged (via the optional `dev-cost-graphify` command).
4. **Per-task cost breakdown** (`claude-cost-tracker`, bundled) — 4 Claude Code hooks
   feeding a `watcher.js` daemon, auto-started and kept running via `launchd` on macOS,
   that writes `ClaudeTaskCost`/`ClaudeAntiPattern` events — without this, the Dev Cost
   dashboard's `BranchDrawer` shows "No per-task breakdown found."

## Install

```sh
git clone <this-repo-url>
cd AIM-hackathon-hooks
./install.sh --nr-ingest-key YOUR_INGEST_KEY --nr-account-id YOUR_ACCOUNT_ID
```

`--nr-account-id` is technically optional (see Limitation 3 below for what you lose
without it), but recommended by default — without it, both the `ClaudeSessionBranch`
bridge and the bundled `claude-cost-tracker` watcher have no ticket/account to attribute
data to, and the Dev Cost dashboard won't show anything useful even though telemetry is
flowing. Same per-installer-owns-their-own-credentials convention as this org's existing
`@newrelic/dev-cost init` CLI (`cli/src/init.js` in `aim-payback-hackethon-2026`) —
nothing is baked into this kit, and nothing you pass is ever echoed or logged.

That's it — one time, machine-wide. `install.sh`:
1. Sets `git config --global core.hooksPath` to this kit's `githooks/` directory, so the
   branch-name check and the repo-graph rebuild fire in every local repo automatically.
2. Installs the telemetry hook + its exporter config to `~/.tokenwise/` — with *your*
   values substituted into `env.sh`.
3. Registers the `SessionStart` hook in `~/.claude/settings.json` (merging with `jq` if
   available, otherwise printing the snippet for you to paste in by hand — it never
   overwrites an existing settings file).
4. Installs `claude-cost-tracker` to `~/.claude-cost-tracker/`, registers its 4 hooks,
   and starts `watcher.js` via a `launchd` user agent (`KeepAlive`+`RunAtLoad`, so it
   survives crashes and reboots) — skipped if that directory already has real
   accumulated state in it, so a pre-existing manual install is never overwritten.
5. Prints the Limitations below, once, right when they're relevant.

## If you also want a CI-enforced check in a specific repo

GitHub Actions and branch protection can't be installed globally — see Limitation 1
below. For a specific repo you maintain, copy these in by hand:
- `templates/branch-name-check.yml` → that repo's `.github/workflows/`
- `templates/pre-commit-line.sh` → one line into that repo's own local hook, if (and
  only if) that repo manages its own `core.hooksPath` (e.g. via Husky) — see Limitation 2
- `templates/BRANCH-NAMING.md` → that repo's root, as a short doc for its contributors

Then, in that repo's GitHub settings: Settings → Branches → Branch protection rules →
enable "Require status checks to pass" → select `branch-name-check`. This step is manual
and can't be scripted.

## Limitations

1. **CI enforcement is never global.** GitHub Actions and branch protection are
   per-repository (or per-org, but only with org-admin access to an "organization-level
   required workflow," which is separate setup this kit doesn't do). This install makes
   the *local* branch-name check and the telemetry/repo-graph hooks work in every repo
   automatically — it cannot make a PR merge-blocking check appear in a repo you don't
   separately configure. The `templates/` folder exists precisely because this step can't
   be automated away.
2. **A repo with its own `core.hooksPath` (e.g. Husky) silently wins over the global
   one.** Git applies local repo config over global config, with no warning. In such a
   repo, the global branch-name/repo-graph hooks simply won't run until that repo's
   maintainer adds one documented line from `templates/pre-commit-line.sh` to its own
   hook. `install.sh` cannot detect every such repo on your machine in advance — it can
   only tell you the rule.
3. **Your ingest key lives in `~/.tokenwise/env.sh`, `chmod 600` but not encrypted.**
   It's your own key for your own account — same as running `dev-cost init` yourself —
   not a shared secret, but still a local credential file; treat it like any other.
4. **The repo-graph hook's output is still per-repo**, even though the hook itself
   installs globally: `githooks/post-merge` writes `.tokenwise/repo-graph.json` *inside
   whichever repo* just merged, because that's the whole point (a graph that travels with
   that repo's own code, shared via that repo's own git history) — it's not a kit-wide
   artifact.
5. **`claude-cost-tracker`'s auto-start is macOS-only** (`launchd`). On a non-macOS
   machine the 4 hooks still get registered, but you'd need to start `watcher.js`
   yourself (`node ~/.claude-cost-tracker/watcher.js &`) and keep it running.
6. **Two `watcher.js` processes double-post every task.** If this machine already runs
   `claude-cost-tracker` manually from a different path, stop that one before relying
   on this install's `launchd`-managed instance — `install.sh` warns if it detects more
   than one running, but doesn't stop either for you.
