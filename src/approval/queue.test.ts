import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleMcp, seedProofAgent, type JiraWork } from "../gate/handle.ts";
import { createMemoryStore } from "../storage/memory.ts";
import { approvePending, listApprovalQueue, rejectPending } from "./queue.ts";

function call(token: string, id: number, args: Record<string, unknown>) {
  return {
    method: "POST",
    headers: { authorization: [`Bearer ${token}`] },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "jira_transition_issue", arguments: args },
    }),
  };
}

describe("approval queue", () => {
  it("holds a transition until approve, then runs it once", async () => {
    const store = createMemoryStore();
    const { token } = await seedProofAgent(store, {
      name: "proof",
      description: "",
      createdBy: "admin",
      allowedTools: ["jira_transition_issue"],
      allowedProjects: ["ALPHA"],
      writeMode: "approve",
      fieldAllowList: [],
      rateLimit: { reads: 10, writes: 10, windowSeconds: 60 },
      maxResults: 10,
    });
    let transitions = 0;
    const jira: JiraWork = {
      async search() {
        throw new Error("unexpected");
      },
      async getIssue() {
        return { key: "ALPHA-1", fields: { status: { name: "To Do" } } };
      },
      async listTransitions() {
        return [];
      },
      async addComment() {
        throw new Error("unexpected");
      },
      async transition() {
        transitions += 1;
      },
      async assign() {
        throw new Error("unexpected");
      },
      async updateFields() {
        throw new Error("unexpected");
      },
    };

    await handleMcp(call(token, 1, { issueKey: "ALPHA-1", toStatus: "Done" }), { store, jira });
    assert.equal(transitions, 0);
    const queue = await listApprovalQueue(store);
    assert.equal(queue.length, 1);
    assert.equal(queue[0]?.issueKey, "ALPHA-1");
    assert.equal(queue[0]?.agentName, "proof");
    const pending = await store.getPending(queue[0]!.id);
    assert.equal(pending?.diff[0]?.before, "To Do");

    const approved = await approvePending(store, jira, queue[0]!.id, "admin");
    assert.equal(approved.ok, true);
    assert.equal(transitions, 1);
    const outcomes = (await store.listAudits()).map((event) => event.outcome);
    assert.deepEqual(outcomes, ["pending", "approved"]);

    await handleMcp(call(token, 2, { issueKey: "ALPHA-1", toStatus: "Done" }), { store, jira });
    const second = await listApprovalQueue(store);
    const rejected = await rejectPending(store, second[0]!.id, "admin");
    assert.equal(rejected.ok, true);
    assert.equal(transitions, 1);
  });

  it("refuses approval when the status changed", async () => {
    const store = createMemoryStore();
    const { token } = await seedProofAgent(store, {
      name: "proof",
      description: "",
      createdBy: "admin",
      allowedTools: ["jira_transition_issue"],
      allowedProjects: ["ALPHA"],
      writeMode: "approve",
      fieldAllowList: [],
      rateLimit: { reads: 10, writes: 10, windowSeconds: 60 },
      maxResults: 10,
    });
    let reads = 0;
    let transitions = 0;
    const jira: JiraWork = {
      async search() {
        throw new Error("unexpected");
      },
      async getIssue() {
        reads += 1;
        return { key: "ALPHA-1", fields: { status: { name: reads === 1 ? "To Do" : "Done" } } };
      },
      async listTransitions() {
        return [];
      },
      async addComment() {
        throw new Error("unexpected");
      },
      async transition() {
        transitions += 1;
      },
      async assign() {
        throw new Error("unexpected");
      },
      async updateFields() {
        throw new Error("unexpected");
      },
    };
    await handleMcp(call(token, 1, { issueKey: "ALPHA-1", toStatus: "Done" }), { store, jira });
    const queue = await listApprovalQueue(store);
    const result = await approvePending(store, jira, queue[0]!.id, "admin");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "The issue changed since this action was requested.");
    }
    assert.equal(transitions, 0);
  });

  it("does not queue a transition when the current status cannot be read", async () => {
    const store = createMemoryStore();
    const { token } = await seedProofAgent(store, {
      name: "proof",
      description: "",
      createdBy: "admin",
      allowedTools: ["jira_transition_issue"],
      allowedProjects: ["ALPHA"],
      writeMode: "approve",
      fieldAllowList: [],
      rateLimit: { reads: 10, writes: 10, windowSeconds: 60 },
      maxResults: 10,
    });
    let transitions = 0;
    const jira: JiraWork = {
      async search() {
        throw new Error("unexpected");
      },
      async getIssue() {
        throw new Error("missing");
      },
      async listTransitions() {
        return [];
      },
      async addComment() {
        throw new Error("unexpected");
      },
      async transition() {
        transitions += 1;
      },
      async assign() {
        throw new Error("unexpected");
      },
      async updateFields() {
        throw new Error("unexpected");
      },
    };
    const response = await handleMcp(call(token, 1, { issueKey: "ALPHA-1", toStatus: "Done" }), { store, jira });
    const body = JSON.parse(response.body) as { result?: { structuredContent?: { status?: string } } };
    assert.equal(body.result?.structuredContent?.status, "error");
    assert.equal((await store.listPending()).length, 0);
    assert.equal(transitions, 0);
  });
});
