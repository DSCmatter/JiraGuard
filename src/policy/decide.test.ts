import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerAgent, revokeAgent } from "../auth/token.ts";
import type { PolicyRecord, WriteMode } from "../domain/records.ts";
import { createMemoryStore } from "../storage/memory.ts";
import { decide, nextCall, searchProjectJql, type DecisionRequest } from "./decide.ts";

const OPAQUE =
  "Denied: that issue is not available to this agent. Use jira_search_issues to find issues you can access.";

function policy(overrides: Partial<PolicyRecord> = {}): PolicyRecord {
  return {
    id: "pol_1",
    allowedTools: ["guard_whoami", "jira_get_issue", "jira_search_issues", "jira_add_comment"],
    allowedProjects: ["PROJ"],
    writeMode: "approve",
    fieldAllowList: ["labels", "priority"],
    rateLimit: { reads: 120, writes: 20, windowSeconds: 3600 },
    maxResults: 25,
    injectionMode: "annotate",
    ...overrides,
  };
}

describe("decide", () => {
  const cases: Array<{ name: string; policy: PolicyRecord; request: DecisionRequest; kind: string; message?: string }> = [
    {
      name: "allowed project",
      policy: policy(),
      request: { tool: "jira_get_issue", issueKey: "PROJ-1" },
      kind: "allow",
    },
    {
      name: "other project",
      policy: policy(),
      request: { tool: "jira_get_issue", issueKey: "DOCS-9" },
      kind: "deny",
      message: OPAQUE,
    },
    {
      name: "tool missing",
      policy: policy(),
      request: { tool: "jira_transition_issue", issueKey: "PROJ-1" },
      kind: "deny",
      message:
        "Denied: this agent is not allowed to use jira_transition_issue. Allowed tools: guard_whoami, jira_get_issue, jira_search_issues, jira_add_comment. Call guard_whoami for full details.",
    },
    {
      name: "empty tool list",
      policy: policy({ allowedTools: [] }),
      request: { tool: "jira_get_issue", issueKey: "PROJ-1" },
      kind: "deny",
    },
    {
      name: "empty project list",
      policy: policy({ allowedProjects: [] }),
      request: { tool: "jira_get_issue", issueKey: "PROJ-1" },
      kind: "deny",
      message: OPAQUE,
    },
    {
      name: "write deny",
      policy: policy({ writeMode: "deny" satisfies WriteMode }),
      request: { tool: "jira_add_comment", issueKey: "PROJ-1" },
      kind: "deny",
    },
    {
      name: "write approve",
      policy: policy({ writeMode: "approve" }),
      request: { tool: "jira_add_comment", issueKey: "PROJ-1", fields: { body: "hello" } },
      kind: "needs_approval",
    },
    {
      name: "write allow",
      policy: policy({ writeMode: "allow" }),
      request: { tool: "jira_add_comment", issueKey: "PROJ-1" },
      kind: "allow",
    },
  ];

  for (const item of cases) {
    it(item.name, () => {
      const decision = decide(item.policy, item.request);
      assert.equal(decision.kind, item.kind);
      if (item.message && decision.kind === "deny") {
        assert.equal(decision.agentMessage, item.message);
      }
      if (item.name === "other project" && decision.kind === "deny") {
        assert.equal(decision.agentMessage.includes("DOCS"), false);
      }
    });
  }

  it("limits search to the allowed projects", () => {
    assert.equal(searchProjectJql(policy({ allowedProjects: ["PROJ"] })), 'project in ("PROJ")');
    assert.equal(searchProjectJql(policy({ allowedProjects: [] })), "project in ()");
  });

  it("denies a revoked token before deciding", async () => {
    const store = createMemoryStore();
    const saved = await store.createPolicy({
      allowedTools: ["jira_get_issue"],
      allowedProjects: ["PROJ"],
      writeMode: "allow",
      fieldAllowList: [],
      rateLimit: { reads: 1, writes: 1, windowSeconds: 60 },
      maxResults: 10,
      injectionMode: "annotate",
    });
    const { agent, token } = await registerAgent(store, {
      name: "triager",
      description: "",
      created_by: "admin",
      policy_id: saved.id,
    });
    await revokeAgent(store, agent.id);
    const decision = await nextCall(store, token, { tool: "jira_get_issue", issueKey: "PROJ-1" });
    assert.deepEqual(decision, {
      kind: "deny",
      reason: "auth",
      agentMessage: "401: missing, invalid or revoked agent token.",
    });
  });
});
