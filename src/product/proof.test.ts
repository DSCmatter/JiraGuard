import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { revokeAgent } from "../auth/token.ts";
import { createMemoryStore } from "../storage/memory.ts";
import { ensureProofAgent } from "./proof.ts";

const HASH = createHash("sha256").update("proof-token").digest("hex");

describe("proof agent", () => {
  it("creates one agent and leaves a revoked row revoked", async () => {
    const store = createMemoryStore();
    await ensureProofAgent(store, { tokenHash: HASH, project: "SPIKE", name: "proof" });
    await ensureProofAgent(store, { tokenHash: HASH, project: "SPIKE", name: "proof" });
    const agents = await store.listAgents();
    assert.equal(agents.length, 1);
    const agent = agents[0];
    assert.ok(agent);
    await revokeAgent(store, agent.id);
    await ensureProofAgent(store, { tokenHash: HASH, project: "SPIKE", name: "proof" });
    assert.equal((await store.getAgent(agent.id))?.status, "revoked");
  });
});
