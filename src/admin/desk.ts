import { approvePending, listApprovalQueue, rejectPending, type QueueRow } from "../approval/queue.ts";
import { registerAgent, revokeAgent } from "../auth/token.ts";
import {
  AUDIT_OUTCOMES,
  DEFAULT_POLICY_LIMITS,
  WRITE_MODES,
  isProjectKey,
  type AgentRecord,
  type AuditEvent,
  type AuditOutcome,
  type Json,
  type PolicyRecord,
  type WriteMode,
} from "../domain/records.ts";
import { catalogToolNames, type JiraWork } from "../gate/handle.ts";
import { auditMatches, type AuditQuery, type RecordStore } from "../storage/memory.ts";

export type AccountId = string & { readonly __brand: "AccountId" };

export function parseAccountId(value: unknown): AccountId | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  return trimmed as AccountId;
}

export type AdminDeps = {
  store: RecordStore;
  jira: JiraWork;
  endpointUrl: string;
  actor: AccountId | null;
};

export type VisiblePolicy =
  | { kind: "set"; allowedProjects: string[]; allowedTools: string[]; writeMode: WriteMode }
  | { kind: "missing" };

export type AgentCard = {
  id: string;
  name: string;
  description: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
  policy: VisiblePolicy;
};

export type AuditCard = {
  id: string;
  ts: string;
  agentId: string;
  agentName: string;
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

export type AuditFilter = {
  agentId?: string;
  outcome?: AuditOutcome;
  from?: string;
  to?: string;
  injectionFlagged?: true;
};

export type DeskSnapshot = {
  endpointUrl: string;
  toolChoices: string[];
  writeModes: WriteMode[];
  outcomes: AuditOutcome[];
  agents: AgentCard[];
  approvals: QueueRow[];
  audit: {
    events: AuditCard[];
    empty: "setup" | "no-match" | "rows";
  };
};

export type AdminCommand =
  | { type: "open" }
  | {
      type: "createAgent";
      name: string;
      description: string;
      allowedProjects: string[];
      allowedTools: string[];
      writeMode: WriteMode;
    }
  | {
      type: "savePolicy";
      agentId: string;
      allowedProjects: string[];
      allowedTools: string[];
      writeMode: WriteMode;
    }
  | { type: "revoke"; agentId: string }
  | { type: "decide"; actionId: string; verdict: "approve" | "reject" }
  | { type: "filterAudit"; filter: AuditFilter };

export type AdminResult =
  | { type: "desk"; desk: DeskSnapshot }
  | { type: "created"; token: string; desk: DeskSnapshot }
  | { type: "rejected"; reason: string; desk: DeskSnapshot | null };

const FORBIDDEN_KEYS = new Set([
  "fieldAllowList",
  "rateLimit",
  "maxResults",
  "injectionMode",
  "decidedBy",
  "endpointUrl",
  "token",
]);

const NOT_EDITABLE = "That field is not editable.";
const BAD_DATE = "Enter a valid date.";
const SIGN_IN = "Sign in to change agents.";
const BAD_ACTION = "That action is not available.";
const BAD_FILTER = "Enter a valid filter.";
const NEED_NAME = "Enter a name.";
const NEED_PROJECT = "Choose at least one project.";
const BAD_PROJECT = "Enter a project key like PROJ.";
const NEED_TOOL = "Choose at least one tool.";
const BAD_TOOL = "That tool is not available.";
const NEED_WHOAMI = "Include guard_whoami.";
const BAD_FORM = "Check the projects, tools, and write mode.";
const MISSING_AGENT = "That agent is not on this page.";
const MISSING_POLICY = "This agent has no policy.";

type PolicyFields = {
  allowedProjects: string[];
  allowedTools: string[];
  writeMode: WriteMode;
};

type Parsed = { ok: true; command: AdminCommand } | { ok: false; reason: string };

export async function handleAdmin(deps: AdminDeps, payload: unknown): Promise<AdminResult> {
  const parsed = parseCommand(payload);
  if (!parsed.ok) {
    return { type: "rejected", reason: parsed.reason, desk: null };
  }
  switch (parsed.command.type) {
    case "open":
      return { type: "desk", desk: await buildDesk(deps, {}) };
    case "filterAudit":
      return { type: "desk", desk: await buildDesk(deps, parsed.command.filter) };
    case "createAgent":
    case "savePolicy":
    case "revoke":
    case "decide": {
      if (deps.actor === null) {
        return { type: "rejected", reason: SIGN_IN, desk: await buildDesk(deps, {}) };
      }
      return runWrite(deps, deps.actor, parsed.command);
    }
    default: {
      const unreachable: never = parsed.command;
      return unreachable;
    }
  }
}

async function runWrite(
  deps: AdminDeps,
  actor: AccountId,
  command: Exclude<AdminCommand, { type: "open" } | { type: "filterAudit" }>,
): Promise<AdminResult> {
  switch (command.type) {
    case "createAgent":
      return createAgent(deps, actor, command);
    case "savePolicy":
      return savePolicy(deps, command);
    case "revoke":
      return revoke(deps, command.agentId);
    case "decide":
      return decide(deps, actor, command);
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
}

async function createAgent(
  deps: AdminDeps,
  actor: AccountId,
  command: Extract<AdminCommand, { type: "createAgent" }>,
): Promise<AdminResult> {
  const policy = await deps.store.createPolicy({
    allowedProjects: command.allowedProjects,
    allowedTools: command.allowedTools,
    writeMode: command.writeMode,
    fieldAllowList: [...DEFAULT_POLICY_LIMITS.fieldAllowList],
    rateLimit: { ...DEFAULT_POLICY_LIMITS.rateLimit },
    maxResults: DEFAULT_POLICY_LIMITS.maxResults,
    injectionMode: DEFAULT_POLICY_LIMITS.injectionMode,
  });
  const registered = await registerAgent(deps.store, {
    name: command.name,
    description: command.description,
    created_by: actor,
    policy_id: policy.id,
  });
  return { type: "created", token: registered.token, desk: await buildDesk(deps, {}) };
}

async function savePolicy(
  deps: AdminDeps,
  command: Extract<AdminCommand, { type: "savePolicy" }>,
): Promise<AdminResult> {
  const agent = await deps.store.getAgent(command.agentId);
  if (!agent) {
    return { type: "rejected", reason: MISSING_AGENT, desk: await buildDesk(deps, {}) };
  }
  const current = await deps.store.getPolicy(agent.policy_id);
  if (!current) {
    return { type: "rejected", reason: MISSING_POLICY, desk: await buildDesk(deps, {}) };
  }
  if (
    sameList(current.allowedProjects, command.allowedProjects) &&
    sameList(current.allowedTools, command.allowedTools) &&
    current.writeMode === command.writeMode
  ) {
    return { type: "desk", desk: await buildDesk(deps, {}) };
  }
  const policy = await deps.store.createPolicy({
    allowedProjects: command.allowedProjects,
    allowedTools: command.allowedTools,
    writeMode: command.writeMode,
    fieldAllowList: [...current.fieldAllowList],
    rateLimit: { ...current.rateLimit },
    maxResults: current.maxResults,
    injectionMode: current.injectionMode,
  });
  const attached = await attachPolicy(deps.store, agent.id, policy.id);
  if (!attached) {
    return { type: "rejected", reason: MISSING_AGENT, desk: await buildDesk(deps, {}) };
  }
  return { type: "desk", desk: await buildDesk(deps, {}) };
}

async function revoke(deps: AdminDeps, agentId: string): Promise<AdminResult> {
  const revoked = await revokeAgent(deps.store, agentId);
  if (!revoked) {
    return { type: "rejected", reason: MISSING_AGENT, desk: await buildDesk(deps, {}) };
  }
  return { type: "desk", desk: await buildDesk(deps, {}) };
}

async function decide(
  deps: AdminDeps,
  actor: AccountId,
  command: Extract<AdminCommand, { type: "decide" }>,
): Promise<AdminResult> {
  const result = await applyVerdict(deps, actor, command);
  const desk = await buildDesk(deps, {});
  if (!result.ok) {
    return { type: "rejected", reason: result.reason, desk };
  }
  return { type: "desk", desk };
}

async function applyVerdict(
  deps: AdminDeps,
  actor: AccountId,
  command: Extract<AdminCommand, { type: "decide" }>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  switch (command.verdict) {
    case "approve":
      return approvePending(deps.store, deps.jira, command.actionId, actor);
    case "reject":
      return rejectPending(deps.store, command.actionId, actor);
    default: {
      const unreachable: never = command.verdict;
      return unreachable;
    }
  }
}

async function attachPolicy(store: RecordStore, agentId: string, policyId: string): Promise<AgentRecord | null> {
  return store.patchAgent(agentId, { policy_id: policyId });
}

function parseCommand(payload: unknown): Parsed {
  if (containsForbidden(payload)) {
    return { ok: false, reason: NOT_EDITABLE };
  }
  if (!isRecord(payload) || typeof payload.type !== "string") {
    return { ok: false, reason: BAD_ACTION };
  }
  switch (payload.type) {
    case "open":
      return { ok: true, command: { type: "open" } };
    case "createAgent":
      return parseCreate(payload);
    case "savePolicy":
      return parseSave(payload);
    case "revoke":
      return parseRevoke(payload);
    case "decide":
      return parseDecide(payload);
    case "filterAudit":
      return parseFilter(payload);
    default:
      return { ok: false, reason: BAD_ACTION };
  }
}

function parseCreate(payload: Record<string, unknown>): Parsed {
  if (typeof payload.name !== "string" || payload.name.trim() === "") {
    return { ok: false, reason: NEED_NAME };
  }
  if (typeof payload.description !== "string") {
    return { ok: false, reason: BAD_FORM };
  }
  const fields = parsePolicyFields(payload);
  if (!fields.ok) {
    return fields;
  }
  return {
    ok: true,
    command: {
      type: "createAgent",
      name: payload.name.trim(),
      description: payload.description,
      ...fields.fields,
    },
  };
}

function parseSave(payload: Record<string, unknown>): Parsed {
  if (typeof payload.agentId !== "string" || payload.agentId === "") {
    return { ok: false, reason: MISSING_AGENT };
  }
  const fields = parsePolicyFields(payload);
  if (!fields.ok) {
    return fields;
  }
  return { ok: true, command: { type: "savePolicy", agentId: payload.agentId, ...fields.fields } };
}

function parseRevoke(payload: Record<string, unknown>): Parsed {
  if (typeof payload.agentId !== "string" || payload.agentId === "") {
    return { ok: false, reason: MISSING_AGENT };
  }
  return { ok: true, command: { type: "revoke", agentId: payload.agentId } };
}

function parseDecide(payload: Record<string, unknown>): Parsed {
  if (typeof payload.actionId !== "string" || payload.actionId === "") {
    return { ok: false, reason: "That action is not waiting for approval." };
  }
  if (payload.verdict !== "approve" && payload.verdict !== "reject") {
    return { ok: false, reason: BAD_ACTION };
  }
  return { ok: true, command: { type: "decide", actionId: payload.actionId, verdict: payload.verdict } };
}

function parseFilter(payload: Record<string, unknown>): Parsed {
  if (payload.filter === undefined) {
    return { ok: true, command: { type: "filterAudit", filter: {} } };
  }
  if (!isRecord(payload.filter)) {
    return { ok: false, reason: BAD_FILTER };
  }
  const filter: AuditFilter = {};
  const raw = payload.filter;
  if (raw.agentId !== undefined) {
    if (typeof raw.agentId !== "string" || raw.agentId === "") {
      return { ok: false, reason: BAD_FILTER };
    }
    filter.agentId = raw.agentId;
  }
  if (raw.outcome !== undefined) {
    if (!isOutcome(raw.outcome)) {
      return { ok: false, reason: BAD_FILTER };
    }
    filter.outcome = raw.outcome;
  }
  if (raw.injectionFlagged !== undefined) {
    if (raw.injectionFlagged !== true) {
      return { ok: false, reason: BAD_FILTER };
    }
    filter.injectionFlagged = true;
  }
  const from = expandDay(raw.from, "from");
  if (!from.ok) {
    return { ok: false, reason: BAD_DATE };
  }
  const to = expandDay(raw.to, "to");
  if (!to.ok) {
    return { ok: false, reason: BAD_DATE };
  }
  if (from.value !== undefined) {
    filter.from = from.value;
  }
  if (to.value !== undefined) {
    filter.to = to.value;
  }
  if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to) {
    return { ok: false, reason: BAD_DATE };
  }
  return { ok: true, command: { type: "filterAudit", filter } };
}

function parsePolicyFields(payload: Record<string, unknown>): { ok: true; fields: PolicyFields } | { ok: false; reason: string } {
  const projects = stringArray(payload.allowedProjects);
  const tools = stringArray(payload.allowedTools);
  if (!projects || !tools || !isWriteMode(payload.writeMode)) {
    return { ok: false, reason: BAD_FORM };
  }
  return normalizePolicy(projects, tools, payload.writeMode);
}

function normalizePolicy(
  projects: string[],
  tools: string[],
  writeMode: WriteMode,
): { ok: true; fields: PolicyFields } | { ok: false; reason: string } {
  const allowedProjects = [...new Set(projects)].sort();
  if (allowedProjects.length === 0) {
    return { ok: false, reason: NEED_PROJECT };
  }
  if (allowedProjects.some((key) => !isProjectKey(key))) {
    return { ok: false, reason: BAD_PROJECT };
  }
  const catalog = catalogToolNames();
  const selected = [...new Set(tools)];
  if (selected.length === 0) {
    return { ok: false, reason: NEED_TOOL };
  }
  if (selected.some((tool) => !catalog.includes(tool))) {
    return { ok: false, reason: BAD_TOOL };
  }
  if (!selected.includes("guard_whoami")) {
    return { ok: false, reason: NEED_WHOAMI };
  }
  return {
    ok: true,
    fields: {
      allowedProjects,
      allowedTools: catalog.filter((tool) => selected.includes(tool)),
      writeMode,
    },
  };
}

function expandDay(value: unknown, bound: "from" | "to"): { ok: true; value?: string } | { ok: false } {
  if (value === undefined || value === "") {
    return { ok: true };
  }
  if (typeof value !== "string" || !isCalendarDay(value)) {
    return { ok: false };
  }
  const suffix = bound === "from" ? "T00:00:00.000Z" : "T23:59:59.999Z";
  return { ok: true, value: `${value}${suffix}` };
}

function isCalendarDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function containsForbidden(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsForbidden);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(([key, child]) => FORBIDDEN_KEYS.has(key) || containsForbidden(child));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value;
}

