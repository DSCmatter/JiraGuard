import { randomBytes } from "node:crypto";
import type {
  AgentRecord,
  AuditEvent,
  NewAudit,
  NewPending,
  NewPolicy,
  PendingAction,
  PolicyRecord,
} from "../domain/records.ts";
import { auditMatches, type AuditQuery, type PendingQuery, type RecordStore } from "./memory.ts";

export type KeyValue = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  list(prefix: string): Promise<string[]>;
};

const AGENTS = "index:agents";
const POLICIES = "index:policies";
const PENDING = "index:pending";

export function createKvsStore(kv: KeyValue): RecordStore {
  return {
    async putAgent(agent) {
      await kv.set(agentKey(agent.id), agent);
      await kv.set(hashKey(agent.token_hash), agent.id);
      await addId(kv, AGENTS, agent.id);
    },
    async getAgent(id) {
      return readRecord<AgentRecord>(kv, agentKey(id));
    },
    async listAgents() {
      return readAll<AgentRecord>(kv, AGENTS, agentKey);
    },
    async getAgentByHash(tokenHash) {
      const id = await kv.get(hashKey(tokenHash));
      if (typeof id !== "string") {
        return null;
      }
      return readRecord<AgentRecord>(kv, agentKey(id));
    },
    async createPolicy(input) {
      const policy: PolicyRecord = { id: newId("pol"), ...input };
      await kv.set(policyKey(policy.id), policy);
      await addId(kv, POLICIES, policy.id);
      return policy;
    },
    async getPolicy(id) {
      return readRecord<PolicyRecord>(kv, policyKey(id));
    },
    async listPolicies() {
      return readAll<PolicyRecord>(kv, POLICIES, policyKey);
    },
    async appendAudit(input) {
      const event = auditFrom(input);
      await kv.set(auditKey(event.id), event);
      return event;
    },
    async listAudits(query) {
      const keys = await kv.list("audit:");
      const records: AuditEvent[] = [];
      for (const key of keys) {
        const event = await readRecord<AuditEvent>(kv, key);
        if (event && matchesAudit(event, query)) {
          records.push(event);
        }
      }
      return records;
    },
    async createPending(input) {
      const action = pendingFrom(input);
      await kv.set(pendingKey(action.id), action);
      await addId(kv, PENDING, action.id);
      return action;
    },
    async getPending(id) {
      return readRecord<PendingAction>(kv, pendingKey(id));
    },
    async listPending(query) {
      const actions = await readAll<PendingAction>(kv, PENDING, pendingKey);
      return actions.filter((action) => query?.status === undefined || action.status === query.status);
    },
  };
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function agentKey(id: string): string {
  return `agent:${id}`;
}

function hashKey(tokenHash: string): string {
  return `hash:${tokenHash}`;
}

function policyKey(id: string): string {
  return `policy:${id}`;
}

function auditKey(id: string): string {
  return `audit:${id}`;
}

function pendingKey(id: string): string {
  return `pending:${id}`;
}

function auditFrom(input: NewAudit): AuditEvent {
  return {
    id: newId("evt"),
    ts: input.ts ?? new Date().toISOString(),
    agentId: input.agentId,
    tool: input.tool,
    issueKey: input.issueKey,
    project: input.project,
    outcome: input.outcome,
    reason: input.reason,
    before: input.before,
    after: input.after,
    injectionFlagged: input.injectionFlagged,
    requestId: input.requestId,
  };
}

function pendingFrom(input: NewPending): PendingAction {
  return {
    id: newId("act"),
    agentId: input.agentId,
    tool: input.tool,
    args: input.args,
    issueKey: input.issueKey,
    diff: input.diff,
    status: "pending",
    createdAt: new Date().toISOString(),
    decidedBy: null,
    decidedAt: null,
  };
}

async function addId(kv: KeyValue, index: string, id: string): Promise<void> {
  const ids = await readIds(kv, index);
  if (ids.includes(id)) {
    return;
  }
  await kv.set(index, [...ids, id]);
}

async function readIds(kv: KeyValue, index: string): Promise<string[]> {
  const value = await kv.get(index);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

async function readRecord<T>(kv: KeyValue, key: string): Promise<T | null> {
  const value = await kv.get(key);
  return value === undefined || value === null ? null : (value as T);
}

async function readAll<T>(kv: KeyValue, index: string, keyFor: (id: string) => string): Promise<T[]> {
  const ids = await readIds(kv, index);
  const records: T[] = [];
  for (const id of ids) {
    const record = await readRecord<T>(kv, keyFor(id));
    if (record) {
      records.push(record);
    }
  }
  return records;
}

function matchesAudit(event: AuditEvent, query: AuditQuery | undefined): boolean {
  return auditMatches(event, query);
}
