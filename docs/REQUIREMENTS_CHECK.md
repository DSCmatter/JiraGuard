# Codegeist 2026 Requirements Check

> Assessment of this repo against the Codegeist 2026 rules. Snapshot: **Oct 31, 2026**. Deadline: **Dec 22, 2026, 12:00pm PST**.
> Re-run this check after the week-1 spike and before submission.

## Verdict

**On paper: the core requirement and one bonus are covered. As a submission today: not yet — no app exists.**

This repo currently contains only planning documents (`PRD.md`, `ARCHITECTURE.md`, `MCP_TOOL_SPEC.md`, `README.md`, `SUBMISSION.md`). There is no `manifest.yml`, `package.json`, `src/`, Forge CLI config, or any executable code. The core requirement — *build an app using Forge and integrate with an Atlassian product* — is a plan, not a deliverable.

| | |
|---|---|
| Core requirement | ⚠️ Planned, not built |
| Category | ✅ Apps for Software Teams |
| Bonuses targeted | 1 of 4 (Atlassian MCP), unproven |
| Blocking unknown | Forge webtrigger as MCP endpoint |

## Core Requirements

| Requirement | Status | Evidence / notes |
|---|---|---|
| Built on Atlassian Forge | ❌ Not started | No manifest, functions, or deploy. Forge-only is the stated design (ARCHITECTURE D1). |
| Integrates with ≥1 Atlassian product or capability | ⚠️ Planned only | Jira REST via `asApp()`; scopes `read:jira-work`, `write:jira-work`, `storage:app`. Nothing implemented. |
| Fits one category | ✅ Yes | **Apps for Software Teams**: per-agent Jira permissions, approval queue, audit trail for dev teams. |
| Submission package complete | ⚠️ Drafts only | Judge instructions and tech explanation drafted in `SUBMISSION.md`. Missing install link, public <5 min video, filled third-party/AI disclosure table, fresh-site test, secrets audit. |
| Rules check (prior-work reuse) | ❌ Unchecked | `SUBMISSION.md` line 7 unchecked; marked blocking in PRD §7. Must confirm before reusing agentic-firewall ideas/code. |

## Bonus Prizes

| Bonus | Status | Notes |
|---|---|---|
| **Best Agents** — `rovo:agent`, `rovo:agentConnector`, `rovo:skill`, `rovo:action` | ❌ No | None of these modules appear. PRD §P2 lists "Rovo agent integration" as *future*, not v1. |
| **Best app with Atlassian MCP** — Forge app exposing an MCP server | ⚠️ Primary target, unproven | Design serves MCP over a Forge **webtrigger** (ARCHITECTURE §7). Plausibly qualifies, but hosting, transport, and auth are still `[VERIFY]` — the single blocking spike. |
| **Best apps with Teamwork Graph** — ingest and/or consume TWG API | ❌ No | Not mentioned anywhere in the docs. No graph ingest, no TWG API usage. |
| **Best Marketplace published app** — listing or review ticket | ⚠️ P1 only | P1-7, and **first in the cut order** (PRD §8). No listing, no review ticket, no review timeline planned. |

## Risks, In Priority Order

1. **No code with ~7.5 weeks left.** The week-1 spike is now the critical path, and it gates the MCP bonus the project is competing for.
2. **Webtrigger-as-MCP is the whole bet.** Unverified: request/response size and timeout limits, whether MCP clients accept stateless JSON without SSE or session IDs, and how a bearer token is validated on an effectively public URL. If this fails, both the product claim and the bonus fail.
3. **`asApp()` writes.** App-level attribution, permission quirks on some Jira operations, and Marketplace review scrutiny for an app writing to Jira on behalf of third-party agents.
4. **Audit storage.** Forge storage query/index limits and retention are `[VERIFY]`; the audit log is P0, so this must be settled early.
5. **Thin bonus coverage.** Only 1 of 4 bonuses is in scope. `rovo:skill` / `rovo:action` wrappers over the existing tool executor are the cheapest add-on and would qualify for the Agents bonus without changing the architecture.

## Next Steps

1. **Run the spike.** Scaffold a real Forge app, deploy a webtrigger, prove `initialize` → `tools/list` → `tools/call` from MCP Inspector with bearer auth. Nothing else matters until this is green.
2. **Decide on the Rovo bonus.** Add `rovo:action` / `rovo:skill` modules over the same tool executor — roughly a day of work for a separate $1,500 pool.
3. **Promote Marketplace submission to P0.** Review lead time is the long pole and it is its own bonus; P1-7's position in the cut order is wrong.
4. **Close the rules question.** Confirm prior-work reuse with the hackathon manager, or drop reused code.

## Status Legend

| Mark | Meaning |
|---|---|
| ✅ | Meets the requirement as written |
| ⚠️ | Partially met, planned, or unverified |
| ❌ | Not met or not started |
