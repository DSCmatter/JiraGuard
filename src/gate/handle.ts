import { registerAgent, resolveToken } from "../auth/token.ts";
import type { AgentRecord, AuditOutcome, Json, PolicyRecord, RateLimit, WriteMode } from "../domain/records.ts";
import { nextCall, searchProjectJql } from "../policy/decide.ts";
import type { DecisionRequest } from "../policy/decide.ts";
import type { RecordStore } from "../storage/memory.ts";

export type WebtriggerRequest = {
  method?: string;
  headers?: Record<string, string | string[]>;
  body?: string;
};

export type WebtriggerResponse = {
  statusCode: number;
  headers: Record<string, string[]>;
  body: string;
};

export type IssueView = { key: string; fields: Record<string, Json> };

export type SearchPage = {
  issues: IssueView[];
  total: number | null;
  nextStartAt: number | null;
};

export type TransitionChoice = { id: string; name: string; to: string };

export type TransitionTarget = { transitionId: string } | { toStatus: string };

export type CommentDocument = {
  type: "doc";
  version: 1;
  content: Array<{
    type: "paragraph";
    content: Array<{ type: "text"; text: string }>;
  }>;
};

export type JiraWork = {
  search(query: { jql: string; fields: string[]; limit: number; startAt: number }): Promise<SearchPage>;
  getIssue(issueKey: string, fields: string[]): Promise<IssueView>;
  listTransitions(issueKey: string): Promise<TransitionChoice[]>;
  addComment(issueKey: string, body: CommentDocument): Promise<{ id: string }>;
  transition(issueKey: string, target: TransitionTarget): Promise<void>;
  assign(issueKey: string, accountId: string | null): Promise<void>;
  updateFields(issueKey: string, fields: Record<string, Json>): Promise<void>;
};

export type GateDeps = { store: RecordStore; jira: JiraWork };

export type ProofSeed = {
  name: string;
  description: string;
  createdBy: string;
  allowedTools: string[];
  allowedProjects: string[];
  writeMode: WriteMode;
  fieldAllowList: string[];
  rateLimit: RateLimit;
  maxResults: number;
};

const LIMITS = {
  jql: 1000,
  body: 10_000,
  limitMin: 1,
  limitMax: 50,
  limitDefault: 10,
  startAtMax: 1000,
} as const;

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

const DEFAULT_FIELDS = ["summary", "status", "assignee", "description", "issuetype"] as const;

const HELD =
  "Held for approval. A Jira admin must approve before this change applies. Do not retry; check back later.";

const FAIL_CLOSED = "Denied: the call could not be checked. Retry later.";

const JSON_HEADERS: Record<string, string[]> = {
  "Content-Type": ["application/json"],
  "Access-Control-Allow-Origin": ["*"],
  "Access-Control-Allow-Headers": ["authorization, content-type, accept, mcp-protocol-version, mcp-session-id"],
  "Access-Control-Allow-Methods": ["POST, OPTIONS"],
};

type ToolCall =
  | { tool: "guard_whoami" }
  | { tool: "jira_search_issues"; jql: string; fields: string[]; limit: number; startAt: number }
  | { tool: "jira_get_issue"; issueKey: string; fields: string[] }
  | { tool: "jira_list_transitions"; issueKey: string }
  | { tool: "jira_add_comment"; issueKey: string; body: string }
  | { tool: "jira_transition_issue"; issueKey: string; target: TransitionTarget }
  | { tool: "jira_assign_issue"; issueKey: string; accountId: string | null }
  | { tool: "jira_update_fields"; issueKey: string; fields: Record<string, Json> };

type ToolName = ToolCall["tool"];

type PolicyTarget = {
  tool: ToolName;
  issueKey: string | null;
  body?: string;
  fields?: Record<string, Json>;
  transitionId?: string;
  toStatus?: string;
  accountId?: string | null;
};

type Annotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

type ParseResult = { ok: true; call: ToolCall } | { ok: false; target: PolicyTarget; message: string };

