# Branch naming

Every branch must start with a Jira issue key:

```
NR-12345-short-description
```

- Pattern: `^[A-Z][A-Z0-9]*-[0-9]+` — a project key (e.g. `NR`, `ABC`), a dash, then the
  issue number, at the very start of the branch name.
- Exempt: `main`, `master`, `develop`.
- Invalid example: `fix-the-thing` (no ticket key) — blocked.
- Valid example: `NR-12345-fix-the-thing`.

## How this is enforced

- **Locally**, if you've installed the
  [AIM-hackathon-hooks](../../AIM-hackathon-hooks) kit (`./install.sh`, once, machine-wide):
  automatically, in every repo that doesn't manage its own `core.hooksPath` (e.g. isn't
  using Husky). If this repo *does* manage its own hooks locally, see
  `templates/pre-commit-line.sh` in the kit for the one line to add here instead.
- **In CI**, via `.github/workflows/branch-name-check.yml` (copied from the kit's
  `templates/branch-name-check.yml`) — this only blocks a PR from merging if this repo's
  branch protection settings have "Require status checks to pass" enabled with the
  `branch-name-check` job selected. That one step is manual (GitHub Settings → Branches →
  Branch protection rules) and isn't something any script can do on your behalf.

## Adapting for a different Jira project key

If this repo's Jira project key isn't `NR`, set `BRANCH_CHECK_PROJECT_KEY_PATTERN` (local
hook) and/or edit the `PROJECT_KEY_PATTERN` env in `branch-name-check.yml` (CI) — no need
to touch the check logic itself.
