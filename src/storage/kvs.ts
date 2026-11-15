import { randomBytes } from "node:crypto";
import {
  injectionCodesFrom,
  type AgentRecord,
  type AuditEvent,
  type NewAudit,
  type NewPending,
  type NewPolicy,
  type PendingAction,
  type PolicyRecord,
} from "../domain/records.ts";
import {
  auditMatches,
  keepRecent,
  type AuditQuery,
  type PendingQuery,
  type RecordStore,
} from "./memory.ts";

export type KeyValue = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  create(key: string, value: unknown): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<Array<{ key: string; value: unknown }>>;
};

const AGENTS = "index:agents";
const POLICIES = "index:policies";
const RECENT = "index:audit-recent";
const LOCK_TTL_MS = 15_000;
const LOCK_WAIT_MS = 12_000;
const LOCK_PAUSE_MS = 50;

export function createKvsStore(kv: KeyValue): RecordStore {
  return {
    async putAgent(agent) {
      await writeAgent(kv, agent);
    },
    async patchAgent(id, patch) {
      return withLock(kv, `lock:agent:${id}`, async () => {
        const found = await readRecord<AgentRecord>(kv, agentKey(id));
        if (!found) {
          return null;
        }
        const next = { ...found, ...patch };
        await writeAgent(kv, next);
        return next;
      });
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
      await noteRecent(kv, event);
      await noteUse(kv, event);
      return event;
    },
    async listAudits(query) {
      const rows = await kv.list("audit:");
      const records: AuditEvent[] = [];
      for (const row of rows) {
        const event = asAudit(row.value);
        if (event && matchesAudit(event, query)) {
          records.push(event);
        }
      }
      return records;
    },
    async recentAudits() {
      const ids = await readRecent(kv);
      const records: AuditEvent[] = [];
      for (const id of ids) {
        const event = await readRecord<AuditEvent>(kv, auditKey(id));
        if (event) {
          records.push(withInjectionCodes(event));
        }
      }
      return records;
    },
    async lastUse(agentId) {
      const value = await kv.get(useKey(agentId));
      return typeof value === "string" ? value : null;
    },
    async createPending(input) {
      const action = pendingFrom(input);
      await kv.set(pendingKey(action.id), action);
      return action;
    },
    async getPending(id) {
      return readRecord<PendingAction>(kv, pendingKey(id));
    },
    async listPending(query) {
      const rows = await kv.list("pending:");
      const actions: PendingAction[] = [];
      for (const row of rows) {
        const action = row.value as PendingAction | null | undefined;
        if (action && (query?.status === undefined || action.status === query.status)) {
          actions.push(action);
        }
      }
      return actions;
    },
    async finishPending(id, status, decidedBy) {
      if (status === "expired") {
        const locked = await kv.create(claimKey(id), { id });
        if (!locked) {
          return null;
        }
      }
      const found = await readRecord<PendingAction>(kv, pendingKey(id));
      if (!found) {
        return null;
      }
      const claimed =
        found.status === "claimed" && (status === "approved" || status === "rejected" || status === "uncertain");
      const expire = found.status === "pending" && status === "expired";
      if (!claimed && !expire) {
        return null;
      }
      const finished: PendingAction = {
        ...found,
        status,
        decidedBy,
        decidedAt: new Date().toISOString(),
      };
      try {
        await kv.set(pendingKey(id), finished);
      } catch (error) {
        if (status === "expired") {
          await kv.delete(claimKey(id));
        }
        throw error;
      }
      return finished;
    },
    async claimPending(id) {
      const locked = await kv.create(claimKey(id), { id });
      if (!locked) {
        return null;
      }
      const found = await readRecord<PendingAction>(kv, pendingKey(id));
      if (!found || found.status !== "pending") {
        return null;
      }
      const claimed: PendingAction = { ...found, status: "claimed" };
      try {
        await kv.set(pendingKey(id), claimed);
      } catch (error) {
        await kv.delete(claimKey(id));
        throw error;
      }
      return claimed;
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

function useKey(agentId: string): string {
  return `use:${agentId}`;
}

async function noteRecent(kv: KeyValue, event: AuditEvent): Promise<void> {
  await withLock(kv, `lock:${RECENT}`, async () => {
    const rows = await readRecentRows(kv);
    await kv.set(RECENT, keepRecent(rows, { id: event.id, ts: event.ts }));
  });
}

async function noteUse(kv: KeyValue, event: AuditEvent): Promise<void> {
  const key = useKey(event.agentId);
  const current = await kv.get(key);
  if (typeof current === "string" && current >= event.ts) {
    return;
  }
  await kv.set(key, event.ts);
}

async function readRecent(kv: KeyValue): Promise<string[]> {
  const rows = await readRecentRows(kv);
  return rows.map((row) => row.id);
}

async function readRecentRows(kv: KeyValue): Promise<Array<{ id: string; ts: string }>> {
  const value = await kv.get(RECENT);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is { id: string; ts: string } =>
      !!item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as { id?: unknown }).id === "string" &&
      typeof (item as { ts?: unknown }).ts === "string",
  );
}

function pendingKey(id: string): string {
  return `pending:${id}`;
}

function claimKey(id: string): string {
  return `claim:${id}`;
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
    injectionCodes: injectionCodesFrom(input.injectionCodes ?? []),
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

async function writeAgent(kv: KeyValue, agent: AgentRecord): Promise<void> {
  await addId(kv, AGENTS, agent.id);
  await kv.set(agentKey(agent.id), agent);
  await kv.set(hashKey(agent.token_hash), agent.id);
}

async function addId(kv: KeyValue, index: string, id: string): Promise<void> {
  await withLock(kv, `lock:${index}`, async () => {
    const ids = await readIds(kv, index);
    if (!ids.includes(id)) {
      await kv.set(index, [...ids, id]);
    }
  });
}

async function withLock<T>(kv: KeyValue, lock: string, body: () => Promise<T>): Promise<T> {
  const owner = randomBytes(8).toString("hex");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (await takeLock(kv, lock, owner)) {
      try {
        return await body();
      } finally {
        const current = await kv.get(lock);
        if (isLock(current) && current.owner === owner) {
          await kv.delete(lock);
        }
      }
    }
    if (Date.now() > deadline) {
      throw new Error("update lost");
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_PAUSE_MS));
  }
}

async function takeLock(kv: KeyValue, lock: string, owner: string): Promise<boolean> {
  const record = { owner, expires: Date.now() + LOCK_TTL_MS };
  if (await kv.create(lock, record)) {
    return true;
  }
  const current = await kv.get(lock);
  if (isLock(current) && current.expires > Date.now()) {
    return false;
  }
  await kv.delete(lock);
  return kv.create(lock, record);
}

function isLock(value: unknown): value is { owner: string; expires: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as { owner?: unknown; expires?: unknown };
  return typeof record.owner === "string" && typeof record.expires === "number";
}

async function readIds(kv: KeyValue, index: string): Promise<string[]> {
  const value = await kv.get(index);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

// Rows written before injection codes existed omit the array. A stored list can also repeat a code or include a string that is not a matcher.
function asAudit(value: unknown): AuditEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return withInjectionCodes(value as AuditEvent);
}

function withInjectionCodes(event: AuditEvent): AuditEvent {
  const raw: unknown = event.injectionCodes;
  const codes = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  return { ...event, injectionCodes: injectionCodesFrom(codes) };
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
