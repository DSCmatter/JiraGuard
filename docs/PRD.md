# PRD: JiraGuard — a Governed MCP Server for Jira

> Working title. Codegeist 2026 submission, category: Apps for Software Teams. Primary bonus target: Best app with Atlassian MCP.
> Status: Draft v0.1 · Deadline: Dec 22, 2026, 12:00pm PST

## 1. Problem Statement

Teams are connecting AI agents (Claude, Cursor, Rovo Dev, custom bots) to Jira through MCP. Today an agent usually acts with one broad credential: it can read every project, edit any field, and transition any issue, and nobody can later say which agent did what. Issue text is also untrusted input, so a malicious comment can tell an agent to leak data or change the wrong tickets (prompt injection).

Jira admins have no per-agent permissions, no approval step for risky writes, and no audit trail built for agents. The cost of not solving it is either blocked AI adoption (security says no) or unmonitored agents with write access to the system of record.

## 2. Goals

1. **Least privilege per agent.** Every agent gets its own identity and a policy limiting projects, tools, fields and write mode. Target: an agent can never act outside its policy (0 policy-bypass findings in testing).
2. **Full accountability.** 100% of agent reads and writes are recorded with agent, tool, target, and before/after values.
3. **Human control over risky writes.** Writes flagged as risky are held until a human approves them.
4. **Reversibility.** Any logged field change can be reverted in one click, unless the issue changed since.
5. **Safer context.** Untrusted issue text returned to agents is marked and scanned for instruction-like content.
6. **Fast setup.** An admin registers an agent and connects a client in under 10 minutes.

## 3. Non-Goals

- **Not a general Jira client or replacement for Atlassian's Rovo MCP server.** JiraGuard is the governance layer; breadth of tools is secondary.
- **No guarantee of injection prevention.** Detection is heuristic. We reduce risk and make it visible; we do not claim to eliminate it.
- **No Confluence/Bitbucket tools in v1.** Jira only, to keep scope shippable.
- **No cross-site or multi-tenant SaaS backend.** Everything runs on Forge; no external servers.
- **No LLM-based judging of agent intent in v1.** Policy is deterministic and explainable.

## 4. Users and User Stories

**Personas:** Jira site admin (owns policy), Engineering lead (reviews approvals), Developer (runs agents), Security/compliance reviewer (audits).

**Site admin**
- As a site admin, I want to register an agent and get a token so that each agent has its own identity.
- As a site admin, I want to limit an agent to specific projects and tools so that a compromised agent has a small blast radius.
- As a site admin, I want to revoke an agent instantly so that I can stop misbehavior.

**Engineering lead**
- As an engineering lead, I want risky writes held for approval so that agents cannot silently reassign or close work.
- As an engineering lead, I want to see a diff of what an agent wants to change before I approve it.

**Developer**
- As a developer, I want my agent to ask what it is allowed to do (`guard_whoami`) so that it does not waste calls on denied actions.
- As a developer, I want clear denial messages that say what to do next so that my agent can recover.

**Security reviewer**
- As a security reviewer, I want a searchable, exportable audit log so that I can answer "what did agent X do last week?"
- As a security reviewer, I want alerts on unusual agent behavior (bulk reads, repeated denials) so that I can investigate early.
- As a security reviewer, I want injection-flagged content highlighted in the log so that I can see attempted attacks.

**Edge cases:** revoked token used (denied, logged); issue deleted before approval (approval fails cleanly); revert conflicts when a human edited the field afterward (revert refused with explanation); empty audit log (empty state with setup hint).

## 5. Requirements

### P0 — Must have (demo cannot work without these)

| # | Requirement | Acceptance criteria |
|---|---|---|
| P0-1 | **MCP endpoint** speaking Streamable HTTP (stateless JSON) with `initialize`, `tools/list`, `tools/call` | Given a valid agent token, when an MCP client connects and lists tools, then it receives only tools permitted by that agent's policy. Invalid/missing token returns 401 and is logged. |
| P0-2 | **Agent registry**: create, list, revoke agents; token shown once, stored hashed | Given an admin creates an agent, then a token is displayed once and only its hash is stored. Given an agent is revoked, then its next call is denied within 1 request. |
| P0-3 | **Policy enforcement**: allowed projects, allowed tools, write mode (`deny` / `approve` / `allow`) | Given agent policy allows project A only, when it requests an issue in project B, then the call is denied and logged. Search results never include issues outside allowed projects. |
| P0-4 | **Core Jira tools**: search, get issue, add comment, transition, assign, update fields | Each tool works end to end against a real Jira site and respects policy. |
| P0-5 | **Audit log** with agent, tool, target, outcome, timestamp, and before/after for writes | Every call (allowed, denied, pending) produces exactly one event. Admin page lists, filters by agent/outcome/date. |
| P0-6 | **Approval queue** for writes where mode = `approve` | Given an agent write under `approve`, then the tool returns `pending_approval` with an action id and nothing changes in Jira. Given an admin approves, then the change executes and is logged. Reject leaves Jira untouched. |
| P0-7 | **Untrusted-content handling**: wrap issue text returned to agents with provenance markers and scan for injection patterns | Given a comment containing instruction-like text, then the response flags it and the audit event records `injection_flagged`. Mode `annotate` is on by default. |
| P0-8 | **Installable** via the Forge install link with setup instructions | A reviewer follows the README and completes a tool call in under 10 minutes. |