type ToolSpec = {
  description: string;
  annotations: Annotations;
  inputSchema: Json;
  parse(args: unknown): ParseResult;
};

type Envelope = {
  status: "ok" | "denied" | "pending_approval" | "error";
  data: Json;
  guard: { flagged: false; reasons: Json[] };
  message?: string;
};

type RpcId = string | number | null;

const TOOLS: Record<ToolName, ToolSpec> = {
  guard_whoami: {
    description: "Show this agent's name, allowed tools, allowed projects, write mode, and rate-limit numbers.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {} },
    parse(args: unknown): ParseResult {
      if (args !== undefined && !isRecord(args)) {
        return { ok: false, target: { tool: "guard_whoami", issueKey: null }, message: "Arguments must be an object." };
      }
      return { ok: true, call: { tool: "guard_whoami" } };
    },
  },
  jira_search_issues: {
    description: "Search issues with JQL. Results stay inside this agent's allowed projects.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["jql"],
      properties: {
        jql: { type: "string", maxLength: LIMITS.jql },
        fields: { type: "array", items: { type: "string" } },
        limit: { type: "integer", minimum: LIMITS.limitMin, maximum: LIMITS.limitMax, default: LIMITS.limitDefault },
        startAt: { type: "integer", minimum: 0, maximum: LIMITS.startAtMax, default: 0 },
      },
    },
    parse(args: unknown): ParseResult {
      const target: PolicyTarget = { tool: "jira_search_issues", issueKey: null };
      if (!isRecord(args)) {
        return { ok: false, target, message: "Arguments must be an object." };
      }
      if (typeof args.jql !== "string" || args.jql.length > LIMITS.jql) {
        return { ok: false, target, message: "jql must be a string of at most 1000 characters." };
      }
      const fields = readFields(args.fields, DEFAULT_FIELDS);
      if (!fields) {
        return { ok: false, target, message: "fields must be an array of strings." };
      }
      const limit = readLimit(args.limit);
      if (limit === null) {
        return { ok: false, target, message: "limit must be an integer from 1 to 50." };
      }
      const startAt = readStartAt(args.startAt);
      if (startAt === null) {
        return { ok: false, target, message: "startAt must be an integer from 0 to 1000." };
      }
      return { ok: true, call: { tool: "jira_search_issues", jql: args.jql, fields, limit, startAt } };
    },
  },
  jira_get_issue: {
    description: "Get one issue: summary, status, assignee, description, and any requested fields.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["issueKey"],
      properties: {
        issueKey: { type: "string", pattern: ISSUE_KEY.source },
        fields: { type: "array", items: { type: "string" } },
      },
    },
    parse(args: unknown): ParseResult {
      const found = takeIssueKey("jira_get_issue", args);
      if (!found.ok) {
        return found.result;
      }
      const fields = readFields(found.args.fields, DEFAULT_FIELDS);
      if (!fields) {
        return { ok: false, target: found.target, message: "fields must be an array of strings." };
      }
      return { ok: true, call: { tool: "jira_get_issue", issueKey: found.issueKey, fields } };
    },
  },
  jira_list_transitions: {
    description: "List the transitions currently valid for an issue.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["issueKey"],
      properties: { issueKey: { type: "string", pattern: ISSUE_KEY.source } },
    },
    parse(args: unknown): ParseResult {
      const found = takeIssueKey("jira_list_transitions", args);
      if (!found.ok) {
        return found.result;
      }
      return { ok: true, call: { tool: "jira_list_transitions", issueKey: found.issueKey } };
    },
  },
  jira_add_comment: {
    description: "Add a comment. The stored text includes the agent name.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["issueKey", "body"],
      properties: {
        issueKey: { type: "string", pattern: ISSUE_KEY.source },
        body: { type: "string", maxLength: LIMITS.body },
      },
    },
    parse(args: unknown): ParseResult {
      const found = takeIssueKey("jira_add_comment", args);
      if (!found.ok) {
        return found.result;
      }
      if (typeof found.args.body !== "string" || found.args.body.length > LIMITS.body) {
        return { ok: false, target: found.target, message: "body must be a string of at most 10000 characters." };
      }
      return { ok: true, call: { tool: "jira_add_comment", issueKey: found.issueKey, body: found.args.body } };
    },
  },
  jira_transition_issue: {
    description: "Move an issue by transition id or by destination status name.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["issueKey"],
      properties: {
        issueKey: { type: "string", pattern: ISSUE_KEY.source },
        transitionId: { type: "string" },
        toStatus: { type: "string" },
      },
    },
    parse(args: unknown): ParseResult {
      const found = takeIssueKey("jira_transition_issue", args);
      if (!found.ok) {
        return found.result;
      }
      const transitionId = nonEmpty(found.args.transitionId);
      const toStatus = nonEmpty(found.args.toStatus);
      if (transitionId !== undefined && toStatus === undefined) {
        return { ok: true, call: { tool: "jira_transition_issue", issueKey: found.issueKey, target: { transitionId } } };
      }
      if (toStatus !== undefined && transitionId === undefined) {
        return { ok: true, call: { tool: "jira_transition_issue", issueKey: found.issueKey, target: { toStatus } } };
      }
      return { ok: false, target: found.target, message: "Send transitionId or toStatus." };
    },
  },
  jira_assign_issue: {
    description: "Assign the issue to an account, or pass null to unassign it.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["issueKey", "accountId"],
      properties: {
        issueKey: { type: "string", pattern: ISSUE_KEY.source },
        accountId: { type: ["string", "null"] },
      },
    },
    parse(args: unknown): ParseResult {
      const found = takeIssueKey("jira_assign_issue", args);
      if (!found.ok) {
        return found.result;
      }
      if (typeof found.args.accountId !== "string" && found.args.accountId !== null) {
        return { ok: false, target: found.target, message: "accountId must be a string or null." };
      }
      return {
        ok: true,
        call: { tool: "jira_assign_issue", issueKey: found.issueKey, accountId: found.args.accountId },
      };
    },
  },
  jira_update_fields: {
    description: "Update fields on an issue.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["issueKey", "fields"],
      properties: {
        issueKey: { type: "string", pattern: ISSUE_KEY.source },
        fields: { type: "object" },
      },
    },
    parse(args: unknown): ParseResult {
      const found = takeIssueKey("jira_update_fields", args);
      if (!found.ok) {
        return found.result;
      }
      const fields = jsonObject(found.args.fields);
      if (!fields) {
        return { ok: false, target: found.target, message: "fields must be an object." };
      }
      return { ok: true, call: { tool: "jira_update_fields", issueKey: found.issueKey, fields } };
    },
  },
};

