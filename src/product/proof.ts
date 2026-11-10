import { catalogToolNames } from "../gate/handle.ts";
import type { RecordStore } from "../storage/memory.ts";

const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;

export type ProofSpec = {
  tokenHash: string;
  project: string;
  name: string;
};

export async function ensureProofAgent(store: RecordStore, spec: ProofSpec): Promise<void> {
  if (!TOKEN_HASH.test(spec.tokenHash) || !PROJECT_KEY.test(spec.project) || spec.name.trim() === "") {
    throw new Error("JiraGuard proof agent is not configured.");
  }
  const existing = await store.getAgentByHash(spec.tokenHash);
  if (existing) {
    return;
  }
  const policy = await store.createPolicy({
    allowedTools: catalogToolNames(),
    allowedProjects: [spec.project],
    writeMode: "allow",
    fieldAllowList: [],
    rateLimit: { reads: 120, writes: 20, windowSeconds: 3600 },
    maxResults: 25,
    injectionMode: "annotate",
  });
  await store.putAgent({
    id: "agt_proof",
    name: spec.name,
    description: "",
    token_hash: spec.tokenHash,
    status: "active",
    created_by: "proof",
    created_at: new Date().toISOString(),
    last_used_at: null,
    policy_id: policy.id,
  });
}
