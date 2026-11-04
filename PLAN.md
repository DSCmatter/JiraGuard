# PLAN: Build JiraGuard

An agent implements this repository by finishing Phases 0–11 in order. Start a phase only after the previous phase's completion criterion is true. The Marketplace track sits beside those phases; its completion does not gate Phase 1. Leave `npm test` green at the end of every phase.

This file is the sequence and the done-checks. Product behavior stays in the docs below. When this plan and a doc disagree on **order**, follow this plan. When they disagree on **behavior**, follow the doc.

## Sources

Read a doc when the work touches the trigger. Leave it unread otherwise.

| Trigger | Doc |
|---|---|
| Endpoint hosting, request lifecycle, data shapes, threat model, fail-closed rule, manifest sketch | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| P0 and P1 acceptance, personas, metrics, open questions | [docs/PRD.md](docs/PRD.md) |
| Tool names, inputs, annotations, write modes, denial text | [docs/MCP_TOOL_SPEC.md](docs/MCP_TOOL_SPEC.md) |
| Judge steps, video beats, submission checklist | [docs/SUBMISSION.md](docs/SUBMISSION.md) |
| What is already unmet against the Codegeist rules | [docs/REQUIREMENTS_CHECK.md](docs/REQUIREMENTS_CHECK.md) |
| Install language and admin runbooks | [README.md](README.md) |

## Invariants

These hold on every phase.

1. The app runs entirely on Forge. Jira is reached with `asApp()`. Audit, agents, policies, and pending actions live in Forge storage.
2. Fail closed. If policy or audit storage cannot be read or written, deny the call and still attempt to record `auth_failed` or `denied` when storage allows it.
3. Policy narrows the app's installed scopes. A decision never adds a project, tool, or field.
4. Every MCP call writes exactly one `audit_event`, including unknown tokens, denials, and writes that are waiting for approval.
5. Persist the SHA-256 hash of an agent token. Show the raw token once, in the create-agent response. Keep raw tokens out of logs, errors, and audit payloads.
6. `jira_search_issues` appends `AND project in (<allowedProjects>)` on the server. That clause is the scope boundary. Client JQL is passed through as data.
7. A write whose policy `writeMode` is `approve` leaves Jira unchanged until an admin approves that pending action.
8. User-authored text returned to an agent is wrapped with the untrusted-content marker in ARCHITECTURE §5.

## Starting state

The repo contains planning docs, `README.md`, `LICENSE`, and `.gitignore`. There is no `manifest.yml`, `package.json`, or `src/`. Deadline: **22 Dec 2026, 12:00 PST**. Have the submission package ready by **19 Dec 2026**.

Two facts need a human:

- **Prior-work rule.** PRD §7 asks whether Codegeist allows reuse of agentic-firewall ideas or code. Until the answer is yes, write this app from the docs in this repo.
- **Atlassian account.** `forge login`, deploy, and install use the human's account and a Jira Cloud site. Ask for that once, at the start of Phase 0, then keep going on everything that does not need the network.

## Target modules

Phase 0 may be a single function. Phase 1 moves that function into this layout. Later phases fill the files. Policy decides; Jira code performs; the MCP handler is the only writer of audit events.

```
manifest.yml
package.json
src/index.ts            # Forge exports: mcpHandler, adminResolver
src/mcp/dispatch.ts     # initialize, tools/list, tools/call
src/auth/token.ts       # hash, lookup, revoke
src/policy/types.ts
src/policy/decide.ts    # pure: request → allow | deny | needs_approval
src/jira/client.ts      # asApp() REST
src/jira/tools.ts       # P0 tool executors
src/guard/untrusted.ts  # wrap + scan
src/audit/log.ts
src/approval/queue.ts
src/admin/resolver.ts
src/storage/index.ts
```

`decide` returns a discriminated union:

- `allow`
- `deny` with `reason` (for the audit row) and `agentMessage` (from MCP_TOOL_SPEC)
- `needs_approval` with the diff a human will read

Callers switch on `kind` and handle the remaining case with a `never` check.

## Phase 0 — Prove the transport

This phase decides whether the Atlassian MCP bonus is reachable. Feature work waits on it.