export async function seedProofAgent(
  store: RecordStore,
  input: ProofSeed,
): Promise<{ token: string; agentId: string }> {
  const policy = await store.createPolicy({
    allowedTools: input.allowedTools,
    allowedProjects: input.allowedProjects,
    writeMode: input.writeMode,
    fieldAllowList: input.fieldAllowList,
    rateLimit: input.rateLimit,
    maxResults: input.maxResults,
    injectionMode: "annotate",
  });
  const registered = await registerAgent(store, {
    name: input.name,
    description: input.description,
    created_by: input.createdBy,
    policy_id: policy.id,
  });
  return { token: registered.token, agentId: registered.agent.id };
}

export async function handleMcp(request: WebtriggerRequest, deps: GateDeps): Promise<WebtriggerResponse> {
  if (request.method?.toUpperCase() === "OPTIONS") {
    return respond(204);
  }

  let message: unknown;
  try {
    message = JSON.parse(request.body ?? "");
  } catch {
    await recordParseFailure(deps.store);
    return rpcError(400, null, -32700, "Parse error");
  }
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    await keepAudit(deps.store, {
      agentId: "unknown",
      tool: "jsonrpc",
      issueKey: null,
      outcome: "denied",
      reason: "request",
      requestId: requestLabel(rpcId(message)),
    });
    return rpcError(200, rpcId(message), -32600, "Invalid Request");
  }

  const id = rpcId(message);
  const token = bearerToken(request);
  try {
    if (message.method === "tools/call") {
      return await handleCall(message, token, id, deps);
    }
    const agent = await resolveToken(deps.store, token);
    if (!agent) {
      return await authError(deps.store, token, id, message.method);
    }
    switch (message.method) {
      case "notifications/initialized":
      case "initialize":
      case "ping":
      case "tools/list": {
        const response = await methodResponse(message, deps.store, agent, token, id);
        const saved = await keepAudit(deps.store, {
          agentId: agent.id,
          tool: message.method,
          issueKey: null,
          outcome: "allowed",
          reason: null,
          requestId: requestLabel(id),
        });
        if (!saved) {
          return toolResult(id, envelope("error", {}, FAIL_CLOSED), true);
        }
        return response;
      }
      default: {
        await keepAudit(deps.store, {
          agentId: agent.id,
          tool: message.method,
          issueKey: null,
          outcome: "denied",
          reason: "method",
          requestId: requestLabel(id),
        });
        return rpcError(200, id, -32601, "Method not found");
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "call failed";
    console.error(detail);
    if (message.method === "tools/call") {
      return toolResult(id, envelope("error", {}, FAIL_CLOSED), true);
    }
    return rpcError(200, id, -32603, FAIL_CLOSED);
  }
}

function readPolicyTarget(tool: ToolName, args: unknown): PolicyTarget {
  const record = isRecord(args) ? args : {};
  switch (tool) {
    case "guard_whoami":
    case "jira_search_issues":
      return { tool, issueKey: null };
    case "jira_get_issue":
    case "jira_list_transitions":
      return { tool, issueKey: typeof record.issueKey === "string" ? record.issueKey : null };
    case "jira_add_comment":
      return {
        tool,
        issueKey: typeof record.issueKey === "string" ? record.issueKey : null,
        ...(typeof record.body === "string" ? { body: record.body } : {}),
      };
    case "jira_transition_issue":
      return {
        tool,
        issueKey: typeof record.issueKey === "string" ? record.issueKey : null,
        ...(typeof record.transitionId === "string" ? { transitionId: record.transitionId } : {}),
        ...(typeof record.toStatus === "string" ? { toStatus: record.toStatus } : {}),
      };
    case "jira_assign_issue":
      return {
        tool,
        issueKey: typeof record.issueKey === "string" ? record.issueKey : null,
        ...(typeof record.accountId === "string" || record.accountId === null ? { accountId: record.accountId } : {}),
      };
    case "jira_update_fields": {
      const fields = jsonObject(record.fields);
      return {
        tool,
        issueKey: typeof record.issueKey === "string" ? record.issueKey : null,
        ...(fields ? { fields } : {}),
      };
    }
    default: {
      const unreachable: never = tool;
      return unreachable;
    }
  }
}

function toDecision(target: PolicyTarget): DecisionRequest {
  return {
    tool: target.tool,
    issueKey: target.issueKey,
    body: target.body,
    fields: target.fields,
    transitionId: target.transitionId,
    toStatus: target.toStatus,
    accountId: target.accountId,
  };
}

function targetOf(call: ToolCall): PolicyTarget {
  switch (call.tool) {
    case "guard_whoami":
    case "jira_search_issues":
      return { tool: call.tool, issueKey: null };
    case "jira_get_issue":
    case "jira_list_transitions":
      return { tool: call.tool, issueKey: call.issueKey };
    case "jira_add_comment":
      return { tool: call.tool, issueKey: call.issueKey, body: call.body };
    case "jira_transition_issue":
      if ("transitionId" in call.target) {
        return { tool: call.tool, issueKey: call.issueKey, transitionId: call.target.transitionId };
      }
      return { tool: call.tool, issueKey: call.issueKey, toStatus: call.target.toStatus };
    case "jira_assign_issue":
      return { tool: call.tool, issueKey: call.issueKey, accountId: call.accountId };
    case "jira_update_fields":
      return { tool: call.tool, issueKey: call.issueKey, fields: call.fields };
    default: {
      const unreachable: never = call;
      return unreachable;
    }
  }
}

async function executeAllowed(
  call: ToolCall,
  agent: AgentRecord,
  policy: PolicyRecord,
  jira: JiraWork,
): Promise<Envelope> {
  switch (call.tool) {
    case "guard_whoami":
      return envelope("ok", {
        agent: agent.name,
        allowedTools: visibleTools(policy.allowedTools),
        allowedProjects: policy.allowedProjects,
        writeMode: policy.writeMode,
        rateLimit: policy.rateLimit,
      });
    case "jira_search_issues": {
      const fragment = searchProjectJql(policy);
      const client = call.jql.trim();
      const jql = client.length === 0 ? fragment : `(${client}) AND (${fragment})`;
      const limit = Math.min(call.limit, policy.maxResults);
      if (limit < 1) {
        return envelope("ok", { issues: [], total: 0, nextStartAt: null });
      }
      const page = await jira.search({ jql, fields: call.fields, limit, startAt: call.startAt });
      return envelope("ok", pageJson(visiblePage(page, policy.allowedProjects)));
    }
    case "jira_get_issue":
      return envelope("ok", await jira.getIssue(call.issueKey, call.fields));
    case "jira_list_transitions":
      return envelope("ok", { transitions: await jira.listTransitions(call.issueKey) });
    case "jira_add_comment": {
      const text = `via agent ${agent.name}: ${call.body}`;
      const created = await jira.addComment(call.issueKey, commentDocument(text));
      return envelope("ok", { id: created.id });
    }
    case "jira_transition_issue":
      await jira.transition(call.issueKey, call.target);
      return envelope("ok", { issueKey: call.issueKey });
    case "jira_assign_issue":
      await jira.assign(call.issueKey, call.accountId);
      return envelope("ok", { issueKey: call.issueKey, accountId: call.accountId });
    case "jira_update_fields":
      await jira.updateFields(call.issueKey, call.fields);
      return envelope("ok", { issueKey: call.issueKey });
    default: {
      const unreachable: never = call;
      return unreachable;
    }
  }
}

async function keepAudit(
  store: RecordStore,
  draft: {
    agentId: string;
    tool: string;
    issueKey: string | null;
    outcome: AuditOutcome;
    reason: string | null;
    before?: Record<string, Json> | null;
    after?: Record<string, Json> | null;
    requestId: string;
  },
): Promise<boolean> {
  try {
    await store.appendAudit({
      agentId: draft.agentId,
      tool: draft.tool,
      issueKey: draft.issueKey,
      project: draft.issueKey ? projectKey(draft.issueKey) : null,
      outcome: draft.outcome,
      reason: draft.reason,
      before: draft.before ?? null,
      after: draft.after ?? null,
      injectionFlagged: false,
      requestId: draft.requestId,
    });
    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "audit failed");
    return false;
  }
}

