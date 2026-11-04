# Codegeist 2026 Submission Draft

Deadline: **Dec 22, 2026, 12:00pm PST**. Aim to submit by Dec 19.

## Checklist

- [ ] Rules read; confirmed reuse of prior work (agentic-firewall ideas/code) is allowed
- [ ] Forge app deployed, **installation link** works on a fresh site (test with a second account)
- [ ] Instructions for judges (below) included in the submission
- [ ] Public YouTube demo **under 5 minutes** showing end-to-end flow and the MCP bonus specifics
- [ ] Category selected: **Apps for Software Teams**
- [ ] Bonus: **Best app with Atlassian MCP** (primary). Marketplace listing link or review ticket if pursuing that bonus
- [ ] Explanation of how it meets the technology requirement
- [ ] Third-party components and AI tool use disclosed in the README
- [ ] No secrets in the repo or video

## Short Description (draft)

JiraGuard is a Forge-hosted MCP server that lets teams connect AI agents to Jira safely: every agent gets its own token and policy, risky writes wait for human approval, issue text is scanned for prompt injection, and every action is audited.

## Technology Explanation (draft)

JiraGuard is built entirely on Forge and integrates with Jira through its REST API. It exposes an MCP server from the Forge app so any MCP client can connect. A policy engine enforces per-agent project, tool, and field limits; an approval queue holds risky writes; a content guard marks and scans untrusted issue text; and an append-only audit log in Forge storage records each call with before/after values. The admin experience is a Jira admin page. *(Adjust once the hosting approach is confirmed in the week-1 spike.)*

## Instructions for Judges (draft)

1. Open the install link and install on your Jira site.
2. Go to Apps → JiraGuard → Agents → Create agent (policy preset: "Triager, approve writes").
3. Copy the token and endpoint into an MCP client (or MCP Inspector).
4. Call `guard_whoami`, then `jira_search_issues` on the seeded project.
5. Ask the agent to transition an issue; see it held in **Approvals**; approve and watch it apply in **Audit**.
6. Open the seeded issue containing the malicious comment and ask the agent to summarize it; see the injection flag.

## Demo Video Script (target 4:30)

| Time | Beat | Show |
|---|---|---|
| 0:00 | Problem: agents with broad Jira access, no accountability | One slide or voiceover over Jira |
| 0:25 | Install and create an agent with a policy | Admin page, token shown once |
| 1:00 | Connect an MCP client; `guard_whoami` | Client + response |
| 1:25 | Allowed read and comment on project A | Tool calls, comment in Jira |
| 1:55 | Attempt on project B is denied (clear message) | Denial + audit row |
| 2:25 | Transition under `approve` → held → approve → applied | Approvals tab, diff |
| 3:00 | **Attack:** malicious comment tells the agent to reassign issues | Guard flags it; write held; audit shows `injection_flagged` |
| 3:45 | Revert a change; revoke the agent; next call fails | Audit tab, revoke |
| 4:15 | Recap + what's next (Marketplace, Confluence/Bitbucket) | Closing slide |

Tip: rehearse with seeded data so every beat works on the first take. Record a backup take.

## Judging Criteria Mapping

| Criterion (20% each) | How JiraGuard addresses it |
|---|---|
| Technological Implementation | Forge-hosted MCP endpoint, policy engine, approval flow, storage, admin UI, Jira REST integration |
| Design | Clear admin page, diff-based approvals, readable audit timeline, actionable error messages |
| Potential Impact | Unblocks safe AI adoption for teams; auditability for security/compliance |
| Innovation | Governance layer for agents (per-agent scopes, approval, injection guard, revert), beyond a plain MCP wrapper. Note existing Forge MCP precedent (e.g., Bitbucket) and differentiate on these features |
| Presentation | Attack-and-defense demo with a clear story |

## Pre-Submission QA

- Fresh-site install by someone else; follow only the written instructions.
- Revoke/redo flows; empty states; error messages.
- Remove debug logging and test tokens.
- Confirm video is public and under 5 minutes.
