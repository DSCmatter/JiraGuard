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
});
