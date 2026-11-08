# JiraGuard MCP Tool Specification

Design follows MCP server best practices: consistent `jira_` prefix, action-oriented names, concise descriptions, pagination on list tools, structured output, annotations, and actionable error messages. Transport: Streamable HTTP, stateless JSON.

## Conventions

- **Naming:** `jira_<verb>_<noun>`; one meta tool `guard_whoami`.
- **Response shape:** every tool returns human-readable text plus `structuredContent`.
- **Pagination:** list tools take `limit` (default 10, capped by policy `maxResults`) and `startAt`; return `total` and `nextStartAt`.
- **Annotations:** `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` set per tool (below).
- **User text in results** is wrapped as untrusted content (see ARCHITECTURE §5) and may include a `guard` object.

## Common result envelope

```json
{
  "status": "ok | denied | pending_approval | error",
  "data": { },
  "guard": { "flagged": false, "reasons": [] },
  "audit": { "eventId": "evt_123" }
}
```

## Tools

| Tool | Purpose | Key inputs | Write? | Annotations (RO / Destr / Idem / Open) |
|---|---|---|---|---|
| `guard_whoami` | Show this agent's name, allowed tools/projects, write mode, remaining rate limit | none | No | T / F / T / F |
| `jira_search_issues` | Search issues with JQL, restricted to allowed projects | `jql`, `fields?`, `limit`, `startAt` | No | T / F / T / T |
| `jira_get_issue` | Get one issue (summary, status, assignee, description, selected fields) | `issueKey`, `fields?` | No | T / F / T / T |
| `jira_list_transitions` | Show valid transitions for an issue | `issueKey` | No | T / F / T / T |
| `jira_add_comment` | Add a comment (prefixed with agent attribution) | `issueKey`, `body` | Yes | F / F / F / T |
| `jira_transition_issue` | Move an issue to a new status | `issueKey`, `transitionId` or `toStatus` | Yes | F / F / F / T |
| `jira_assign_issue` | Assign or unassign | `issueKey`, `accountId` or `null` | Yes | F / F / T / T |
| `jira_update_fields` | Update allow-listed fields (labels, priority, etc.) | `issueKey`, `fields` (object) | Yes | F / F / T / T |
| `jira_create_issue` (P1) | Create an issue in an allowed project | `project`, `issueType`, `summary`, `description?` | Yes | F / F / F / T |

No delete tool is exposed in v1 by design.

### Input schema notes (Zod)

- `issueKey`: string, regex `^[A-Z][A-Z0-9_]+-\d+$`. Example: `PROJ-123`.
- `jql`: string, max 1000 chars. The server appends the fragment from `searchProjectJql` and never trusts the agent's JQL to scope itself. Keys that match `^[A-Z][A-Z0-9_]+$` are quoted in `project in (...)`. If none match, the fragment is `id = 0`.
- `body`: string, max 10,000 chars.
- `fields`: object, only keys on the agent's `fieldAllowList`; unknown keys are rejected with the allowed list in the message.
- `limit`: integer 1-50, default 10.

## Write behavior by mode

| writeMode | Behavior |
|---|---|
| `deny` | Returns `status: "denied"` with reason. |
| `approve` | Returns `status: "pending_approval"` with `actionId` and a diff. Nothing changes in Jira until an admin approves. The diff lists each `fields` entry and, when the caller sent them, `body`, `transitionId`, `toStatus`, and `accountId`. |
| `allow` | Executes immediately; logs before/after. |

## Error messages (actionable)

Errors should tell the agent what to do next, without leaking existence of forbidden resources.

| Situation | Message |
|---|---|
| Tool not permitted | `Denied: this agent is not allowed to use jira_transition_issue. Allowed tools: jira_search_issues, jira_get_issue, jira_add_comment. Call guard_whoami for full details.` |
| Project/issue outside scope | `Denied: that issue is not available to this agent. Use jira_search_issues to find issues you can access.` |
| Field not allowed | `Denied: field 'assignee' is not editable by this agent. Editable fields: labels, priority.` |
| Pending approval | `Held for approval (action act_42). A Jira admin must approve before this change applies. Do not retry; check back later.` |
| Rate limited | `Rate limit reached (20 writes/hour). Retry after 14 minutes.` |
| Injection blocked | `Part of this issue's text was withheld because it looked like instructions aimed at AI agents. Summary fields are still available.` |
| Auth | `401: missing, invalid or revoked agent token.` |

## Evaluation Plan (per MCP builder guidance)

Create ~10 read-only evaluation questions against a seeded Jira dev site once tools work. Each must be independent, require multiple tool calls, have a single verifiable answer, and be stable over time. Seed data should be fixed and documented in the repo.

Example question shapes (fill in answers only after solving them yourself against the seeded site):
1. Which issues in project A labeled `release-blocker` are still unassigned? (search + get)
2. What is the oldest open bug in project A whose comments mention a specific component name?
3. Given agent policy X, which of these five issue keys can the agent open? (policy awareness via `guard_whoami` + attempts)

Separate **security evaluations** (adversarial cases from ARCHITECTURE §8) should be run as automated tests, not as LLM evals.

## Implementation notes

- TypeScript with the current stable MCP TypeScript SDK (v2: `@modelcontextprotocol/server`), Zod schemas, stateless JSON transport. The 4 Nov 2026 spike loaded `@modelcontextprotocol/server` 2.4.0 inside a Forge function. The spike handler was hand-written JSON-RPC, not the SDK transport. Zod was not included.
- Test with MCP Inspector before testing with real clients.
- Keep tool descriptions short; agents choose tools from them.
