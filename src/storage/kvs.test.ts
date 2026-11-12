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
});