1. Scaffold a Forge app in this repo and deploy it.
2. Serve stateless JSON-RPC from the webtrigger in the ARCHITECTURE §7 manifest sketch. Implement `initialize`, `tools/list`, and `tools/call`.
3. Require `Authorization: Bearer <token>`. A missing, unknown, or revoked token returns HTTP 401 with the auth message in MCP_TOOL_SPEC.
4. Ship one tool, `guard_whoami`, so a client can prove the round trip.
5. Try the current MCP TypeScript SDK inside the Forge function. If the runtime rejects it, implement those three methods directly and record that choice.
6. From the deployed URL, run MCP Inspector through `initialize`, `tools/list`, and `tools/call` of `guard_whoami`.
7. On the same deploy, observe and write down the `[VERIFY]` items in ARCHITECTURE: webtrigger size and timeout, whether a client works without SSE or a session id, what a Jira comment shows after one `asApp()` write, and Forge storage limits for an append-only event. Replace each `[VERIFY]` with the observed fact. Confirm the scope keys the install screen accepts (`read:jira-work`, `write:jira-work`, `storage:app` are the sketch).

**Completion:** MCP Inspector, pointed at the deployed URL, finishes `initialize`, `tools/list`, and `guard_whoami` with a valid bearer token, and receives 401 without one. `docs/ARCHITECTURE.md` records observed facts in place of each `[VERIFY]` on endpoint hosting, `asApp()` attribution, and storage limits. If the webtrigger cannot complete that Inspector session, record the Forge module that can, point the manifest at it, and reach the same completion on that module before Phase 1.

## Marketplace track

Parallel to Phases 1–10. Start it as soon as Phase 0's install link works, then continue with Phase 1 in the same session. Review time is the long pole, so this track stays ahead of Phase 10 items. Waiting on the Marketplace completion before Phase 1 is a stall.

1. Prepare the listing: short description from SUBMISSION.md, scope justification, data handling (Forge storage only, token hashes, Forge-only runtime), and the admin-page screenshots once Phase 7 exists.
2. Hand the human the Marketplace submission or the review ticket.
3. Put the listing link or review ticket URL in SUBMISSION.md and REQUIREMENTS_CHECK.

**Completion:** SUBMISSION.md contains a Marketplace listing link or a review ticket id.

## Phase 1 — Storage and domain types

1. Add the four entities in ARCHITECTURE §4: `agent`, `policy`, `audit_event`, `pending_action`, including the indexes that section names.
2. Implement create, get, and list for each entity the P0 flow uses. `audit_event` exposes create and list only.
3. Add `src/auth/token.ts`: generate a token, store only its hash, resolve hash to agent, mark revoked.
4. Put a `test` script in `package.json` and add unit tests for hash stability and "revoked agent does not resolve."

**Completion:** A test creates an agent, stores a policy, appends an audit event, and creates a pending action, then reads each one back with the same fields ARCHITECTURE §4 lists. `npm test` passes. Raw token values are absent from stored records.

## Phase 2 — Registry and policy

1. Implement `decide` as a pure function. Inputs: agent policy, tool name, issue or project target, and (for writes) the fields being changed. Outputs: the union in Target modules.
2. Enforce P0-3: `allowedTools`, `allowedProjects`, and `writeMode` of `deny` | `approve` | `allow`. Unknown tools and projects take the deny branch. Empty allow-lists deny.
3. Denial text matches the rows in MCP_TOOL_SPEC, including the opaque project denial.
4. Create, list, and revoke live on the auth and storage modules. Phase 7's admin page is what shows the token once. Revocation is visible on the next `tools/call` (P0-2).
5. Table-test `decide`: allowed project, other project, tool missing from the list, each write mode, revoked agent handled before `decide`.

**Completion:** The table tests cover every acceptance line of PRD P0-2 and P0-3 that does not need a live Jira write. A revoked token's next call is denied. `npm test` passes.

## Phase 3 — Jira tools

Implement the P0 tools in MCP_TOOL_SPEC. `jira_create_issue` stays out until Phase 10.

