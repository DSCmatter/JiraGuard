# Join the JiraGuard repo

After this guide you can clone the repo, call the deployed spike, and start Phase 4 without repeating Phase 0 through Phase 3.

The product is a Forge app that sits between AI agents and Jira. Each agent gets its own token and policy. Risky writes wait for a human. Every call is audited. Behavior lives in the product docs. Order of work lives in [PLAN.md](../PLAN.md).

Deadline for the Codegeist submission is 22 Dec 2026, 12:00 PST. Aim to have the package ready by 19 Dec 2026.

## Get access

Ask the repo owner for all three of these before you deploy.

1. Write access to [DSCmatter/JiraGuard](https://github.com/DSCmatter/JiraGuard).
2. Membership in the Forge developer space named JiraGuard. `forge deploy` fails without it.
3. Admin on the Jira site `jiraguard.atlassian.net`, if you will install or upgrade the app.

Install the Forge CLI and log in with your own Atlassian account.

```bash
npm install -g @forge/cli
forge login
forge whoami
```

The CLI wants Node.js 22 or 24. A newer Node can print a warning and still run. If a command fails in a way that looks like a runtime mismatch, switch to Node 22 and run the command again.

## Clone and read

```bash
git clone https://github.com/DSCmatter/JiraGuard.git
cd JiraGuard
```

Read in this order.

1. This file.
2. [PLAN.md](../PLAN.md), starting at Phase 4. Phase 0 through Phase 3 are already done.
3. The product doc for the phase you are in. [PLAN.md](../PLAN.md) names which file that is.

`spike/mcp-webtrigger` is a throwaway Forge app. It proved that a webtrigger can speak MCP. Build the product in the layout under Target modules in [PLAN.md](../PLAN.md). Leave the spike in place as evidence.

## Call the spike

The live app is `jiraguard-spike`, installed on `jiraguard.atlassian.net`. The handler is `spike/mcp-webtrigger/src/index.js`.

From that directory, list the endpoint.

```bash
cd spike/mcp-webtrigger
npm install
forge webtrigger list -e development -s jiraguard.atlassian.net -p jira
```

You should see one URL for the `mcp-endpoint` trigger. Save it as `spike/mcp-webtrigger/.webtrigger-url`. That filename is gitignored.

The raw bearer token is not in git. Ask the owner to send `spike/mcp-webtrigger/.spike-token` in a private channel. Put that file in the same directory. Git ignores it.

Confirm the endpoint with MCP Inspector. A call with the bearer token returns the spike agent. A call without the token returns HTTP 401.

```bash
npx @modelcontextprotocol/inspector --cli --transport http \
  --server-url "$(cat .webtrigger-url)" \
  --header "Authorization: Bearer $(cat .spike-token)" \
  --method tools/call --tool-name guard_whoami --tool-args-json "{}" \
  --format json --quiet
```

On Windows, read the two files into variables and pass those variables. Keep the token out of shell history if you can.

The site already has a Jira project named SPIKE and an issue SPIKE-1. A comment on that issue is from the app user `jiraguard-spike`. That is expected. Webtrigger calls have no human user, so Jira attributes `asApp()` writes to the app.

## Change code

Branch from `main`. Open a pull request back to `main`. Leave force-pushes of `main` to the owner.

To change the spike and deploy it:

```bash
cd spike/mcp-webtrigger
forge deploy -e development --non-interactive
```

If the deploy asks you to approve a major version, stop and tell the owner. A scope change bumps the major version and upgrades the install on the Jira site.

If you rotate the spike token, generate a new random token, put only its SHA-256 hex digest in `TOKEN_HASH` in `src/index.js`, store the raw token in `.spike-token`, deploy, and send the new raw token to the other person in a private channel.

Phase 3 and later work continue in the repo-root layout [PLAN.md](../PLAN.md) describes. `src/domain`, `src/storage`, `src/auth`, and `src/policy` are already there. The spike manifest already has an app id. A new product app needs its own `forge create` in the JiraGuard developer space, using a template that exists today. `webtrigger` exists. `hello-world` does not. This space rejects personal apps, so omit `--personal`.

## Keep secrets out of git

These files are gitignored. Leave them that way.

- `.spike-token`
- `.spike-token-hash`
- `.webtrigger-url`
- `node_modules/`

The hash in `src/index.js` is safe to commit. The raw token is not. Do not paste the token into a pull request, a commit message, or a doc.

## Where the decisions are

| Question | Read |
|---|---|
| What to build next, and how to tell it is done | [PLAN.md](../PLAN.md) Phase 4 |
| What the spike measured | [Architecture](ARCHITECTURE.md) section 10 |
| Tool names, inputs, and denial text | [MCP tool spec](MCP_TOOL_SPEC.md) |
| What the judges must receive | [Submission draft](SUBMISSION.md) |
