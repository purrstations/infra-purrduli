---
name: task-graph
description: Use when decomposing work into steps, deciding what can run in parallel, mapping dependencies between tasks, planning a multi-step feature, asking "what order should I do this", "can these run at the same time", "fan out subtasks", "split into parallel lanes", "graph the work", "what must wait for what", "dispatch subagents". Triggers on any work with more than two steps where the execution order is not obvious.
---

# Task Graph: Structured Parallel Execution Engine

Work has a shape. What runs before what, what can run at once, what must wait — that shape is a graph. A linear plan is a degenerate graph where most arrows are just the order you happened to type things in.

## Core Test: The Edge Test
For every "and then", ask: **Does the next step READ the previous step's output?**
- If NO: There is NO edge. The wait is invented. Run in parallel.
- If YES: Declare the exact dependency contract and output shape.

---

## 1. Node Contract
Every node in the graph MUST explicitly declare:
1. **Explicit Input:** Exact data, schemas, or file contents passed into the node. Subagents have distinct context; never assume "it will see earlier conversation".
2. **Defined Output Shape:** Formal schema (JSON schema preferred when a later step is code) so failures trigger retry rather than parsing free text.
3. **Exact File List:** Explicit paths only. NO globs (`*.yml` or `*.js` forbidden). Explicit file lists enable static collision detection.
4. **Forbidden Surfaces:** Surfaces the node is barred from touching (e.g. shared registries, docker-compose base, nginx configs, workflows).
5. **Done-When Gate:** A deterministic verification command (e.g. `docker compose config`, `scripts/smoke.sh`), never visual inspection or "looks right".

---

## 2. Edges Are Free
Data transforms between nodes (flatten, dedupe, filter, rank, merge, format) are executed in plain code/logic between node dispatches. Do NOT spawn agent nodes to perform pure transforms.

---

## 3. Topology & Flow Control
- **Workhorse:** Diamond pattern (Split -> Fan Out -> Reduce -> Synthesize).
- **Default to Pipeline, Not Barrier:** Stream individual items through downstream stages independently.
- **Barrier Justification:** A barrier (waiting for all prior nodes to finish) is ONLY permitted when a node strictly requires the complete set at once (e.g. cross-set deduplication, global early-exit, comparative scoring across all findings). "Cleaner code" or "stages feel distinct" are invalid justifications.

---

## 4. Concurrency Caps & Disjointness Axioms
- **Write Lanes (Agents Editing Files):** MAX 4 concurrent lanes. Every pair MUST be strictly disjoint across all four axes:
  1. **Files:** Disjoint file sets. Touching the same file is an automatic collision even if modifying different functions or services.
  2. **Migrations / Ports:** No concurrent port assignments or database schema numbering.
  3. **Global Surfaces:** Exactly ONE designated lane may touch global configs (`docker-compose.yml`, `nginx/`, `.env.example`, `.github/workflows/deploy.yml`). All other lanes must declare these forbidden.
  4. **Git Ownership:** The lead agent is the sole git owner. Subagents NEVER run `git add`, `commit`, `checkout`, `push`, or `stash`.
- **Read-Only Lanes (Research, Review, Verify):** Up to 8 concurrent lanes. They cannot collide.
- **Dispatch Rule:** Dispatch entire wave in ONE multi-tool call message to execute concurrently.

---

## 5. Verifiers on Edges
Verifier purpose: **KILL false findings before propagation.** Survivors pass.
- **Adversarial:** N skeptics prompted specifically to refute. Default to refuted on ambiguity; pass on majority survival.
- **Perspective-Diverse:** Distinct inspection lenses (Correctness, Security, Network/Performance).
- **Judge Panel:** Parallel candidate generation; scored against criteria; winner synthesized while grafting valid sub-elements.
- **Severity Standard:** `Critical` requires concrete reproduction (`file:line` + exact input/command + wrong output/crash). "Could be cleaner" is capped at `Warning`.

---

## 6. Cycles That Converge
When discovery size is unknown, loop until $K$ consecutive rounds produce zero new findings.
- **Critical Rule:** Deduplicate against **EVERYTHING SEEN** (accepted + rejected history), NOT only confirmed results. Deduplicating against confirmed results causes endless rediscovery of rejected dead ends.

---

## 7. Per-Node Execution & Failure Limit
1. Implement node changes.
2. Run done-when verification command.
3. On failure: analyze root cause, fix, and retry.
4. **Hard Stop at 3 Failures:** If a node fails 3 consecutive attempts, STOP. The model of the problem is wrong, not just the code. Escalate or re-cut boundaries.

---

## 8. Atomic Commits & Push Protocol
- **One Commit Per Node:** If you cannot write a single conventional commit subject, it represents multiple nodes.
- **Green Tree Guarantee:** Every commit must leave test/lint/config validation passing independently.
- **Explicit Staging Only:** Stage exact paths (`git add path/to/file`). NEVER use `git add .`, `-A`, or `git commit -am`. Confirm with `git diff --cached --name-only`.
- **Push Per Node:** Push every commit immediately. Unpushed commits risk data entanglement or loss.
- **Squash Forbidden:** Squash merging destroys discrete verifiable history. Rebase to curate commit boundaries if necessary; never squash away node commits.

---

## 9. Model Tiering
- Match model tier to task complexity:
  - Repetitive, bounded, single-file edits -> Lightweight/fast model tier.
  - Multi-file synthesis, architectural judgment, security/refutation reviews -> Top model tier.

---

## 10. Anti-Patterns
- **Big-Bang Node:** Lumping disjoint service edits into one massive step.
- **Collision Overlap:** Multiple agents editing the same service/config concurrently.
- **Barrier by Default:** Forcing independent subtasks to wait for batch completion.
- **Deferred Push:** Accumulating unpushed local commits.
- **Post-hoc Only Verification:** Running verification only at the end of all phases rather than per node.
- **File-Type Splitting:** Cutting nodes by file type (all configs, all scripts) rather than functional slices.