function requestLabel(id: RpcId): string {
  return id === null ? "none" : String(id);
}

async function knownAgent(store: RecordStore, token: string): Promise<string> {
  const agent = await resolveToken(store, token);
  return agent ? agent.id : "unknown";
}

function row(
  request: DecisionRequest,
  agent: string,
  outcome: AuditOutcome,
  reason: string | null,
  id: RpcId,
  after: Record<string, Json> | null = null,
) {
  return {
    agentId: agent,
    tool: request.tool,
    issueKey: request.issueKey ?? null,
    outcome,
    reason,
    after,
    requestId: requestLabel(id),
  };
}

function isWrite(tool: string): boolean {
  return (
    tool === "jira_add_comment" ||
    tool === "jira_transition_issue" ||
    tool === "jira_assign_issue" ||
    tool === "jira_update_fields"
  );
}

function writeAfter(call: ToolCall, agentName: string): Record<string, Json> {
  switch (call.tool) {
    case "jira_add_comment":
      return { body: `via agent ${agentName}: ${call.body}` };
    case "jira_transition_issue":
      return "transitionId" in call.target ? { transitionId: call.target.transitionId } : { toStatus: call.target.toStatus };
    case "jira_assign_issue":
      return { accountId: call.accountId };
    case "jira_update_fields":
      return call.fields;
    default:
      return {};
  }
}