### P1 — Nice to have (fast follows if time permits)

| # | Requirement | Acceptance criteria |
|---|---|---|
| P1-1 | **One-click revert** of logged field changes | Given a logged change with unchanged current value, revert restores it and logs the revert. Given a conflict, revert is refused with a clear message. |
| P1-2 | **Field-level allow-list** per agent | Agent may update `labels`, not `assignee`. Others denied. |
| P1-3 | **Rate limits and anomaly alerts** | Given an agent exceeds N reads per window, then it is throttled and an alert appears on the admin page. |
| P1-4 | **Issue panel** showing agent activity on that issue | Panel lists agent events for the open issue. |
| P1-5 | **Injection modes** `redact` and `block` in addition to `annotate` | Configurable per agent. |
| P1-6 | **Audit export** (JSON/CSV) | Export respects current filters. |
| P1-7 | **Marketplace submission** | Listing link or review ticket available for the Marketplace bonus. |

### P2 — Future considerations (design for, do not build)

- Confluence and Bitbucket tool families under the same policy engine.
- Policy-as-code (import/export YAML) and policy templates ("read-only triager", "doc-writer").
- Per-agent budgets (tokens, calls per day) and cost attribution.
- Forwarding audit events to a SIEM.
- Rovo agent integration so Rovo agents can call guarded tools.

## 6. Success Metrics

**Leading (measured in demo/testing before Dec 22)**
- Policy-bypass attempts in the test suite that succeed: **0** (target), stretch: 0 across 50 adversarial cases.
- Audit coverage: **100%** of tool calls produce an event.
- Time from install to first successful guarded tool call: **< 10 min** (stretch: < 5).
- Injection test corpus (comments/descriptions with hijack attempts): **≥ 80%** flagged (heuristic; report the real number honestly).

**Lagging (post-hackathon, if pursued)**
- Number of sites installing; number of active registered agents per site.
- Share of agent writes routed through approval vs auto-allowed.
- Judge/Marketplace feedback on usefulness.

## 7. Open Questions

| Question | Owner | Blocking? |
|---|---|---|
| What is the supported way for a Forge app to serve an MCP endpoint (webtrigger vs. another module), and how do clients authenticate to it? Eulo Labs' Bitbucket MCP shows it is possible. | Engineering (spike, week 1) | **Yes** |
| Forge runtime has no user context on webtrigger calls, so Jira writes run as the app. Is attributing changes to "the app + agent name in comment/audit" acceptable for the demo? | Engineering / design | No |
| Forge storage limits (entity size, query patterns, retention) vs. expected audit volume. | Engineering | No |
| Do the hackathon rules allow reuse of ideas/code from the existing agentic-firewall project? | Vasant (read the rules / email the hackathon manager) | **Yes** |
| How should an approver be notified (admin page badge only, or Jira notification/email)? | Design | No |
| Does an install link work smoothly for judges on a fresh Jira site? | Engineering | No |

## 8. Timeline Considerations

- **Hard deadline:** Dec 22, 2026, 12:00pm PST (submit on Devpost with install link, public YouTube demo under 5 min, category, explanation).
- **Phasing:** Wk 1 spike + scaffold · Wk 2 endpoint + registry + policy · Wk 3 audit + admin page · Wk 4 approvals + injection guard · Wk 5 P1 items (revert, rate limits) · Wk 6 polish, README, Marketplace prep · Wk 7 demo video, buffer, submit **at least 2 days early**.
- **Dependencies:** Atlassian developer account and a free Jira dev site; Forge CLI; ability to produce an install link.
- **Cut order if behind:** P1-7 → P1-6 → P1-5 → P1-4 → P1-3 → P1-2 → P1-1.