1. `guard_whoami` returns the agent name, allowed tools, allowed projects, write mode, and the policy's rate-limit numbers. Enforcement of those numbers is Phase 10.
2. `jira_search_issues`, `jira_get_issue`, `jira_list_transitions`, `jira_add_comment`, `jira_transition_issue`, `jira_assign_issue`, `jira_update_fields`.
3. Validate inputs with the schema notes in MCP_TOOL_SPEC (`issueKey` pattern, `jql` length, `body` length, `limit` 1–50 default 10).
4. Comments written by the app include the agent name so Jira's own history can be read alongside the audit log (ARCHITECTURE D4).
5. `tools/list` returns only tools on that agent's `allowedTools`, with the annotations in the spec.
6. Wire the handler: parse JSON-RPC, authenticate, `decide`, then either deny, hold, or execute. Malformed JSON-RPC returns an error and an audit row.

**Completion:** Against the dev site, an agent allowed only project A can search and comment in A. The same agent searching or reading project B is denied, and the search payload contains no B issues. Each tool's annotations match the spec table. `npm test` passes.

## Phase 4 — Audit

1. The handler writes one `audit_event` per call after the outcome is known: `allowed`, `denied`, `pending`, or `auth_failed`. Include agent, tool, target, timestamp, and request id.
2. Writes that execute store `before` and `after` for the fields the tool changed.
3. Admin resolver lists events and filters by agent, outcome, and date.
4. A failing storage write on the audit append denies the Jira side effect when the effect has not already been sent. When the effect already landed, record the failure in the function log and surface it on the admin page.

**Completion:** A scripted session of one allowed read, one denial, and one auth failure produces three events, and the admin list shows those three with the filters returning the matching subset. PRD P0-5 holds for this session. `npm test` passes.

## Phase 5 — Approvals

1. When `decide` returns `needs_approval`, store a `pending_action` (args, issue key, diff, status `pending`) and return `status: "pending_approval"` plus `actionId`. Return before any Jira write.
2. Admin queue lists pending rows with agent, issue, and diff.
3. Approve runs the original tool once, then writes an `approved` audit event with before/after. Reject writes `rejected` and returns with Jira unchanged.
4. If the issue is gone, or the current field value no longer matches the diff's before-state, approval fails with the reason and leaves Jira unchanged.
5. The agent-facing pending message is the one in MCP_TOOL_SPEC. It tells the agent to wait for an admin.

**Completion:** With `writeMode: approve`, a transition is absent from the issue until approve, then present, with two audit events (`pending`, then `approved`). Reject on a second action leaves the issue as it was. PRD P0-6 holds. `npm test` passes.

## Phase 6 — Content guard

1. Wrap user-authored fields in tool results with the marker in ARCHITECTURE §5. Default `injectionMode` is `annotate`.
2. Scan wrapped text for instruction-like patterns (ignore previous instructions, requests to call tools, exfiltrate data, change assignees). On a hit, set `guard.flagged: true` with reasons, and set `injectionFlagged` on the audit event.
3. Keep a corpus of comments and descriptions as fixtures. Report the flagged share. The PRD target is at least 80 percent; publish the measured share in the test output summary.
4. `redact` and `block` wait for Phase 10. The mode field exists on the policy so later work turns them on without a migration.

**Completion:** A seeded comment that tells an agent to reassign issues comes back wrapped, `guard.flagged` true, and the matching audit row has `injectionFlagged` set. PRD P0-7 holds for mode `annotate`. `npm test` passes.

## Phase 7 — Admin page

Build the Jira admin page (`jira:adminPage`) for the three P0 jobs:

1. **Agents:** create, show token once, edit policy (projects, tools, write mode), revoke, show last used.
2. **Approvals:** queue, diff, approve, reject.
3. **Audit:** table, filters, detail of before/after and injection flag.
4. Empty audit shows the setup hint from the PRD edge cases (create an agent, connect a client).
5. Copy the endpoint URL onto the Agents page so the README quick start has a place to point.

**Completion:** A person who has only the README quick start can create an agent, connect MCP Inspector, call `guard_whoami`, and find the resulting audit row, without using the Forge CLI. PRD P0-8's "under 10 minutes" path is possible on this page.

## Phase 8 — P0 proof

Seed the dev site and keep the seed description in the repo (project keys, issue keys, the malicious comment). MCP_TOOL_SPEC's evaluation questions get their answers only after you run them against that seed.

