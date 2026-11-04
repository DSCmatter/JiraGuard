# JiraGuard

**A governed MCP server for Jira.** Give each AI agent its own identity, permissions, approval rules and audit trail, all running inside Atlassian Forge.

> Working title. Built for Codegeist 2026. Commands and UI labels below are the target design; finalize them as the app is built.

## Why

Agents connected to Jira usually share one broad credential. JiraGuard lets you say: *this agent may read project PROJ, comment, and propose changes, but a human approves anything risky, and everything is logged.*

## Features

- Per-agent tokens with instant revocation
- Policy per agent: projects, tools, fields, write mode (`deny` / `approve` / `allow`), rate limits
- Approval queue with change diffs
- Audit log of every read and write, with before/after values
- Untrusted-content marking and prompt-injection scanning on issue text
- One-click revert of logged changes (P1)

## Quick Start (target: under 10 minutes)

**Prerequisites:** a Jira Cloud site, admin access, and the install link from the submission.

1. **Install** the app using the install link and approve the requested scopes (`read:jira-work`, `write:jira-work`, storage).
2. **Open** Jira → Apps → **JiraGuard** → **Agents** → **Create agent**.
3. **Set policy:** choose allowed projects, tools, and write mode. Start with `approve`.
4. **Copy the token.** It is shown once.
5. **Connect your MCP client** to the endpoint URL shown on the Agents page, using the token as a bearer token.

Example client configuration (shape varies by client):

```json
{
  "mcpServers": {
    "jira-guarded": {
      "url": "https://<your-endpoint-from-the-admin-page>",
      "headers": { "Authorization": "Bearer <AGENT_TOKEN>" }
    }
  }
}
```

6. **Verify:** ask the agent to call `guard_whoami`, then search an allowed project.

## Day-to-Day Admin

| Task | Where |
|---|---|
| Review held writes | Approvals tab → inspect diff → Approve / Reject |
| See what an agent did | Audit tab → filter by agent, outcome, date |
| Stop an agent | Agents tab → Revoke |
| Investigate an attack attempt | Audit tab → filter "injection flagged" |

## Runbook: Agent Misbehaving

**When to use:** an agent is making unexpected changes or reading too much.
1. **Revoke** the agent (Agents tab). Takes effect on its next request.
2. **Review** its recent events in the Audit tab.
3. **Revert** unwanted field changes (P1) or fix manually. Reverts fail if a human edited the field afterwards.
4. **Tighten policy** (switch to `approve`, reduce projects/tools), then issue a new token.
5. **Escalate** to your security contact if injection-flagged content is involved.

## Runbook: Removing the App

1. Revoke all agents and remove their tokens from client configs.
2. Export the audit log if you need it (P1).
3. Uninstall the app from Jira's Manage apps page. Stored app data is removed with the app **[VERIFY]**.

## Limitations

- Injection detection is heuristic and not a guarantee.
- Changes are executed as the app; Jira's native history shows the app, so use JiraGuard's audit log for agent attribution.
- Jira only in v1. No delete tool is exposed.
- Revert cannot undo deletions or effects outside Jira.

## Development

```bash
npm install -g @forge/cli
forge login
forge create            # or clone this repo
npm install
forge deploy
forge install           # choose Jira and your dev site
forge webtrigger list   # find the endpoint URL (if the endpoint is a webtrigger)
forge tunnel            # local development
```

Test the endpoint with MCP Inspector (`npx @modelcontextprotocol/inspector`).

## Third-Party Components and AI Use

List every library, its source and license here, plus any AI tools used in development and for what. Required for the submission.

| Component | Source | License | Purpose |
|---|---|---|---|
| (fill in) | | | |

## Docs

- [Collaborate](docs/COLLABORATING.md) · [Plan](PLAN.md) · [PRD](docs/PRD.md) · [Architecture](docs/ARCHITECTURE.md) · [MCP Tool Spec](docs/MCP_TOOL_SPEC.md) · [Requirements Check](docs/REQUIREMENTS_CHECK.md) · [Submission draft](docs/SUBMISSION.md)


- site url from atlassian: `https://jiraguard.atlassian.net/wiki/spaces/~712020ee715c8e61f84c38b855d0f46ceac863/pages/edit-v2/294914?draftShareId=4260e79e-fe64-40e2-88f0-bd717a3bc5c4&createdWithTemplate=true`
