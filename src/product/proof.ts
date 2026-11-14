import { DEFAULT_POLICY_LIMITS, isProjectKey } from "../domain/records.ts";
import { catalogToolNames } from "../gate/handle.ts";
import type { RecordStore } from "../storage/memory.ts";

const TOKEN_HASH = /^[0-9a-f]{64}$/;

export type ProofSpec = {
  tokenHash: string;
  project: string;
  name: string;
};

export async function ensureProofAgent(store: RecordStore, spec: ProofSpec): Promise<void> {
  if (!TOKEN_HASH.test(spec.tokenHash) || !isProjectKey(spec.project) || spec.name.trim() === "") {
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
    fieldAllowList: [...DEFAULT_POLICY_LIMITS.fieldAllowList],
    rateLimit: { ...DEFAULT_POLICY_LIMITS.rateLimit },
    maxResults: DEFAULT_POLICY_LIMITS.maxResults,
    injectionMode: DEFAULT_POLICY_LIMITS.injectionMode,
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
