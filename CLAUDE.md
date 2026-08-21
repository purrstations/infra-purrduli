# Infrastructure Repository Operating Guidelines

Central operations manual and skill routing matrix for the Purr infrastructure stack.

---

## 1. Operating Mode & Autonomous Boundary
- **Autonomy Level:** Autonomous execution up to an open Pull Request.
- **Decision Engine:** Default to decide and proceed if reversible, evidenced, bounded, and recoverable.
- **Escalation Boundary:** Always escalate destructive ops (dropping volumes/tables, branch deletion), direct production access, secret rotation, and merge/deploy actions.
- **Audit Requirement:** Always cite live `file:line` before deciding or editing.

---

## 2. Skill Routing Matrix

| Situation / Trigger | Active Skill | Path |
|---|---|---|
| Decomposing multi-step work, planning order, parallel execution, verifiers | `task-graph` | `.claude/global-skills/task-graph/` |
| Evaluating approval boundaries, reversible actions, escalation formats | `autonomous-decision` | `.claude/global-skills/autonomous-decision/` |
| Handling owner corrections, rule amendments, session memory routing | `self-improve` | `.claude/global-skills/self-improve/` |
| Pre-PR checks, stale documentation audit, orphaned worktree detection | `hygiene-sweep` | `.claude/global-skills/hygiene-sweep/` |
| Docker compose edits, nginx proxy routing, TLS certs, port bindings | `infra-ops` | `.claude/skills/infra-ops/` |
| Branch creation, atomic commits, push-per-node, PR submission | `git-flow` | `.claude/skills/git-flow/` |

---

## 3. Project Architecture & Pointers
- **Stack Components:** Nginx proxy, Certbot TLS, EMQX broker, MediaMTX RTSP/WebRTC, Ingest server, PostgreSQL, Redis.
- **Active Service State:** Inspect live services via `docker compose ps` (do not rely on static snapshots).
- **Service Specs:** Defined in `docker-compose.yml`.
- **Ingress / Routing Specs:** Defined in `nginx/conf.d/*.conf`.
- **Smoke & Health Verification:** Execute `bash scripts/smoke.sh`.

---

## 4. Session Start & Logging Protocol
- **Start Check:** Run `git status`, verify worktree list, and check latest commits on `main`.
- **Obsidian Vault:** Log completed session units, architecture trade-offs, and discoveries to `D:\second-brain\Second Brain` under `Claude Sessions/infra/` following vault guidelines.
