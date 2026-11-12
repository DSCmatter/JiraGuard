import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashToken, registerAgent, resolveToken, revokeAgent } from "../auth/token.ts";
import { createMemoryStore } from "./memory.ts";

const TOKEN = "jiraguard-test-token";
const TOKEN_HASH = "d3b674a4f528abc8c69723fa2e110938a7d3283e4b7a46d0c9094f54e5dccdf4";

describe("agent records", () => {
  it("stores the hash and resolves only an active token", async () => {
    const store = createMemoryStore();
    const policy = await store.createPolicy({
      allowedTools: ["jira_get_issue"],
      allowedProjects: ["PROJ"],
      writeMode: "approve",
      fieldAllowList: ["labels"],
      rateLimit: { reads: 120, writes: 20, windowSeconds: 3600 },
      maxResults: 25,
      injectionMode: "annotate",
    });
    assert.equal(hashToken(TOKEN), TOKEN_HASH);
    const { agent, token } = await registerAgent(store, {
      name: "triager",
      description: "reads project PROJ",
      created_by: "admin",
      policy_id: policy.id,
    });

    assert.equal(agent.token_hash, hashToken(token));
    assert.equal(JSON.stringify(agent).includes(token), false);
    assert.equal((await store.getAgent(agent.id))?.token_hash, hashToken(token));
    assert.equal(JSON.stringify(await store.getAgent(agent.id)).includes(token), false);
    assert.equal((await resolveToken(store, token))?.id, agent.id);

    await revokeAgent(store, agent.id);
    assert.equal(await resolveToken(store, token), null);
    assert.equal((await store.getAgent(agent.id))?.status, "revoked");
  });

  it("round-trips a policy, an audit event, and a pending action", async () => {
    const store = createMemoryStore();
    const policy = await store.createPolicy({
      allowedTools: ["jira_search_issues", "jira_get_issue", "jira_add_comment"],
      allowedProjects: ["PROJ", "DOCS"],
      writeMode: "approve",
      fieldAllowList: ["labels", "priority"],
      rateLimit: { reads: 120, writes: 20, windowSeconds: 3600 },
      maxResults: 25,
      injectionMode: "annotate",
    });
    const storedPolicy = await store.getPolicy(policy.id);
    assert.deepEqual(storedPolicy, policy);
    assert.deepEqual(await store.listPolicies(), [policy]);

    const event = await store.appendAudit({
      agentId: "agt_1",
      tool: "jira_get_issue",
      issueKey: "PROJ-1",
      project: "PROJ",
      outcome: "allowed",
      reason: null,
      before: { labels: ["old"] },
      after: { labels: ["release-blocker"], priority: { name: "High" } },
      injectionFlagged: false,
      requestId: "req_1",
    });
    const other = await store.appendAudit({
      agentId: "agt_2",
      tool: "jira_get_issue",
      issueKey: "DOCS-2",
      project: "DOCS",
      outcome: "denied",
      reason: "project",
      before: null,
      after: null,
      injectionFlagged: false,
      requestId: "req_2",
    });

    assert.deepEqual(await store.listAudits({ agentId: "agt_1" }), [event]);
    assert.deepEqual(await store.listAudits({ outcome: "denied" }), [other]);
    assert.deepEqual(await store.listAudits({ issueKey: "PROJ-1" }), [event]);
    assert.equal((await store.listAudits()).length, 2);
    assert.deepEqual(await store.listAudits({ agentId: "agt_1", from: event.ts, to: event.ts }), [event]);
    assert.deepEqual(await store.listAudits({ to: "2000-01-01T00:00:00.000Z" }), []);

    const action = await store.createPending({
      agentId: "agt_1",
      tool: "jira_add_comment",
      args: { issueKey: "PROJ-1", accountId: null, fields: { labels: ["release-blocker"] } },
      issueKey: "PROJ-1",
      diff: [{ field: "labels", before: ["old"], after: ["release-blocker"] }],
    });
    assert.equal(action.status, "pending");
    assert.equal(action.decidedBy, null);
    assert.deepEqual(await store.getPending(action.id), action);
    assert.deepEqual(await store.listPending({ status: "pending" }), [action]);
    assert.deepEqual(await store.listPending({ status: "approved" }), []);
  });
});
