// Forge custom-entity integers rejected Date.now() in the spike. ISO strings sort on a range index.

export type AgentStatus = "active" | "revoked";

export const WRITE_MODES = ["deny", "approve", "allow"] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

export type InjectionMode = "annotate" | "redact" | "block";

export const AUDIT_OUTCOMES = [
  "allowed",
  "denied",
  "pending",
  "approved",
  "rejected",
  "auth_failed",
  "reverted",
  "uncertain",
] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

export function isProjectKey(value: string): boolean {
  return PROJECT_KEY.test(value);
}

export type PendingStatus = "pending" | "claimed" | "approved" | "rejected" | "expired" | "uncertain";

export type RateLimit = {
  reads: number;
  writes: number;
  windowSeconds: number;
};

export type HiddenLimits = {
  fieldAllowList: string[];
  rateLimit: RateLimit;
  maxResults: number;
  injectionMode: InjectionMode;
};

export const DEFAULT_POLICY_LIMITS: HiddenLimits = {
  fieldAllowList: [],
  rateLimit: { reads: 120, writes: 20, windowSeconds: 3600 },
  maxResults: 25,
  injectionMode: "annotate",
};

export type AgentRecord = {
  id: string;
  name: string;
  description: string;
  token_hash: string;
  status: AgentStatus;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  policy_id: string;
};

export type PolicyRecord = {
  id: string;
  allowedTools: string[];
  allowedProjects: string[];
  writeMode: WriteMode;
  fieldAllowList: string[];
  rateLimit: RateLimit;
  maxResults: number;
  injectionMode: InjectionMode;
};

export type Json = null | string | number | boolean | Json[] | { [key: string]: Json };

export type AuditEvent = {
  id: string;
  ts: string;
  agentId: string;
  tool: string;
  issueKey: string | null;
  project: string | null;
  outcome: AuditOutcome;
  reason: string | null;
  before: Record<string, Json> | null;
  after: Record<string, Json> | null;
  injectionFlagged: boolean;
  requestId: string;
};

export type FieldDiff = {
  field: string;
  before: Json;
  after: Json;
};

export type PendingAction = {
  id: string;
  agentId: string;
  tool: string;
  args: Record<string, Json>;
  issueKey: string;
  diff: FieldDiff[];
  status: PendingStatus;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
};

export type NewPolicy = Omit<PolicyRecord, "id">;

export type NewAudit = Omit<AuditEvent, "id" | "ts"> & { ts?: string };

export type NewPending = Omit<PendingAction, "id" | "createdAt" | "decidedBy" | "decidedAt" | "status">;