async function handleCall(
  message: Record<string, unknown>,
  token: string,
  id: RpcId,
  deps: GateDeps,
): Promise<WebtriggerResponse> {
  const params = isRecord(message.params) ? message.params : {};
  const name = typeof params.name === "string" ? params.name : "";
  const args = params.arguments === undefined ? {} : params.arguments;
  const parsed = isToolName(name) ? TOOLS[name].parse(args) : null;
  const request = parsed ? toDecision(parsed.ok ? targetOf(parsed.call) : parsed.target) : looseRequest(name, args);
  const decision = await nextCall(deps.store, token, request);

  if (decision.kind === "deny" && decision.reason === "auth") {
    await keepAudit(deps.store, row(request, "unknown", "auth_failed", "auth", id));
    return rpcError(401, id, -32001, decision.agentMessage);
  }
  if (decision.kind === "deny") {
    await keepAudit(deps.store, row(request, await knownAgent(deps.store, token), "denied", decision.reason, id));
    return toolResult(id, envelope("denied", {}, decision.agentMessage), true);
  }
  if (!parsed) {
    await keepAudit(deps.store, row(request, await knownAgent(deps.store, token), "denied", "tool", id));
    return rpcError(200, id, -32602, "Unknown tool");
  }
  if (!parsed.ok) {
    await keepAudit(deps.store, row(request, await knownAgent(deps.store, token), "denied", "schema", id));
    return toolResult(id, envelope("error", {}, parsed.message), true);
  }
  if (parsed.call.tool === "jira_update_fields") {
    const editor = await resolveToken(deps.store, token);
    const editorPolicy = editor ? await deps.store.getPolicy(editor.policy_id) : null;
    if (!editor || !editorPolicy) {
      return toolResult(id, envelope("error", {}, FAIL_CLOSED), true);
    }
    const blocked = blockedField(parsed.call.fields, editorPolicy.fieldAllowList);
    if (blocked) {
      await keepAudit(deps.store, row(request, editor.id, "denied", "field", id));
      return toolResult(id, envelope("denied", {}, fieldDenial(blocked, editorPolicy.fieldAllowList)), true);
    }
  }
  if (decision.kind === "needs_approval") {
    const saved = await keepAudit(deps.store, row(request, await knownAgent(deps.store, token), "pending", null, id));
    if (!saved) {
      return toolResult(id, envelope("error", {}, FAIL_CLOSED), true);
    }
    return toolResult(id, envelope("pending_approval", { diff: decision.diff }, HELD), false);
  }

  const agent = await resolveToken(deps.store, token);
  const policy = agent ? await deps.store.getPolicy(agent.policy_id) : null;
  if (!agent || !policy) {
    const again = await nextCall(deps.store, token, request);
    if (again.kind === "deny" && again.reason === "auth") {
      await keepAudit(deps.store, row(request, "unknown", "auth_failed", "auth", id));
      return rpcError(401, id, -32001, again.agentMessage);
    }
    if (again.kind === "deny") {
      await keepAudit(deps.store, row(request, "unknown", "denied", again.reason, id));
      return toolResult(id, envelope("denied", {}, again.agentMessage), true);
    }
    return toolResult(id, envelope("error", {}, FAIL_CLOSED), true);
  }
  if (!isWrite(parsed.call.tool)) {
    const saved = await keepAudit(deps.store, row(request, agent.id, "allowed", null, id));
    if (!saved) {
      return toolResult(id, envelope("error", {}, FAIL_CLOSED), true);
    }
  }
  const result = await executeAllowed(parsed.call, agent, policy, deps.jira);
  if (isWrite(parsed.call.tool)) {
    await keepAudit(deps.store, row(request, agent.id, "allowed", null, id, writeAfter(parsed.call, agent.name)));
  }
  return toolResult(id, result, false);
}