function isWriteMode(value: unknown): value is WriteMode {
  return typeof value === "string" && (WRITE_MODES as readonly string[]).includes(value);
}

function isOutcome(value: unknown): value is AuditOutcome {
  return typeof value === "string" && (AUDIT_OUTCOMES as readonly string[]).includes(value);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

async function buildDesk(deps: AdminDeps, filter: AuditFilter): Promise<DeskSnapshot> {
  const agents = await deps.store.listAgents();
  const policies = await deps.store.listPolicies();
  const approvals = await listApprovalQueue(deps.store);
  const recent = await deps.store.recentAudits();
  const events = recent.filter((event) => auditMatches(event, toQuery(filter)));
  const policyById = new Map(policies.map((policy) => [policy.id, policy]));
  const nameById = new Map(agents.map((agent) => [agent.id, agent.name]));
  const ordered = [...agents].sort((left, right) =>
    left.created_at < right.created_at ? 1 : left.created_at > right.created_at ? -1 : 0,
  );
  const cards: AgentCard[] = [];
  for (const agent of ordered) {
    cards.push(toCard(agent, policyById.get(agent.policy_id) ?? null, await deps.store.lastUse(agent.id)));
  }
  return {
    endpointUrl: deps.endpointUrl,
    toolChoices: catalogToolNames(),
    writeModes: [...WRITE_MODES],
    outcomes: [...AUDIT_OUTCOMES],
    agents: cards,
    approvals,
    audit: {
      events: events.map((event) => toAuditCard(event, nameById.get(event.agentId) ?? "unknown")),
      empty: events.length > 0 ? "rows" : filterIsSet(filter) ? "no-match" : "setup",
    },
  };
}

function filterIsSet(filter: AuditFilter): boolean {
  return (
    filter.agentId !== undefined ||
    filter.outcome !== undefined ||
    filter.from !== undefined ||
    filter.to !== undefined ||
    filter.injectionFlagged === true
  );
}

function toQuery(filter: AuditFilter): AuditQuery {
  return {
    ...(filter.agentId !== undefined ? { agentId: filter.agentId } : {}),
    ...(filter.outcome !== undefined ? { outcome: filter.outcome } : {}),
    ...(filter.from !== undefined ? { from: filter.from } : {}),
    ...(filter.to !== undefined ? { to: filter.to } : {}),
    ...(filter.injectionFlagged === true ? { injectionFlagged: true as const } : {}),
  };
}

function toCard(agent: AgentRecord, policy: PolicyRecord | null, lastUsedAt: string | null): AgentCard {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    status: agent.status,
    createdAt: agent.created_at,
    lastUsedAt,
    policy: policy
      ? {
          kind: "set",
          allowedProjects: [...policy.allowedProjects],
          allowedTools: [...policy.allowedTools],
          writeMode: policy.writeMode,
        }
      : { kind: "missing" },
  };
}

function toAuditCard(event: AuditEvent, agentName: string): AuditCard {
  return {
    id: event.id,
    ts: event.ts,
    agentId: event.agentId,
    agentName,
    tool: event.tool,
    issueKey: event.issueKey,
    project: event.project,
    outcome: event.outcome,
    reason: event.reason,
    before: event.before,
    after: event.after,
    injectionFlagged: event.injectionFlagged,
    requestId: event.requestId,
  };
}