Run, and record results in `docs/REQUIREMENTS_CHECK.md`:

1. PRD §5 P0-1 through P0-8, each acceptance line, on the deployed app.
2. The two demo cases in ARCHITECTURE §8: read and comment on the allowed project; a write under `approve` held, then approved and executed.
3. The edge case in that section: a malicious comment, the guard flag, and the write held.
4. An adversarial table of the classes in ARCHITECTURE §8 (cross-project read, tool not allowed, revoked token, malformed JSON-RPC, oversized input, injection corpus). Grow it toward 50 cases. Policy-bypass successes: **0**.

**Completion:** REQUIREMENTS_CHECK shows P0-1 through P0-8 met, with the command or Inspector session that proved each row. Adversarial bypass count is 0. `npm test` passes.

## Phase 9 — Rovo modules

The Agents bonus is a second entry point over the same executor. `decide`, the queue, the guard, and the audit writer stay the ones Phase 3–6 built.

1. Add `rovo:action` and `rovo:skill` modules that call the Phase 3 tools through `decide`, the approval queue, the content guard, and the audit writer.
2. A Rovo invocation that fails policy produces the same denial and the same audit outcome as the MCP call.

**Completion:** One Rovo skill runs an allowed read and one denied cross-project read. Both appear in the audit log with the same agent identity rules as MCP. REQUIREMENTS_CHECK's Agents row records the module keys.

Skip this phase only after Phase 8 is complete and the calendar is inside the submission buffer (Phase 11). Record the skip in REQUIREMENTS_CHECK.

## Phase 10 — P1, in keep-order

Build in this order. Stop at the first item that would push the Phase 11 package past 19 Dec 2026. Later items stay unbuilt.

1. **P1-1 Revert.** From an audit row whose current Jira value still equals `after`, write the stored `before` and log outcome `reverted`. If the current value differs, refuse and explain. Revert is a compensating update (ARCHITECTURE D8).
2. **P1-2 Field allow-list.** `jira_update_fields` accepts only keys on `fieldAllowList`. Other keys return the field-denied message listing the editable fields.
3. **P1-3 Rate limits.** Enforce `rateLimit` on the policy. Over the limit, throttle and show an alert on the admin page. The rate-limit message includes the retry wait.
4. **P1-4 Issue panel.** A panel on the open issue lists that issue's agent events.
5. **P1-5 Injection modes.** `redact` replaces flagged spans. `block` returns the withheld-text message for that field. `annotate` stays the default.
6. **P1-6 Audit export.** JSON and CSV of the current admin filters.
7. **`jira_create_issue`.** Allowed projects only, same write modes as other writes.

**Completion for each item:** its acceptance line in PRD §5 P1 is true on the dev site, and REQUIREMENTS_CHECK names the items that shipped. `npm test` passes.

## Phase 11 — Submission package

Follow SUBMISSION.md as the checklist. Bring it to done:

1. README third-party and AI-use table filled for every dependency and tool actually used.
2. Judge instructions match the deployed admin page labels and the seeded project.
3. Someone other than the author installs from the install link on a fresh site and completes one tool call using only the README.
4. Public YouTube video under 5 minutes. Show only behaviors the deployed build performs. Use the SUBMISSION.md beats that this build supports; the attack beat (malicious comment, flag, held write) stays in the video because it is P0.
5. Secrets scan of the repo and a pass over the video for tokens or site credentials.
6. Category **Apps for Software Teams**, bonus **Best app with Atlassian MCP**, plus the Agents bonus if Phase 9 shipped and the Marketplace bonus if that track completed.
7. Update REQUIREMENTS_CHECK to the submission-day snapshot.

**Completion:** Every checkbox in SUBMISSION.md is checked, the video URL is in that file, and the install link works on a site that did not previously have the app.

## Schedule pressure

P0 proof (Phase 8) outranks Phase 9 and Phase 10. The Marketplace track outranks Phase 10 items. Inside Phase 10, an unfinished later item is dropped before an earlier one is left half done.

The video, the Devpost form, `forge login`, and the Marketplace click are human actions. Prepare the artifact, name the action, and continue with the next agent-owned step.