async function listResponse(store: RecordStore, agent: AgentRecord, token: string, id: RpcId): Promise<WebtriggerResponse> {
  const policy = await store.getPolicy(agent.policy_id);
  if (!policy) {
    const decision = await nextCall(store, token, { tool: "guard_whoami" });
    const message = decision.kind === "deny" ? decision.agentMessage : FAIL_CLOSED;
    return toolResult(id, envelope("denied", {}, message), true);
  }
  return respond(200, { jsonrpc: "2.0", id, result: { tools: listTools(policy.allowedTools) } });
}

async function methodResponse(
  message: Record<string, unknown>,
  store: RecordStore,
  agent: AgentRecord,
  token: string,
  id: RpcId,
): Promise<WebtriggerResponse> {
  switch (message.method) {
    case "notifications/initialized":
      return respond(202);
    case "initialize":
      return respond(200, { jsonrpc: "2.0", id, result: initializeResult() });
    case "ping":
      return respond(200, { jsonrpc: "2.0", id, result: {} });
    case "tools/list":
      return await listResponse(store, agent, token, id);
    default:
      return rpcError(200, id, -32601, "Method not found");
  }
}

async function authError(store: RecordStore, token: string, id: RpcId, tool: string): Promise<WebtriggerResponse> {
  const decision = await nextCall(store, token, { tool });
  const message = decision.kind === "deny" ? decision.agentMessage : FAIL_CLOSED;
  await keepAudit(store, {
    agentId: "unknown",
    tool,
    issueKey: null,
    outcome: "auth_failed",
    reason: "auth",
    requestId: requestLabel(id),
  });
  return rpcError(401, id, -32001, message);
}

