---
name: hygiene-sweep
description: Use before opening a PR, at session close, at session start on unfamiliar ground, when asked "is this stale", "is the doc up to date", "clean up worktrees", "merged branches", "doc rot", "is CLAUDE.md current", "what's the real state of the repo". Also triggers on: orphan worktrees, build cache bloat, status tables with no as-of date, files describing a world that has moved on.
---

# Hygiene Sweep: Repository & Documentation Sanity Engine

Two kinds of debris accumulate silently:
1. **Physical Debris:** Unregistered worktrees, dead merged branches, dangling Docker build caches, stray clone folders.
2. **Informational Debris:** Documentation describing a world that has moved on. Stale documentation is far more dangerous than missing documentation — missing prompts inspection, while stale prompts misplaced confidence.

---

## 1. The Core Prevention Rule
Every claim about current repository state MUST carry:
1. The evidence that produced it.
2. The command to re-verify it.

A status table with no as-of date cannot be audited, so nobody audits it, and it rots. **Prefer a live pointer/command (e.g. `docker compose ps`, `git branch --merged`) over static snapshot tables.**

---

## 2. Physical Hygiene Sweep Protocol
- **Worktrees:** Run `git worktree list` and `git worktree prune`. Detect orphan worktree directories on disk. Propose removal ONLY if:
  1. Working tree is completely clean.
  2. Branch is fully merged (`git rev-list --count base..branch` equals 0).
  3. Any build artifacts have been preserved.
- **Merged Branches:** List local branches whose upstream commits are merged into `main`. Propose deletion.
- **Docker / Build Caches:** Check `docker system df` or local temp/build directories. Cache bloat is routinely misdiagnosed as code bugs or disk failures.

*Strict Boundary:* Removal of files, branches, or directories is destructive and ALWAYS requires owner escalation.

---

## 3. Informational Sweep & Verdicts
When auditing docs, configs, or session summaries, assign one of four verdicts:
1. **CURRENT:** State is live and verified. Re-stamp the `as-of` date ONLY after running the actual verification command. Re-stamping without running the check manufactures false confidence.
2. **STALE:** State has drifted. Update in the same turn; never defer.
3. **SUPERSEDED:** Architecture or decision was replaced. Mark with `[SUPERSEDED by <link/doc>]` and point forward. Do not silently delete architectural history.
4. **WRONG:** Mentions services, files, or ports that do not exist and never existed as intended. Delete the text and its index references immediately.

---

## 4. Execution Timing
Execute the hygiene sweep:
1. **Session Start on Unfamiliar Ground:** Highest value. Eliminates false assumptions before they infect the session graph.
2. **Before Opening a PR:** Ensures clean diffs, no stray files, and accurate docs.
3. **Session Close:** Verifies clean tree, pushed commits, and updated session logs.
