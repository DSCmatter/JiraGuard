import { createHash, randomBytes } from "node:crypto";
import type { AgentRecord } from "../domain/records.ts";
import type { RecordStore } from "../storage/memory.ts";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function registerAgent(
  store: RecordStore,
  input: {
    name: string;
    description: string;
    created_by: string;
    policy_id: string;
  },
): Promise<{ agent: AgentRecord; token: string }> {
  const token = generateToken();
  const agent: AgentRecord = {
    id: `agt_${randomBytes(8).toString("hex")}`,
    name: input.name,
    description: input.description,
    token_hash: hashToken(token),
    status: "active",
    created_by: input.created_by,
    created_at: new Date().toISOString(),
    last_used_at: null,
    policy_id: input.policy_id,
  };
  await store.putAgent(agent);
  return { agent, token };
}

export async function resolveToken(store: RecordStore, token: string): Promise<AgentRecord | null> {
  const agent = await store.getAgentByHash(hashToken(token));
  if (!agent || agent.status !== "active") {
    return null;
  }
  return agent;
}

export async function revokeAgent(store: RecordStore, id: string): Promise<AgentRecord | null> {
  const agent = await store.getAgent(id);
  if (!agent) {
    return null;
  }
  const revoked: AgentRecord = { ...agent, status: "revoked" };
  await store.putAgent(revoked);
  return revoked;
}
