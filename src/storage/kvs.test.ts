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
      return [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
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
        return [...values.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value }));
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

  it("reads injection codes from audit rows written before the field existed", async () => {
    const kv = memoryKv();
    const older = {
      id: "evt_old",
      ts: "2026-11-15T12:44:00.000Z",
      agentId: "agt_1",
      tool: "jira_get_issue",
      issueKey: "SPIKE-1",
      project: "SPIKE",
      outcome: "allowed" as const,
      reason: null,
      before: null,
      after: null,
      injectionFlagged: true,
      requestId: "req_old",
    };
    const messy = {
      ...older,
      id: "evt_messy",
      ts: "2026-11-15T12:47:00.000Z",
      tool: "jira_search_issues",
      issueKey: null,
      injectionCodes: ["reassign", "not-a-code", "tool_request", "tool_request"],
    };
    await kv.set("audit:evt_old", older);
    await kv.set("audit:evt_messy", messy);
    await kv.set("index:audit-recent", [
      { id: "evt_messy", ts: messy.ts },
      { id: "evt_old", ts: older.ts },
    ]);
    const store = createKvsStore(kv);
    const listed = await store.listAudits();
    const byId = new Map(listed.map((event) => [event.id, event.injectionCodes]));
    assert.deepEqual(byId.get("evt_old"), []);
    assert.deepEqual(byId.get("evt_messy"), ["tool_request", "reassign"]);
    const recent = await store.recentAudits();
    assert.deepEqual(
      recent.map((event) => event.injectionCodes),
      [["tool_request", "reassign"], []],
    );
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

  it("keeps a revoke and a policy change that overlap", async () => {
    const store = createKvsStore(memoryKv());
    await store.putAgent({
      id: "agt_race",
      name: "race",
      description: "",
      token_hash: "cd".repeat(32),
      status: "active",
      created_by: "admin",
      created_at: "2026-11-14T00:00:00.000Z",
      last_used_at: null,
      policy_id: "pol_old",
    });
    await Promise.all([
      store.patchAgent("agt_race", { status: "revoked" }),
      store.patchAgent("agt_race", { policy_id: "pol_new" }),
    ]);
    const agent = await store.getAgent("agt_race");
    assert.equal(agent?.status, "revoked");
    assert.equal(agent?.policy_id, "pol_new");
  });

  it("lists both agents when two creates overlap", async () => {
    const store = createKvsStore(memoryKv());
    await Promise.all([
      store.putAgent({
        id: "agt_a",
        name: "a",
        description: "",
        token_hash: "aa".repeat(32),
        status: "active",
        created_by: "admin",
        created_at: "2026-11-14T00:00:00.000Z",
        last_used_at: null,
        policy_id: "pol_a",
      }),
      store.putAgent({
        id: "agt_b",
        name: "b",
        description: "",
        token_hash: "bb".repeat(32),
        status: "active",
        created_by: "admin",
        created_at: "2026-11-14T00:00:00.000Z",
        last_used_at: null,
        policy_id: "pol_b",
      }),
    ]);
    const ids = (await store.listAgents()).map((agent) => agent.id).sort();
    assert.deepEqual(ids, ["agt_a", "agt_b"]);
  });

  it("replaces an expired agent lock", async () => {
    const kv = memoryKv();
    const store = createKvsStore(kv);
    await store.putAgent({
      id: "agt_stale",
      name: "stale",
      description: "",
      token_hash: "ee".repeat(32),
      status: "active",
      created_by: "admin",
      created_at: "2026-11-14T00:00:00.000Z",
      last_used_at: null,
      policy_id: "pol_old",
    });
    await kv.set("lock:agent:agt_stale", { owner: "dead", expires: Date.now() - 1 });
    const patched = await store.patchAgent("agt_stale", { status: "revoked" });
    assert.equal(patched?.status, "revoked");
  });
});