async function recordParseFailure(store: RecordStore): Promise<void> {
  try {
    await store.appendAudit({
      agentId: "unknown",
      tool: "jsonrpc",
      issueKey: null,
      project: null,
      outcome: "denied",
      reason: "parse",
      before: null,
      after: null,
      injectionFlagged: false,
      requestId: "parse",
    });
  } catch {
    // A failed audit write must not hide the parse error from the caller.
  }
}

function looseRequest(tool: string, args: unknown): DecisionRequest {
  const record = isRecord(args) ? args : {};
  const fields = jsonObject(record.fields);
  return {
    tool,
    issueKey: typeof record.issueKey === "string" ? record.issueKey : null,
    ...(typeof record.body === "string" ? { body: record.body } : {}),
    ...(fields ? { fields } : {}),
    ...(typeof record.transitionId === "string" ? { transitionId: record.transitionId } : {}),
    ...(typeof record.toStatus === "string" ? { toStatus: record.toStatus } : {}),
    ...(typeof record.accountId === "string" || record.accountId === null ? { accountId: record.accountId } : {}),
  };
}

export function catalogToolNames(): string[] {
  return Object.keys(TOOLS);
}

function visibleTools(allowed: readonly string[]): string[] {
  return (Object.keys(TOOLS) as ToolName[]).filter((name) => allowed.includes(name));
}

function listTools(allowed: readonly string[]): Json[] {
  return visibleTools(allowed).map((name) => {
    const spec = TOOLS[name as ToolName];
    return {
      name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: spec.annotations,
    };
  });
}

function visiblePage(page: SearchPage, allowed: readonly string[]): SearchPage {
  const issues = page.issues.filter((issue) => {
    const project = projectKey(issue.key);
    return project !== null && allowed.includes(project);
  });
  // OR binds looser than AND, so a parenthesized client clause can still name another project.
  if (issues.length === page.issues.length) {
    return page;
  }
  return { issues, total: null, nextStartAt: page.nextStartAt };
}

function pageJson(page: SearchPage): Json {
  return {
    issues: page.issues,
    total: page.total,
    nextStartAt: page.nextStartAt,
  };
}

