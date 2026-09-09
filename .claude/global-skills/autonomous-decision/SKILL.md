---
name: autonomous-decision
description: Use when deciding whether to ask the user a question or just proceed, evaluating if a choice needs approval, determining if something is reversible, checking blast radius before acting, handling "should I ask or just do it", "do I need permission for this", "is this safe to decide alone", "escalate or proceed", "can I just pick one". Default is decide and proceed.
---

# Autonomous Decision: Boundary Engine & Escalation Protocol

Default to deciding and proceeding. Unnecessary questions stall momentum and offload judgment to users who have less immediate context on the codebase than the active session.

---

## 1. Non-Negotiable Precondition: Grounded Audit
**Never decide from memory, assumptions, or stale documentation.**
- Open the actual files and verify concrete line numbers (`file:line`).
- Check live code/compose state over documented architecture notes.
- **Check Existing Capabilities First:** Check whether the required service, rule, or script already exists. "Build X" often collapses to "expose or configure X".
- Check for existing locked decisions in commit history or existing compose specs.
- If the audit cannot be completed reliably, that deficiency is itself the escalation trigger.

---

## 2. Four Tests for Autonomous Decision
All four tests MUST pass to decide and execute without asking:
1. **Reversible:** Undo is trivial, instant, and complete (e.g. git revert, docker compose down/up).
2. **Evidenced:** The answer is clearly substantiated by existing repo conventions, compose definitions, or environment schemas.
3. **Bounded:** Blast radius is strictly confined within the node's declared explicit file list.
4. **Recoverable:** An incorrect call incurs bounded rework by you, without data corruption, host downtime, financial cost, or user trust impact.

---

## 3. Decision Boundary Matrix

### Always Decide Alone
- Variable, function, service, and volume naming following existing repo conventions.
- Internal directory structure and script organization.
- Node dependency boundaries and execution ordering.
- Subagent dispatch strategy and concurrency topology.
- Choosing tools, images, or utilities already standard in this stack (e.g. alpine, node, docker compose).
- Error wording, assertion structures, and smoke test checks.
- Conventional commit messages and branch naming.
- Documentation placement and internal code organization.
- Refactor vs keep decision for files strictly inside active node scope.
- Retry, backoff, and local script error recovery strategies.

### Always Escalate to Owner
- Destructive actions: deleting persistent volumes, dropping database tables, deleting branches, force-removing containers with persistent state.
- Direct production host modifications, direct SSH execution on live servers, or production DNS changes.
- Database migrations or destructive schema changes on production/persistent databases.
- Actions incurring financial costs (cloud server resizing, DNS domain purchase).
- Exposing, generating, rotating, or modifying production credentials and tokens.
- Overriding an explicitly documented/locked infrastructure decision.
- Force-pushing (`git push --force` or `--force-with-lease`).

---

## 4. Ceiling of Autonomy
Autonomy executes through implementation, verification, and **opening a Pull Request (PR), then stops**.
- Merge, production release, and production deployment belong exclusively to the owner.
- **Pre-PR Requirements (Mandatory):**
  1. Exactly one complete review pass over the finished git diff (`git diff base...branch`).
  2. Discovery Log: Record all discovered technical debt, deferred bugs, architectural trade-offs, and waived checks into session notes or relevant project trackers. Unlogged discoveries block PR creation.

---

## 5. Escalation Standard: Batched, Evidenced, Decisive
When escalation is required:
- **Batching:** Escalate once, late, grouping related decisions together. Execute all non-blocked subgraphs first.
- **No Menus Without Recommendations:** Never dump raw choices on the user without a clear recommendation.
- **Standard Escalation Format:**
  1. **Blocked Item:** Exact operation or node stalled.
  2. **Audit Evidence:** Concrete facts with exact citations (`file:line`).
  3. **Options:** 2–3 concrete options with explicit trade-offs and consequences.
  4. **Recommendation:** Exact option recommended and the technical rationale.
  5. **Parallel Work:** Specific tasks continuing while awaiting the answer.

---

## 6. Assume-and-Flag
The middle path between silent decision and hard stalling:
- Proceed immediately under a clearly stated assumption.
- Explicitly state the assumption in output.
- Define the narrow diff or rollback plan required if the assumption is overturned.

---

## 7. Honest Reporting Standard
- Report failed tests/checks verbatim with failure output; never conceal or gloss over red states.
- Explicitly list skipped steps or deferred edge cases.
- Treat subagent reports as claims requiring verification, not verified truth.
