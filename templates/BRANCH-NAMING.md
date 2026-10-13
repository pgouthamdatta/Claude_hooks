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

