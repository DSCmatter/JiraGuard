import { randomBytes } from "node:crypto";
import {
  injectionCodesFrom,
  type AgentRecord,
  type AuditEvent,
  type AuditOutcome,
  type NewAudit,
  type NewPending,
  type NewPolicy,
  type PendingAction,
  type PendingStatus,
  type PolicyRecord,
} from "../domain/records.ts";

export const RECENT_AUDIT_LIMIT = 50;

export type AuditQuery = {
  agentId?: string;
  outcome?: AuditOutcome;
  issueKey?: string;
  from?: string;
  to?: string;
  injectionFlagged?: true;
};

export function auditMatches(event: AuditEvent, query: AuditQuery | undefined): boolean {
  if (query?.agentId !== undefined && event.agentId !== query.agentId) {
    return false;
  }
  if (query?.outcome !== undefined && event.outcome !== query.outcome) {
    return false;
  }
  if (query?.issueKey !== undefined && event.issueKey !== query.issueKey) {
    return false;
  }
  if (query?.from !== undefined && earlier(event.ts, query.from)) {
    return false;
  }
  if (query?.to !== undefined && earlier(query.to, event.ts)) {
    return false;
  }
  if (query?.injectionFlagged === true && event.injectionFlagged !== true) {
    return false;
  }
  return true;
}

export function keepRecent<T extends { id: string; ts: string }>(rows: readonly T[], row: T): T[] {
  const next = [row, ...rows.filter((item) => item.id !== row.id)];
  next.sort((left, right) => (left.ts < right.ts ? 1 : left.ts > right.ts ? -1 : 0));
  return next.slice(0, RECENT_AUDIT_LIMIT);
}

function earlier(left: string, right: string): boolean {
  const start = Date.parse(left);
  const end = Date.parse(right);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return true;
  }
  return start < end;
}

export type PendingQuery = {
  status?: PendingStatus;
};

export type RecordStore = {
  putAgent(agent: AgentRecord): Promise<void>;
  patchAgent(
    id: string,
    patch: { status?: AgentRecord["status"]; policy_id?: string },
  ): Promise<AgentRecord | null>;
  getAgent(id: string): Promise<AgentRecord | null>;
  listAgents(): Promise<AgentRecord[]>;
  getAgentByHash(tokenHash: string): Promise<AgentRecord | null>;
  createPolicy(input: NewPolicy): Promise<PolicyRecord>;
  getPolicy(id: string): Promise<PolicyRecord | null>;
  listPolicies(): Promise<PolicyRecord[]>;
  appendAudit(input: NewAudit): Promise<AuditEvent>;
  listAudits(query?: AuditQuery): Promise<AuditEvent[]>;
  recentAudits(): Promise<AuditEvent[]>;
  lastUse(agentId: string): Promise<string | null>;
  createPending(input: NewPending): Promise<PendingAction>;
  getPending(id: string): Promise<PendingAction | null>;
  listPending(query?: PendingQuery): Promise<PendingAction[]>;
  finishPending(id: string, status: "approved" | "rejected" | "expired" | "uncertain", decidedBy: string): Promise<PendingAction | null>;
  claimPending(id: string): Promise<PendingAction | null>;
};

function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryStore(): RecordStore {
  const agents = new Map<string, AgentRecord>();
  const policies = new Map<string, PolicyRecord>();
  const audits: AuditEvent[] = [];
  const recent: AuditEvent[] = [];
  const uses = new Map<string, string>();
  const pending: PendingAction[] = [];

  return {
    async putAgent(agent) {
      agents.set(agent.id, copy(agent));
    },
    async patchAgent(id, patch) {
      const found = agents.get(id);
      if (!found) {
        return null;
      }
      const next = { ...found, ...patch };
      agents.set(id, next);
      return copy(next);
    },
    async getAgent(agentId) {
      const found = agents.get(agentId);
      return found ? copy(found) : null;
    },
    async listAgents() {
      return [...agents.values()].map((agent) => copy(agent));
    },
    async getAgentByHash(tokenHash) {
      for (const agent of agents.values()) {
        if (agent.token_hash === tokenHash) {
          return copy(agent);
        }
      }
      return null;
    },
    async createPolicy(input) {
      const policy: PolicyRecord = { id: id("pol"), ...copy(input) };
      policies.set(policy.id, policy);
      return copy(policy);
    },
    async getPolicy(policyId) {
      const found = policies.get(policyId);
      return found ? copy(found) : null;
    },
    async listPolicies() {
      return [...policies.values()].map((policy) => copy(policy));
    },
    async appendAudit(input) {
      const event: AuditEvent = {
        id: id("evt"),
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
      audits.push(copy(event));
      const kept = keepRecent(recent, event);
      recent.length = 0;
      recent.push(...kept.map((item) => copy(item)));
      const seen = uses.get(event.agentId);
      if (seen === undefined || seen < event.ts) {
        uses.set(event.agentId, event.ts);
      }
      return copy(event);
    },
    async listAudits(query) {
      return audits.filter((event) => auditMatches(event, query)).map((event) => copy(event));
    },
    async recentAudits() {
      return recent.map((event) => copy(event));
    },
    async lastUse(agentId) {
      return uses.get(agentId) ?? null;
    },
    async createPending(input) {
      const action: PendingAction = {
        id: id("act"),
        agentId: input.agentId,
        tool: input.tool,
        args: copy(input.args),
        issueKey: input.issueKey,
        diff: copy(input.diff),
        status: "pending",
        createdAt: new Date().toISOString(),
        decidedBy: null,
        decidedAt: null,
      };
      pending.push(action);
      return copy(action);
    },
    async getPending(actionId) {
      const found = pending.find((action) => action.id === actionId);
      return found ? copy(found) : null;
    },
    async listPending(query) {
      return pending
        .filter((action) => query?.status === undefined || action.status === query.status)
        .map((action) => copy(action));
    },
    async finishPending(actionId, status, decidedBy) {
      const found = pending.find((action) => action.id === actionId);
      if (!found) {
        return null;
      }
      const claimed =
        found.status === "claimed" && (status === "approved" || status === "rejected" || status === "uncertain");
      const expire = found.status === "pending" && status === "expired";
      if (!claimed && !expire) {
        return null;
      }
      found.status = status;
      found.decidedBy = decidedBy;
      found.decidedAt = new Date().toISOString();
      return copy(found);
    },
    async claimPending(actionId) {
      const found = pending.find((action) => action.id === actionId);
      if (!found || found.status !== "pending") {
        return null;
      }
      found.status = "claimed";
      return copy(found);
    },
  };
}
