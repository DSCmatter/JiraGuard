# Codegeist 2026 Requirements Check

> Assessment of this repo against the Codegeist 2026 rules. Snapshot: **8 Nov 2026**. Deadline: **Dec 22, 2026, 12:00pm PST**.
> Re-run this check before submission.

## Verdict

**The spike proved a Forge webtrigger can speak MCP. The product app is not built. This is not a submission.**

This repo has the planning docs, the spike at `spike/mcp-webtrigger`, and product modules for storage, tokens, and policy under `src/`. Phase 0, Phase 1, and Phase 2 are done on `main`. There is no product `manifest.yml`. `npm test` covers the in-memory store and `decide`.

| | |
|---|---|
| Core requirement | ⚠️ Spike deployed. Product app not built |
| Category | ✅ Apps for Software Teams |
| Bonuses targeted | Atlassian MCP proven on the spike only. Marketplace listing not started |
| Blocking unknown | Product install link, admin page, and live Jira tools |

## Core Requirements

| Requirement | Status | Evidence / notes |
|---|---|---|
| Built on Atlassian Forge | ⚠️ Spike only | `spike/mcp-webtrigger` is deployed. The product app has no manifest. Forge-only remains the design (ARCHITECTURE D1). |
| Integrates with ≥1 Atlassian product or capability | ⚠️ Spike only | Spike `asApp()` created project SPIKE and commented on SPIKE-1. Product Jira tools are not implemented. Scopes used on the spike: `read:jira-work`, `write:jira-work`, `storage:app`. |
| Fits one category | ✅ Yes | **Apps for Software Teams**: per-agent Jira permissions, approval queue, audit trail for dev teams. |
| Submission package complete | ⚠️ Drafts only | Judge instructions and tech explanation drafted in `SUBMISSION.md`. Missing install link, public <5 min video, filled third-party/AI disclosure table, fresh-site test, secrets audit. |
| Rules check (prior-work reuse) | ❌ Unchecked | `SUBMISSION.md` line 7 unchecked; marked blocking in PRD §7. Must confirm before reusing agentic-firewall ideas/code. |

## Bonus Prizes

| Bonus | Status | Notes |
|---|---|---|
| **Best Agents** — `rovo:agent`, `rovo:agentConnector`, `rovo:skill`, `rovo:action` | ❌ No | None of these modules appear. PRD §P2 lists "Rovo agent integration" as *future*, not v1. |
| **Best app with Atlassian MCP** — Forge app exposing an MCP server | ⚠️ Spike passed, product not deployed | ARCHITECTURE section 10. MCP Inspector finished `initialize`, `tools/list`, and `tools/call` of `guard_whoami` with a bearer token, and got HTTP 401 without one. The handler is hand-written JSON-RPC on a webtrigger. That session is the spike, not the product app. |
| **Best apps with Teamwork Graph** — ingest and/or consume TWG API | ❌ No | Not mentioned anywhere in the docs. No graph ingest, no TWG API usage. |
| **Best Marketplace published app** — listing or review ticket | ❌ Not started | No listing and no review ticket. PLAN keeps this track beside the code phases. Admin-page screenshots wait for Phase 7. |

## Risks, In Priority Order

1. **The product app is still unbuilt.** Keep the spike as evidence. Phase 3 is the next code phase.
2. **`asApp()` writes.** One comment on SPIKE-1 is attributed to the app user. Product writes, permission quirks, and Marketplace review of third-party agent writes are still ahead.
3. **Product audit storage.** Phase 1 stores records in memory. Forge entity indexes are measured only on the spike entity `spike-event`. A value over 245760 characters was rejected. Retention is still an open product choice.
4. **Marketplace review has not started.**
5. **Thin bonus coverage.** The MCP bonus is the one in progress. `rovo:skill` and `rovo:action` over the same executor are Phase 9.

## Next Steps

1. **Build Phase 3.** Jira tools on the product path, behind `decide`.
2. **Create the product Forge app** when those tools need a deploy. Use the JiraGuard developer space and omit `--personal`.
3. **Start the Marketplace listing** without waiting for Phase 10. Screenshots still wait for the Phase 7 admin page.
4. **Close the rules question.** Confirm prior-work reuse with the hackathon manager, or drop reused code.

## Status Legend

| Mark | Meaning |
|---|---|
| ✅ | Meets the requirement as written |
| ⚠️ | Partially met, planned, or unverified |
| ❌ | Not met or not started |
