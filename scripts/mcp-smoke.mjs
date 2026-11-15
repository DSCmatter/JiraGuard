#!/usr/bin/env node
// Manual smoke test for the deployed JiraGuard MCP endpoint.
//
// Usage:
//   node scripts/mcp-smoke.mjs <endpointUrl> <token> [issueKey]
//   node scripts/mcp-smoke.mjs            (reads JIRAGUARD_ENDPOINT, JIRAGUARD_TOKEN, JIRAGUARD_ISSUE)
//
// endpointUrl is the Endpoint URL field on the JiraGuard Agents tab.
// token is shown once when you create an agent.
// issueKey is optional. Without it the write and read-one tests are skipped
// and only the protocol, whoami, search and auth tests run.

const [endpointArg, tokenArg, issueArg] = process.argv.slice(2);
const endpoint = endpointArg ?? process.env.JIRAGUARD_ENDPOINT;
const token = tokenArg ?? process.env.JIRAGUARD_TOKEN;
const issueKey = issueArg ?? process.env.JIRAGUARD_ISSUE;

if (!endpoint || !token) {
  console.error("usage: node scripts/mcp-smoke.mjs <endpointUrl> <token> [issueKey]");
  console.error("   or: set JIRAGUARD_ENDPOINT, JIRAGUARD_TOKEN and optionally JIRAGUARD_ISSUE");
  process.exit(2);
}

let nextId = 0;

async function rpc(method, params, auth = token) {
  nextId += 1;
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (auth !== null) {
    headers.authorization = `Bearer ${auth}`;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId, method, params }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

function show(label, result) {
  console.log(`\n== ${label}`);
  console.log(`HTTP ${result.status}`);
  if (!result.json) {
    console.log(result.text.slice(0, 500));
    return;
  }
  const { error, result: payload } = result.json;
  if (error) {
    console.log(`rpc error ${error.code}: ${error.message}`);
    return;
  }
  if (payload?.content) {
    const guard = payload.structuredContent;
    console.log(`status: ${guard?.status}${guard?.flagged ? " (injection flagged)" : ""}`);
    if (guard?.message) console.log(`message: ${guard.message}`);
    console.log(`isError: ${payload.isError}`);
    console.log(JSON.stringify(guard?.data, null, 2));
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

const init = await rpc("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "jiraguard-smoke", version: "1" },
});
show("initialize", init);

const list = await rpc("tools/list", {});
show("tools/list", list);
const allowed = new Set((list.json?.result?.tools ?? []).map((tool) => tool.name));

const whoami = await rpc("tools/call", { name: "guard_whoami", arguments: {} });
show("tools/call guard_whoami", whoami);

const who = whoami.json?.result?.structuredContent?.data ?? {};
const project = Array.isArray(who.allowedProjects) ? who.allowedProjects[0] : null;

const search = await rpc("tools/call", {
  name: "jira_search_issues",
  arguments: project ? { jql: `project = ${project}`, limit: 5 } : { jql: "created >= -30d", limit: 5 },
});
show("tools/call jira_search_issues", search);

if (issueKey) {
  show(
    "tools/call jira_get_issue",
    await rpc("tools/call", { name: "jira_get_issue", arguments: { issueKey } }),
  );

  if (allowed.has("jira_add_comment")) {
    show(
      "tools/call jira_add_comment",
      await rpc("tools/call", {
        name: "jira_add_comment",
        arguments: { issueKey, body: "JiraGuard smoke test comment. Safe to delete." },
      }),
    );
  }
}

const closed = ["jira_add_comment", "jira_assign_issue", "jira_update_fields", "jira_get_issue"].filter(
  (name) => !allowed.has(name),
);
if (closed.length > 0) {
  show(
    `tools/call ${closed[0]} (not granted)`,
    await rpc("tools/call", { name: closed[0], arguments: { issueKey: issueKey ?? "SPIKE-1" } }),
  );
} else {
  console.log("\n== denied test skipped, every catalog tool is granted");
}

show("tools/call guard_whoami with a bad token", await rpc("tools/call", { name: "guard_whoami", arguments: {} }, "bad-token"));

show("tools/call guard_whoami with no token", await rpc("tools/call", { name: "guard_whoami", arguments: {} }, null));
