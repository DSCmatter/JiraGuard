import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleMcp, seedProofAgent, type JiraWork } from "../gate/handle.ts";
import { createMemoryStore } from "../storage/memory.ts";
import { approvePending, listApprovalQueue, rejectPending } from "./queue.ts";

function call(token: string, id: number, args: Record<string, unknown>, name = "jira_transition_issue") {
  return {
    method: "POST",
    headers: { authorization: [`Bearer ${token}`] },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
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

  it("keeps a failed write visible and does not run it again", async () => {
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
        throw new Error("Jira 500");
      },
      async assign() {
        throw new Error("unexpected");
      },
      async updateFields() {
        throw new Error("unexpected");
      },
    };
    await handleMcp(call(token, 1, { issueKey: "ALPHA-1", toStatus: "Done" }), { store, jira });
    const id = (await listApprovalQueue(store))[0]!.id;
    const failed = await approvePending(store, jira, id, "admin");
    assert.equal(failed.ok, false);
    const visible = await listApprovalQueue(store);
    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.status, "uncertain");
    assert.equal((await store.getPending(id))?.status, "uncertain");
    const again = await approvePending(store, jira, id, "admin");
    assert.equal(again.ok, false);
    assert.equal(transitions, 1);
    assert.equal((await store.listAudits()).some((event) => event.outcome === "uncertain"), true);
  });

  it("refuses a comment when the issue is gone and does not write it", async () => {
    const store = createMemoryStore();
    const { token } = await seedProofAgent(store, {
      name: "proof",
      description: "",
      createdBy: "admin",
      allowedTools: ["jira_add_comment"],
      allowedProjects: ["ALPHA"],
      writeMode: "approve",
      fieldAllowList: [],
      rateLimit: { reads: 10, writes: 10, windowSeconds: 60 },
      maxResults: 10,
    });
    let comments = 0;
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
        comments += 1;
        return { id: "10002" };
      },
      async transition() {
        throw new Error("unexpected");
      },
      async assign() {
        throw new Error("unexpected");
      },
      async updateFields() {
        throw new Error("unexpected");
      },
    };
    await handleMcp(call(token, 1, { issueKey: "ALPHA-1", body: "note" }, "jira_add_comment"), { store, jira });
    const id = (await listApprovalQueue(store))[0]!.id;
    const refused = await approvePending(store, jira, id, "admin");
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.reason, "That issue is no longer available.");
    }
    assert.equal(comments, 0);
    assert.equal((await store.getPending(id))?.status, "rejected");
  });

  it("keeps an interrupted claim on the queue", async () => {
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
    const id = (await listApprovalQueue(store))[0]!.id;
    const claimed = await store.claimPending(id);
    assert.equal(claimed?.status, "claimed");
    const visible = await listApprovalQueue(store);
    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.status, "claimed");
    const again = await approvePending(store, jira, id, "admin");
    assert.equal(again.ok, false);
    assert.equal(transitions, 0);
  });

  it("runs the transition once when two approvals race", async () => {
    const { store, token, jira, transitions, release } = await heldTransition();
    const id = (await listApprovalQueue(store))[0]!.id;
    const first = approvePending(store, jira, id, "one");
    const second = approvePending(store, jira, id, "two");
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const results = await Promise.all([first, second]);
    assert.equal(transitions(), 1);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(token.length > 0, true);
  });

  it("does not reject an action while approval is running", async () => {
    const { store, jira, transitions, release } = await heldTransition();
    const id = (await listApprovalQueue(store))[0]!.id;
    const approval = approvePending(store, jira, id, "admin");
    await new Promise((resolve) => setImmediate(resolve));
    const rejected = await rejectPending(store, id, "admin");
    release();
    const approved = await approval;
    assert.equal(rejected.ok, false);
    assert.equal(approved.ok, true);
    assert.equal(transitions(), 1);
  });
});

async function heldTransition() {
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
  let count = 0;
  let release: (value?: void) => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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
      count += 1;
      await gate;
    },
    async assign() {
      throw new Error("unexpected");
    },
    async updateFields() {
      throw new Error("unexpected");
    },
  };
  await handleMcp(call(token, 1, { issueKey: "ALPHA-1", toStatus: "Done" }), { store, jira });
  return { store, token, jira, transitions: () => count, release };
}