function blockedField(fields: Record<string, Json>, allowed: readonly string[]): string | null {
  for (const name of Object.keys(fields)) {
    if (!allowed.includes(name)) {
      return name;
    }
  }
  return null;
}

function fieldDenial(field: string, allowed: readonly string[]): string {
  const listed = allowed.length === 0 ? "none" : allowed.join(", ");
  return `Denied: field '${field}' is not editable by this agent. Editable fields: ${listed}.`;
}

function projectKey(issueKey: string): string | null {
  const match = /^([A-Z][A-Z0-9_]+)-\d+$/.exec(issueKey);
  return match ? match[1] : null;
}

function commentDocument(text: string): CommentDocument {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function initializeResult(): Json {
  return {
    protocolVersion: "2025-11-25",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "jiraguard", version: "0.3.0" },
  };
}

type IssueArgs =
  | { ok: true; issueKey: string; args: Record<string, unknown>; target: PolicyTarget }
  | { ok: false; result: ParseResult };

function takeIssueKey(tool: ToolName, args: unknown): IssueArgs {
  const target = readPolicyTarget(tool, args);
  if (!isRecord(args) || typeof args.issueKey !== "string" || !ISSUE_KEY.test(args.issueKey)) {
    return { ok: false, result: { ok: false, target, message: "issueKey must match ^[A-Z][A-Z0-9_]+-\\d+$." } };
  }
  return { ok: true, issueKey: args.issueKey, args, target };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readFields(value: unknown, fallback: readonly string[]): string[] | null {
  if (value === undefined) {
    return [...fallback];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value;
}

function readLimit(value: unknown): number | null {
  if (value === undefined) {
    return LIMITS.limitDefault;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < LIMITS.limitMin || value > LIMITS.limitMax) {
    return null;
  }
  return value;
}

function readStartAt(value: unknown): number | null {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > LIMITS.startAtMax) {
    return null;
  }
  return value;
}

function jsonObject(value: unknown): Record<string, Json> | undefined {
  const parsed = asJson(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  return undefined;
}

function asJson(value: unknown): Json | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const items: Json[] = [];
    for (const item of value) {
      const parsed = asJson(item);
      if (parsed === undefined) {
        return undefined;
      }
      items.push(parsed);
    }
    return items;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const record: { [key: string]: Json } = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = asJson(item);
    if (parsed === undefined) {
      return undefined;
    }
    record[key] = parsed;
  }
  return record;
}

function envelope(status: Envelope["status"], data: Json, message?: string): Envelope {
  const result: Envelope = { status, data, guard: { flagged: false, reasons: [] } };
  if (message !== undefined) {
    result.message = message;
  }
  return result;
}

function toolResult(id: RpcId, body: Envelope, isError: boolean): WebtriggerResponse {
  return respond(200, {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: body.message ?? JSON.stringify(body.data) }],
      structuredContent: body,
      isError,
    },
  });
}

function rpcError(statusCode: number, id: RpcId, code: number, message: string): WebtriggerResponse {
  return respond(statusCode, { jsonrpc: "2.0", id, error: { code, message } });
}

function respond(statusCode: number, payload?: Json): WebtriggerResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: payload === undefined ? "" : JSON.stringify(payload),
  };
}

function bearerToken(request: WebtriggerRequest): string {
  const headers = request.headers ?? {};
  const key = Object.keys(headers).find((item) => item.toLowerCase() === "authorization");
  if (!key) {
    return "";
  }
  const value = headers[key];
  if (value === undefined) {
    return "";
  }
  const raw = Array.isArray(value) ? value.join(", ") : value;
  const match = /^Bearer\s+(\S+)/i.exec(raw);
  return match ? match[1] : "";
}

function rpcId(message: unknown): RpcId {
  if (!isRecord(message) || !Object.prototype.hasOwnProperty.call(message, "id")) {
    return null;
  }
  const id = message.id;
  if (id === null || typeof id === "string" || typeof id === "number") {
    return id;
  }
  return null;
}

function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOLS, name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
