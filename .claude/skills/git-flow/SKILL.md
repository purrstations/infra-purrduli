---
name: git-flow
description: Use when creating branches, staging files, writing commit messages, executing push-per-node, checking diffs, preparing Pull Requests, or validating git worktree hygiene in this repository.
---

# Git Flow: Atomic Execution & PR Standards

Protocol for maintaining a green, auditable, linear git history.

---

## 1. Branch Naming
- Features: `feat/<description>`
- Fixes: `fix/<description>`
- Refactors / Ops: `chore/<description>` or `ops/<description>`
- Always branch off latest `origin/main`.

---

## 2. Commit Standards
- **Conventional Commits:** Use `<type>(<scope>): <short description>`.
  - Allowed types: `feat`, `fix`, `chore`, `ops`, `refactor`, `test`, `docs`.
- **Atomic Unit:** Exactly ONE node per commit. If a commit cannot be summarized with a single subject line, the node boundary was cut too broad.
- **Explicit Path Staging:**
  - MUST stage exact file paths: `git add path/to/file1 path/to/file2`.
  - FORBIDDEN: `git add .`, `git add -A`, `git commit -am`.
  - Always verify staged contents before committing: `git diff --cached --name-only`.

---

## 3. Push-Per-Node Protocol
- Push immediately after committing: `git push -u origin <branch-name>`.
- Never accumulate unpushed local commits. Unpushed work creates invisible risk.

---

## 4. Pull Request Ceiling
- Autonomy ends at opening the Pull Request.
- **Pre-PR Checklist:**
  1. Diff Review: Inspect `git diff origin/main...<branch-name>` for unintended edits or orphaned debug code.
  2. Discovery Log: Ensure all discoveries, trade-offs, and waived tests are documented in session logs.
  3. Open PR with `gh pr create --title "..." --body "..."`.
- **DO NOT MERGE:** Merging and deployment are strictly reserved for the repository owner.
