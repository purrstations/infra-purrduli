---
name: self-improve
description: Use when the user corrects you, when they repeat an instruction already given (rule exists but is unreachable), when the same mistake happens twice, when a bug took more than two investigation attempts, when a command failed in a way no doc predicted, when a documented rule turned out false, when something already existed that you were about to build, when a decision gets locked, when a phase or PR closes, when a session with real commits ends. Also use when asked to "remember this", "add this to your rules", "update your memory", "log this for next time".
---

# Self-Improve: Rule Evolution & Memory Routing Protocol

A learning nobody will read again is a feeling, not a learning. The job is ROUTING.

---

## 1. Triggers
Activate this skill immediately when:
- The owner corrects you.
- The owner repeats an instruction already given (the rule exists but was unreachable).
- The same mistake happens twice in one or more sessions.
- A bug or configuration issue took more than two investigation attempts.
- A command failed in a way no documentation predicted.
- A documented rule turned out false or outdated upon live audit.
- Something already existed that you were about to build or duplicate.
- An architectural decision gets locked by the owner.
- A phase or PR closes.
- A session with real commits ends.

---

## 2. Knowledge Routing Matrix
Before writing, determine destination:
- **Project-Agnostic Knowledge:** (Docker/Nginx quirks, generic shell gotchas, git protocol traps) -> Global rules / global skills.
  - *Test:* Would this help an engineer working on a completely different codebase?
- **Project-Specific State:** (This stack's port mappings, MediaMTX routing, certbot paths, deploy steps) -> Repo `CLAUDE.md` or `.claude/skills/infra-ops/`.
- **Session History & Decisions:** -> Obsidian vault session note (`D:\second-brain\Second Brain`).

---

## 3. The Rule Escalation Ladder
The core mechanism of continuous improvement:
- **1st Occurrence:** Write it down in the appropriate rule or skill doc.
- **2nd Occurrence:** AMEND THE EXISTING RULE that failed to prevent it (re-word triggers, add anti-patterns, sharpen done-when gate).
- **3rd Occurrence:** The rule is unreachable, not unwritten. Move it into an automated gate that runs unconditionally (a hook, a pre-commit check, or an assertion in smoke tests).

*Requirement:* When amending a rule, record the specific incident that forced it. A rule with no recorded cause gets deleted later as cargo cult.

---

## 4. Friction Standard
A rule bypassed every time is not a rule; it is friction. If a gate is routinely skipped with `--no-verify` or manual overrides, fix the gate so it can pass cleanly under valid workflows. Do not preserve ritual friction.

---

## 5. Writing Rules Standard
1. **One Fact Per Entry:** Atomic, focused statements.
2. **Title by Symptom:** Title entries with what is seen (the symptom/error), NOT the abstract diagnosis. Future sessions search for the error message they encounter.
3. **Record What It Is NOT:** Document wrong diagnoses investigated and eliminated. This stops subsequent sessions from repeating dead-end investigations.
4. **Absolute Dates:** Use ISO/absolute dates (e.g. `2026-08-21`), never relative references like "last week".
5. **Update Rather Than Duplicate:** Edit existing sections in place; never append duplicate paragraphs.
6. **Delete Falsehoods:** Delete what turned out wrong immediately. Stale notes actively mislead future agents.
7. **Scrub Secrets:** Never write credentials, tokens, IP addresses, or private keys to memory files.

---

## 6. What NOT to Record
Do NOT write down what the repository already records:
- File tree structure (use `ls` or glob).
- Git history (use `git log`).
- What a file does (use `read`).

If asked to remember one of these, identify what was non-obvious or counter-intuitive and record only that insight.
