# JiraGuard

JiraGuard is a Forge app that lets a Jira admin connect an AI agent to Jira without handing it one broad credential. Each agent gets its own token and a policy. Risky writes wait for a person. Issue text is marked as untrusted and scanned for instruction-like content. Every call is written to an audit log.

Built for Codegeist 2026. Licensed under [MIT](LICENSE).

## What an admin can do

- Create an agent and copy its token once.
- Limit that agent to projects, tools, and a write mode: `deny`, `approve`, or `allow`.
- Hold a risky write, read the diff, and approve or reject it.
- Read an audit row for each call, including before and after values.
- See which injection matchers fired, written as `injection: tool_request, reassign`.
- Revoke an agent. The next call from that token fails.

The desk is under **Apps → JiraGuard**. A Jira admin can also open it from the gear menu, then **Apps**. Creating an agent, editing a policy, revoking an agent, and approving a write require the Jira Administer permission.

## Connect a client

1. Install the app on a Jira Cloud site and approve `read:jira-work`, `write:jira-work`, and app storage.
2. Open **JiraGuard**, then **Agents**, then **Create agent**. Start with write mode `approve`.
3. Copy the token. It is shown once.
4. Copy the endpoint URL on the Agents page.
5. Point an MCP client at that URL with the token as a bearer token.

```json
{
  "mcpServers": {
    "jira-guarded": {
      "url": "https://<endpoint-from-the-agents-page>",
      "headers": { "Authorization": "Bearer <AGENT_TOKEN>" }
    }
  }
}
```

6. Call `guard_whoami`, then `jira_search_issues` on an allowed project.

The other tools are `jira_get_issue`, `jira_list_transitions`, `jira_add_comment`, `jira_transition_issue`, `jira_assign_issue`, and `jira_update_fields`.

## Day to day

| Task | Where |
| --- | --- |
| Review a held write | Approvals tab. Read the diff, then Approve or Reject. |
| See what an agent did | Audit tab. Filter by agent, outcome, or date. |
| Stop an agent | Agents tab, then Revoke. The next request fails. |
| Look for an injection attempt | Audit tab. Turn on Injection flagged. Read the Reason cell. |

## Not in this version

- One-click revert of a logged change.
- Enforced rate limits.
- `jira_create_issue`.
- Injection modes other than annotate. Flagged text is wrapped and recorded. It is not redacted or blocked.

Injection detection is a set of matchers, not a guarantee. Jira records the write as the app, so use the JiraGuard audit log to see which agent acted.

## Develop

```bash
npm install
npm test
```

The Forge app lives in `product/`. From that directory, `npm install` and `npm run deploy` build the page and deploy the development environment. `npm test` at the repo root is the check for `src/`.

## Docs

- [Plan](PLAN.md)
- [PRD](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [MCP tool spec](docs/MCP_TOOL_SPEC.md)
- [How to collaborate](docs/COLLABORATING.md)
- [Submission draft](docs/SUBMISSION.md)

React 18 and the Forge SDK build the admin page. esbuild bundles it. Cursor was used during development.
