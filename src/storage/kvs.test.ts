import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createKvsStore, type KeyValue } from "./kvs.ts";

function memoryKv(): KeyValue {
  const values = new Map<string, unknown>();
  return {
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
    async create(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    async delete(key) {
      values.delete(key);
    },
    async list(prefix) {
      return [...values.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

describe("kvs store", () => {
  it("resolves an agent by token hash", async () => {
    const store = createKvsStore(memoryKv());
    const policy = await store.createPolicy({
      allowedTools: ["jira_get_issue"],
      allowedProjects: ["SPIKE"],
      writeMode: "allow",
      fieldAllowList: [],
      rateLimit: { reads: 1, writes: 1, windowSeconds: 60 },
      maxResults: 10,
      injectionMode: "annotate",
    });
    await store.putAgent({
      id: "agt_proof",
      name: "proof",
      description: "",
      token_hash: "ab".repeat(32),
      status: "active",
      created_by: "proof",
      created_at: "2026-11-10T00:00:00.000Z",
      last_used_at: null,
      policy_id: policy.id,
    });
    const agent = await store.getAgentByHash("ab".repeat(32));
    assert.equal(agent?.name, "proof");
    assert.equal((await store.getPolicy(policy.id))?.allowedProjects[0], "SPIKE");
  });

  it("lists both audits when the writes overlap", async () => {
    const values = new Map<string, unknown>();
    let gate = Promise.resolve();
    const kv: KeyValue = {
      async get(key) {
        return values.get(key);
      },
      async set(key, value) {
        const turn = gate;
        let release: () => void = () => undefined;
        gate = new Promise((resolve) => {
          release = resolve;
        });
        await turn;
        values.set(key, value);
        release();
      },
      async create(key, value) {
        if (values.has(key)) {
          return false;
        }
        values.set(key, value);
        return true;
      },
      async delete(key) {
        values.delete(key);
      },
      async list(prefix) {
        return [...values.keys()].filter((key) => key.startsWith(prefix));
      },
    };
    const store = createKvsStore(kv);
    const draft = {
      agentId: "agt_1",
      tool: "jira_get_issue",
      project: "SPIKE",
      outcome: "allowed" as const,
      reason: null,
      before: null,
      after: null,
      injectionFlagged: false,
    };
    await Promise.all([
      store.appendAudit({ ...draft, issueKey: "SPIKE-1", requestId: "a" }),
      store.appendAudit({ ...draft, issueKey: "SPIKE-2", requestId: "b" }),
    ]);
    const listed = await store.listAudits();
    assert.deepEqual(listed.map((event) => event.issueKey).sort(), ["SPIKE-1", "SPIKE-2"]);
  });

  it("keeps both actions when two holds overlap", async () => {
    const store = createKvsStore(memoryKv());
    const draft = {
      agentId: "agt_1",
      tool: "jira_add_comment",
      args: {},
      diff: [],
    };
    await Promise.all([
      store.createPending({ ...draft, issueKey: "ALPHA-1" }),
      store.createPending({ ...draft, issueKey: "ALPHA-2" }),
    ]);
    const listed = await store.listPending({ status: "pending" });
    assert.deepEqual(listed.map((action) => action.issueKey).sort(), ["ALPHA-1", "ALPHA-2"]);
  });

  it("lets one claim win when two claims overlap", async () => {
    const store = createKvsStore(memoryKv());
    const action = await store.createPending({
      agentId: "agt_1",
      tool: "jira_transition_issue",
      args: {},
      issueKey: "ALPHA-1",
      diff: [],
    });
    const claimed = await Promise.all([store.claimPending(action.id), store.claimPending(action.id)]);
    assert.equal(claimed.filter((row) => row !== null).length, 1);
    assert.equal((await store.getPending(action.id))?.status, "claimed");
  });
});
