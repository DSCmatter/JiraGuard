"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/product/handler.ts
var handler_exports = {};
__export(handler_exports, {
  mcpHandler: () => mcpHandler
});
module.exports = __toCommonJS(handler_exports);
var import_api = require("@forge/api");
var import_kvs = require("@forge/kvs");

// src/auth/token.ts
var import_node_crypto = require("crypto");
function hashToken(token) {
  return (0, import_node_crypto.createHash)("sha256").update(token).digest("hex");
}
async function resolveToken(store2, token) {
  const agent = await store2.getAgentByHash(hashToken(token));
  if (!agent || agent.status !== "active") {
    return null;
  }
  return agent;
}

// src/policy/decide.ts
var WRITE_TOOLS = /* @__PURE__ */ new Set([
  "jira_add_comment",
  "jira_transition_issue",
  "jira_assign_issue",
  "jira_update_fields",
  "jira_create_issue"
]);
var PROJECT_DENIAL = "Denied: that issue is not available to this agent. Use jira_search_issues to find issues you can access.";
var AUTH_DENIAL = "401: missing, invalid or revoked agent token.";
var PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;
function searchProjectJql(policy) {
  const keys = policy.allowedProjects.filter((key) => PROJECT_KEY.test(key));
  if (keys.length === 0) {
    return "id = 0";
  }
  const names = keys.map((key) => `"${key}"`).join(", ");
  return `project in (${names})`;
}
function decide(policy, request) {
  if (!policy.allowedTools.includes(request.tool)) {
    const listed = policy.allowedTools.length === 0 ? "none" : policy.allowedTools.join(", ");
    return {
      kind: "deny",
      reason: "tool",
      agentMessage: `Denied: this agent is not allowed to use ${request.tool}. Allowed tools: ${listed}. Call guard_whoami for full details.`
    };
  }
  const project = scopedProject(request);
  if (project === "deny" || request.tool === "jira_create_issue" && !project) {
    return { kind: "deny", reason: "project", agentMessage: PROJECT_DENIAL };
  }
  if (project && !policy.allowedProjects.includes(project)) {
    return { kind: "deny", reason: "project", agentMessage: PROJECT_DENIAL };
  }
  if (!WRITE_TOOLS.has(request.tool)) {
    return { kind: "allow" };
  }
  return writeDecision(policy.writeMode, request);
}
async function nextCall(store2, token, request) {
  const agent = await resolveToken(store2, token);
  if (!agent) {
    return { kind: "deny", reason: "auth", agentMessage: AUTH_DENIAL };
  }
  const policy = await store2.getPolicy(agent.policy_id);
  if (!policy) {
    return {
      kind: "deny",
      reason: "policy",
      agentMessage: "Denied: this agent has no policy. Call guard_whoami for full details."
    };
  }
  return decide(policy, request);
}
function issueProject(issueKey) {
  const match = /^([A-Z][A-Z0-9_]+)-\d+$/.exec(issueKey);
  return match ? match[1] : null;
}
function fieldProject(fields) {
  if (!fields || !("project" in fields)) {
    return null;
  }
  const value = fields.project;
  if (typeof value === "string") {
    return PROJECT_KEY.test(value) ? value : "deny";
  }
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.key === "string") {
    return PROJECT_KEY.test(value.key) ? value.key : "deny";
  }
  return "deny";
}
function scopedProject(request) {
  const fromKey = request.issueKey ? issueProject(request.issueKey) : null;
  const fromFields = fieldProject(request.fields);
  if (request.issueKey && !fromKey) {
    return "deny";
  }
  if (fromFields === "deny") {
    return "deny";
  }
  const named = [fromKey, request.project ?? null, fromFields].filter((item) => item !== null);
  if (named.some((item) => item !== named[0])) {
    return "deny";
  }
  return named[0] ?? null;
}
function proposedChanges(request) {
  const changes = Object.entries(request.fields ?? {});
  if (request.body !== void 0) {
    changes.push(["body", request.body]);
  }
  if (request.transitionId !== void 0) {
    changes.push(["transitionId", request.transitionId]);
  }
  if (request.toStatus !== void 0) {
    changes.push(["toStatus", request.toStatus]);
  }
  if (request.accountId !== void 0) {
    changes.push(["accountId", request.accountId]);
  }
  return changes;
}
function writeDecision(mode, request) {
  switch (mode) {
    case "deny":
      return {
        kind: "deny",
        reason: "write_mode",
        agentMessage: "Denied: this agent is not allowed to write. Call guard_whoami for full details."
      };
    case "approve": {
      const before = request.before;
      return {
        kind: "needs_approval",
        diff: proposedChanges(request).map(([field, after]) => ({
          field,
          before: before && field in before ? before[field] : null,
          after
        }))
      };
    }
    case "allow":
      return { kind: "allow" };
    default: {
      const unreachable = mode;
      return unreachable;
    }
  }
}

// src/gate/handle.ts
var LIMITS = {
  jql: 1e3,
  body: 1e4,
  limitMin: 1,
  limitMax: 50,
  limitDefault: 10,
  startAtMax: 1e3
};
var ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
var DEFAULT_FIELDS = ["summary", "status", "assignee", "description", "issuetype"];
var HELD = "Held for approval. A Jira admin must approve before this change applies. Do not retry; check back later.";
var FAIL_CLOSED = "Denied: the call could not be checked. Retry later.";
var JSON_HEADERS = {
  "Content-Type": ["application/json"],
  "Access-Control-Allow-Origin": ["*"],
  "Access-Control-Allow-Headers": ["authorization, content-type, accept, mcp-protocol-version, mcp-session-id"],
  "Access-Control-Allow-Methods": ["POST, OPTIONS"]
};
var TOOLS = {
  guard_whoami: {
    description: "Show this agent's name, allowed tools, allowed projects, write mode, and rate-limit numbers.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", properties: {} },
    parse(args) {
      if (args !== void 0 && !isRecord(args)) {
        return { ok: false, target: { tool: "guard_whoami", issueKey: null }, message: "Arguments must be an object." };
      }
      return { ok: true, call: { tool: "guard_whoami" } };
    }
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
        startAt: { type: "integer", minimum: 0, maximum: LIMITS.startAtMax, default: 0 }
      }
    },
    parse(args) {
      const target = { tool: "jira_search_issues", issueKey: null };
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
    }
  },
  jira_get_issue: {
    description: "Get one issue: summary, status, assignee, description, and any requested fields.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["issueKey"],
      properties: {
        issueKey: { type: "string", pattern: ISSUE_KEY.source },
        fields: { type: "array", items: { type: "string" } }
      }
    },
    parse(args) {
      const found = takeIssueKey("jira_get_issue", args);
      if (!found.ok) {
        return found.result;
      }
      const fields = readFields(found.args.fields, DEFAULT_FIELDS);
      if (!fields) {
        return { ok: false, target: found.target, message: "fields must be an array of strings." };
      }
      return { ok: true, call: { tool: "jira_get_issue", issueKey: found.issueKey, fields } };
    }
  },
  jira_list_transitions: {
    description: "List the transitions currently valid for an issue.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["issueKey"],
      properties: { issueKey: { type: "string", pattern: ISSUE_KEY.source } }
    },
    parse(args) {
      const found = takeIssueKey("jira_list_transitions", args);
      if (!found.ok) {
        return found.result;
      }
      return { ok: true, call: { tool: "jira_list_transitions", issueKey: found.issueKey } };
    }
  },
  jira_add_comment: {
    description: "Add a comment. The stored text includes the agent name.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["issueKey", "body"],
      properties: {
        issueKey: { type: "string", pattern: ISSUE_KEY.source },
        body: { type: "string", maxLength: LIMITS.body }
      }
    },
    parse(args) {
      const found = takeIssueKey("jira_add_comment", args);
      if (!found.ok) {
        return found.result;
      }
      if (typeof found.args.body !== "string" || found.args.body.length > LIMITS.body) {
        return { ok: false, target: found.target, message: "body must be a string of at most 10000 characters." };
      }
      return { ok: true, call: { tool: "jira_add_comment", issueKey: found.issueKey, body: found.args.body } };
    }
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
        toStatus: { type: "string" }
      }
    },
    parse(args) {
      const found = takeIssueKey("jira_transition_issue", args);
      if (!found.ok) {
        return found.result;
      }
      const transitionId = nonEmpty(found.args.transitionId);
      const toStatus = nonEmpty(found.args.toStatus);
      if (transitionId !== void 0 && toStatus === void 0) {
        return { ok: true, call: { tool: "jira_transition_issue", issueKey: found.issueKey, target: { transitionId } } };
      }
      if (toStatus !== void 0 && transitionId === void 0) {
        return { ok: true, call: { tool: "jira_transition_issue", issueKey: found.issueKey, target: { toStatus } } };
      }
      return { ok: false, target: found.target, message: "Send transitionId or toStatus." };
    }
  },
  jira_assign_issue: {
    description: "Assign the issue to an account, or pass null to unassign it.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["issueKey", "accountId"],
      properties: {
        issueKey: { type: "string", pattern: ISSUE_KEY.source },
        accountId: { type: ["string", "null"] }
      }
    },
    parse(args) {
      const found = takeIssueKey("jira_assign_issue", args);
      if (!found.ok) {
        return found.result;
      }
      if (typeof found.args.accountId !== "string" && found.args.accountId !== null) {
        return { ok: false, target: found.target, message: "accountId must be a string or null." };
      }
      return {
        ok: true,
        call: { tool: "jira_assign_issue", issueKey: found.issueKey, accountId: found.args.accountId }
      };
    }
  },
  jira_update_fields: {
    description: "Update fields on an issue.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      required: ["issueKey", "fields"],
      properties: {
        issueKey: { type: "string", pattern: ISSUE_KEY.source },
        fields: { type: "object" }
      }
    },
    parse(args) {
      const found = takeIssueKey("jira_update_fields", args);
      if (!found.ok) {
        return found.result;
      }
      const fields = jsonObject(found.args.fields);
      if (!fields) {
        return { ok: false, target: found.target, message: "fields must be an object." };
      }
      return { ok: true, call: { tool: "jira_update_fields", issueKey: found.issueKey, fields } };
    }
  }
};
async function handleMcp(request, deps) {
  if (request.method?.toUpperCase() === "OPTIONS") {
    return respond(204);
  }
  let message;
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
      requestId: requestLabel(rpcId(message))
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
          requestId: requestLabel(id)
        });
        if (!saved) {
          return rpcError(200, id, -32603, FAIL_CLOSED);
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
          requestId: requestLabel(id)
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
function readPolicyTarget(tool, args) {
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
        ...typeof record.body === "string" ? { body: record.body } : {}
      };
    case "jira_transition_issue":
      return {
        tool,
        issueKey: typeof record.issueKey === "string" ? record.issueKey : null,
        ...typeof record.transitionId === "string" ? { transitionId: record.transitionId } : {},
        ...typeof record.toStatus === "string" ? { toStatus: record.toStatus } : {}
      };
    case "jira_assign_issue":
      return {
        tool,
        issueKey: typeof record.issueKey === "string" ? record.issueKey : null,
        ...typeof record.accountId === "string" || record.accountId === null ? { accountId: record.accountId } : {}
      };
    case "jira_update_fields": {
      const fields = jsonObject(record.fields);
      return {
        tool,
        issueKey: typeof record.issueKey === "string" ? record.issueKey : null,
        ...fields ? { fields } : {}
      };
    }
    default: {
      const unreachable = tool;
      return unreachable;
    }
  }
}
function toDecision(target) {
  return {
    tool: target.tool,
    issueKey: target.issueKey,
    body: target.body,
    fields: target.fields,
    transitionId: target.transitionId,
    toStatus: target.toStatus,
    accountId: target.accountId
  };
}
function targetOf(call) {
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
      const unreachable = call;
      return unreachable;
    }
  }
}
async function executeAllowed(call, agent, policy, jira) {
  switch (call.tool) {
    case "guard_whoami":
      return envelope("ok", {
        agent: agent.name,
        allowedTools: visibleTools(policy.allowedTools),
        allowedProjects: policy.allowedProjects,
        writeMode: policy.writeMode,
        rateLimit: policy.rateLimit
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
      const unreachable = call;
      return unreachable;
    }
  }
}
async function keepAudit(store2, draft) {
  try {
    await store2.appendAudit({
      agentId: draft.agentId,
      tool: draft.tool,
      issueKey: draft.issueKey,
      project: draft.issueKey ? projectKey(draft.issueKey) : null,
      outcome: draft.outcome,
      reason: draft.reason,
      before: draft.before ?? null,
      after: draft.after ?? null,
      injectionFlagged: false,
      requestId: draft.requestId
    });
    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "audit failed");
    return false;
  }
}
function requestLabel(id) {
  return id === null ? "none" : String(id);
}
async function knownAgent(store2, token) {
  const agent = await resolveToken(store2, token);
  return agent ? agent.id : "unknown";
}
function row(request, agent, outcome, reason, id, after = null) {
  return {
    agentId: agent,
    tool: request.tool,
    issueKey: request.issueKey ?? null,
    outcome,
    reason,
    after,
    requestId: requestLabel(id)
  };
}
function isWrite(tool) {
  return tool === "jira_add_comment" || tool === "jira_transition_issue" || tool === "jira_assign_issue" || tool === "jira_update_fields";
}
function writeAfter(call, agentName) {
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
async function handleCall(message, token, id, deps) {
  const params = isRecord(message.params) ? message.params : {};
  const name = typeof params.name === "string" ? params.name : "";
  const args = params.arguments === void 0 ? {} : params.arguments;
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
async function listResponse(store2, agent, token, id) {
  const policy = await store2.getPolicy(agent.policy_id);
  if (!policy) {
    const decision = await nextCall(store2, token, { tool: "guard_whoami" });
    const message = decision.kind === "deny" ? decision.agentMessage : FAIL_CLOSED;
    return toolResult(id, envelope("denied", {}, message), true);
  }
  return respond(200, { jsonrpc: "2.0", id, result: { tools: listTools(policy.allowedTools) } });
}
async function methodResponse(message, store2, agent, token, id) {
  switch (message.method) {
    case "notifications/initialized":
      return respond(202);
    case "initialize":
      return respond(200, { jsonrpc: "2.0", id, result: initializeResult() });
    case "ping":
      return respond(200, { jsonrpc: "2.0", id, result: {} });
    case "tools/list":
      return await listResponse(store2, agent, token, id);
    default:
      return rpcError(200, id, -32601, "Method not found");
  }
}
async function authError(store2, token, id, tool) {
  const decision = await nextCall(store2, token, { tool });
  const message = decision.kind === "deny" ? decision.agentMessage : FAIL_CLOSED;
  await keepAudit(store2, {
    agentId: "unknown",
    tool,
    issueKey: null,
    outcome: "auth_failed",
    reason: "auth",
    requestId: requestLabel(id)
  });
  return rpcError(401, id, -32001, message);
}
async function recordParseFailure(store2) {
  try {
    await store2.appendAudit({
      agentId: "unknown",
      tool: "jsonrpc",
      issueKey: null,
      project: null,
      outcome: "denied",
      reason: "parse",
      before: null,
      after: null,
      injectionFlagged: false,
      requestId: "parse"
    });
  } catch {
  }
}
function looseRequest(tool, args) {
  const record = isRecord(args) ? args : {};
  const fields = jsonObject(record.fields);
  return {
    tool,
    issueKey: typeof record.issueKey === "string" ? record.issueKey : null,
    ...typeof record.body === "string" ? { body: record.body } : {},
    ...fields ? { fields } : {},
    ...typeof record.transitionId === "string" ? { transitionId: record.transitionId } : {},
    ...typeof record.toStatus === "string" ? { toStatus: record.toStatus } : {},
    ...typeof record.accountId === "string" || record.accountId === null ? { accountId: record.accountId } : {}
  };
}
function catalogToolNames() {
  return Object.keys(TOOLS);
}
function visibleTools(allowed) {
  return Object.keys(TOOLS).filter((name) => allowed.includes(name));
}
function listTools(allowed) {
  return visibleTools(allowed).map((name) => {
    const spec = TOOLS[name];
    return {
      name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: spec.annotations
    };
  });
}
function visiblePage(page, allowed) {
  const issues = page.issues.filter((issue) => {
    const project = projectKey(issue.key);
    return project !== null && allowed.includes(project);
  });
  if (issues.length === page.issues.length) {
    return page;
  }
  return { issues, total: null, nextStartAt: page.nextStartAt };
}
function pageJson(page) {
  return {
    issues: page.issues,
    total: page.total,
    nextStartAt: page.nextStartAt
  };
}
function blockedField(fields, allowed) {
  for (const name of Object.keys(fields)) {
    if (!allowed.includes(name)) {
      return name;
    }
  }
  return null;
}
function fieldDenial(field, allowed) {
  const listed = allowed.length === 0 ? "none" : allowed.join(", ");
  return `Denied: field '${field}' is not editable by this agent. Editable fields: ${listed}.`;
}
function projectKey(issueKey) {
  const match = /^([A-Z][A-Z0-9_]+)-\d+$/.exec(issueKey);
  return match ? match[1] : null;
}
function commentDocument(text) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }]
  };
}
function initializeResult() {
  return {
    protocolVersion: "2025-11-25",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "jiraguard", version: "0.3.0" }
  };
}
function takeIssueKey(tool, args) {
  const target = readPolicyTarget(tool, args);
  if (!isRecord(args) || typeof args.issueKey !== "string" || !ISSUE_KEY.test(args.issueKey)) {
    return { ok: false, result: { ok: false, target, message: "issueKey must match ^[A-Z][A-Z0-9_]+-\\d+$." } };
  }
  return { ok: true, issueKey: args.issueKey, args, target };
}
function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function readFields(value, fallback) {
  if (value === void 0) {
    return [...fallback];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value;
}
function readLimit(value) {
  if (value === void 0) {
    return LIMITS.limitDefault;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < LIMITS.limitMin || value > LIMITS.limitMax) {
    return null;
  }
  return value;
}
function readStartAt(value) {
  if (value === void 0) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > LIMITS.startAtMax) {
    return null;
  }
  return value;
}
function jsonObject(value) {
  const parsed = asJson(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  return void 0;
}
function asJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : void 0;
  }
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      const parsed = asJson(item);
      if (parsed === void 0) {
        return void 0;
      }
      items.push(parsed);
    }
    return items;
  }
  if (!isRecord(value)) {
    return void 0;
  }
  const record = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = asJson(item);
    if (parsed === void 0) {
      return void 0;
    }
    record[key] = parsed;
  }
  return record;
}
function envelope(status, data, message) {
  const result = { status, data, guard: { flagged: false, reasons: [] } };
  if (message !== void 0) {
    result.message = message;
  }
  return result;
}
function toolResult(id, body, isError) {
  return respond(200, {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: body.message ?? JSON.stringify(body.data) }],
      structuredContent: body,
      isError
    }
  });
}
function rpcError(statusCode, id, code, message) {
  return respond(statusCode, { jsonrpc: "2.0", id, error: { code, message } });
}
function respond(statusCode, payload) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: payload === void 0 ? "" : JSON.stringify(payload)
  };
}
function bearerToken(request) {
  const headers = request.headers ?? {};
  const key = Object.keys(headers).find((item) => item.toLowerCase() === "authorization");
  if (!key) {
    return "";
  }
  const value = headers[key];
  if (value === void 0) {
    return "";
  }
  const raw = Array.isArray(value) ? value.join(", ") : value;
  const match = /^Bearer\s+(\S+)/i.exec(raw);
  return match ? match[1] : "";
}
function rpcId(message) {
  if (!isRecord(message) || !Object.prototype.hasOwnProperty.call(message, "id")) {
    return null;
  }
  const id = message.id;
  if (id === null || typeof id === "string" || typeof id === "number") {
    return id;
  }
  return null;
}
function isToolName(name) {
  return Object.prototype.hasOwnProperty.call(TOOLS, name);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/jira/cloud.ts
var PAGE_SIZE = 100;
var MAX_WALKS = 21;
function createCloudJira(request) {
  return {
    async search(query) {
      return searchPages(request, query);
    },
    async getIssue(issueKey, fields) {
      const payload = await send(request, `/issue/${encodeURIComponent(issueKey)}?fields=${fields.join(",")}`);
      return issueFrom(payload);
    },
    async listTransitions(issueKey) {
      const payload = await send(request, `/issue/${encodeURIComponent(issueKey)}/transitions`);
      return transitionsFrom(payload);
    },
    async addComment(issueKey, body) {
      await send(request, `/issue/${encodeURIComponent(issueKey)}`, {
        method: "PUT",
        body: { update: { comment: [{ add: { body: documentJson(body) } }] } }
      });
      const payload = await send(request, `/issue/${encodeURIComponent(issueKey)}?fields=comment`);
      return { id: latestCommentId(payload) };
    },
    async transition(issueKey, target) {
      const id = "transitionId" in target ? target.transitionId : await transitionIdFor(request, issueKey, target);
      await send(request, `/issue/${encodeURIComponent(issueKey)}/transitions`, {
        method: "POST",
        body: { transition: { id } }
      });
    },
    async assign(issueKey, accountId) {
      await send(request, `/issue/${encodeURIComponent(issueKey)}/assignee`, {
        method: "PUT",
        body: { accountId }
      });
    },
    async updateFields(issueKey, fields) {
      await send(request, `/issue/${encodeURIComponent(issueKey)}`, {
        method: "PUT",
        body: { fields }
      });
    }
  };
}
async function searchPages(request, query) {
  let skipped = 0;
  let pageToken = null;
  for (let walk = 0; walk < MAX_WALKS; walk += 1) {
    const body = {
      jql: query.jql,
      maxResults: PAGE_SIZE,
      fields: query.fields
    };
    if (pageToken) {
      body.nextPageToken = pageToken;
    }
    const payload = await send(request, "/search/jql", { method: "POST", body });
    const issues = issuesFrom(payload);
    const next = optionalString(payload, "nextPageToken");
    const total = readTotal(payload);
    if (skipped + issues.length <= query.startAt) {
      skipped += issues.length;
      if (!next) {
        return { issues: [], total, nextStartAt: null };
      }
      pageToken = next;
      continue;
    }
    const start = query.startAt - skipped;
    const slice = issues.slice(start, start + query.limit);
    const moreInPage = start + query.limit < issues.length;
    return {
      issues: slice,
      total,
      nextStartAt: next || moreInPage ? query.startAt + slice.length : null
    };
  }
  throw new Error("search offset is too large");
}
async function transitionIdFor(request, issueKey, target) {
  if (!("toStatus" in target)) {
    return target.transitionId;
  }
  const choices = await createCloudJira(request).listTransitions(issueKey);
  const found = choices.find((choice) => choice.to === target.toStatus);
  if (!found) {
    throw new Error("Jira transition was not found");
  }
  return found.id;
}
async function send(request, path, init) {
  const response = await request(path, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Jira ${response.status}`);
  }
  if (text === "") {
    return null;
  }
  return JSON.parse(text);
}
function issuesFrom(payload) {
  if (!isRecord2(payload) || !Array.isArray(payload.issues)) {
    return [];
  }
  return payload.issues.map((issue) => issueFrom(issue));
}
function issueFrom(payload) {
  if (!isRecord2(payload) || typeof payload.key !== "string") {
    throw new Error("Jira issue has no key");
  }
  const fields = isRecord2(payload.fields) ? payload.fields : {};
  return { key: payload.key, fields };
}
function transitionsFrom(payload) {
  if (!isRecord2(payload) || !Array.isArray(payload.transitions)) {
    return [];
  }
  return payload.transitions.map((item) => {
    if (!isRecord2(item) || typeof item.id !== "string" || typeof item.name !== "string") {
      throw new Error("Jira transition is incomplete");
    }
    const to = isRecord2(item.to) && typeof item.to.name === "string" ? item.to.name : "";
    return { id: item.id, name: item.name, to };
  });
}
function documentJson(body) {
  return body;
}
function latestCommentId(payload) {
  if (!isRecord2(payload) || !isRecord2(payload.fields) || !isRecord2(payload.fields.comment)) {
    throw new Error("Jira comment was not stored");
  }
  const comments = payload.fields.comment.comments;
  if (!Array.isArray(comments) || comments.length === 0) {
    throw new Error("Jira comment was not stored");
  }
  const last = comments[comments.length - 1];
  return stringField(last, "id");
}
function stringField(payload, key) {
  if (!isRecord2(payload) || typeof payload[key] !== "string") {
    throw new Error("Jira response is incomplete");
  }
  return payload[key];
}
function readTotal(payload) {
  if (!isRecord2(payload) || typeof payload.total !== "number") {
    return null;
  }
  return payload.total;
}
function optionalString(payload, key) {
  if (!isRecord2(payload) || typeof payload[key] !== "string" || payload[key] === "") {
    return null;
  }
  return payload[key];
}
function isRecord2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// src/product/proof.ts
var PROJECT_KEY2 = /^[A-Z][A-Z0-9_]+$/;
var TOKEN_HASH = /^[0-9a-f]{64}$/;
async function ensureProofAgent(store2, spec) {
  if (!TOKEN_HASH.test(spec.tokenHash) || !PROJECT_KEY2.test(spec.project) || spec.name.trim() === "") {
    throw new Error("JiraGuard proof agent is not configured.");
  }
  const existing = await store2.getAgentByHash(spec.tokenHash);
  if (existing) {
    return;
  }
  const policy = await store2.createPolicy({
    allowedTools: catalogToolNames(),
    allowedProjects: [spec.project],
    writeMode: "allow",
    fieldAllowList: [],
    rateLimit: { reads: 120, writes: 20, windowSeconds: 3600 },
    maxResults: 25,
    injectionMode: "annotate"
  });
  await store2.putAgent({
    id: "agt_proof",
    name: spec.name,
    description: "",
    token_hash: spec.tokenHash,
    status: "active",
    created_by: "proof",
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    last_used_at: null,
    policy_id: policy.id
  });
}

// src/storage/kvs.ts
var import_node_crypto2 = require("crypto");

// src/storage/memory.ts
function auditMatches(event, query) {
  if (query?.agentId !== void 0 && event.agentId !== query.agentId) {
    return false;
  }
  if (query?.outcome !== void 0 && event.outcome !== query.outcome) {
    return false;
  }
  if (query?.issueKey !== void 0 && event.issueKey !== query.issueKey) {
    return false;
  }
  if (query?.from !== void 0 && earlier(event.ts, query.from)) {
    return false;
  }
  if (query?.to !== void 0 && earlier(query.to, event.ts)) {
    return false;
  }
  return true;
}
function earlier(left, right) {
  const start = Date.parse(left);
  const end = Date.parse(right);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return true;
  }
  return start < end;
}

// src/storage/kvs.ts
var AGENTS = "index:agents";
var POLICIES = "index:policies";
var PENDING = "index:pending";
function createKvsStore(kv) {
  return {
    async putAgent(agent) {
      await kv.set(agentKey(agent.id), agent);
      await kv.set(hashKey(agent.token_hash), agent.id);
      await addId(kv, AGENTS, agent.id);
    },
    async getAgent(id) {
      return readRecord(kv, agentKey(id));
    },
    async listAgents() {
      return readAll(kv, AGENTS, agentKey);
    },
    async getAgentByHash(tokenHash) {
      const id = await kv.get(hashKey(tokenHash));
      if (typeof id !== "string") {
        return null;
      }
      return readRecord(kv, agentKey(id));
    },
    async createPolicy(input) {
      const policy = { id: newId("pol"), ...input };
      await kv.set(policyKey(policy.id), policy);
      await addId(kv, POLICIES, policy.id);
      return policy;
    },
    async getPolicy(id) {
      return readRecord(kv, policyKey(id));
    },
    async listPolicies() {
      return readAll(kv, POLICIES, policyKey);
    },
    async appendAudit(input) {
      const event = auditFrom(input);
      await kv.set(auditKey(event.id), event);
      return event;
    },
    async listAudits(query) {
      const keys = await kv.list("audit:");
      const records = [];
      for (const key of keys) {
        const event = await readRecord(kv, key);
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
      return readRecord(kv, pendingKey(id));
    },
    async listPending(query) {
      const actions = await readAll(kv, PENDING, pendingKey);
      return actions.filter((action) => query?.status === void 0 || action.status === query.status);
    }
  };
}
function newId(prefix) {
  return `${prefix}_${(0, import_node_crypto2.randomBytes)(8).toString("hex")}`;
}
function agentKey(id) {
  return `agent:${id}`;
}
function hashKey(tokenHash) {
  return `hash:${tokenHash}`;
}
function policyKey(id) {
  return `policy:${id}`;
}
function auditKey(id) {
  return `audit:${id}`;
}
function pendingKey(id) {
  return `pending:${id}`;
}
function auditFrom(input) {
  return {
    id: newId("evt"),
    ts: input.ts ?? (/* @__PURE__ */ new Date()).toISOString(),
    agentId: input.agentId,
    tool: input.tool,
    issueKey: input.issueKey,
    project: input.project,
    outcome: input.outcome,
    reason: input.reason,
    before: input.before,
    after: input.after,
    injectionFlagged: input.injectionFlagged,
    requestId: input.requestId
  };
}
function pendingFrom(input) {
  return {
    id: newId("act"),
    agentId: input.agentId,
    tool: input.tool,
    args: input.args,
    issueKey: input.issueKey,
    diff: input.diff,
    status: "pending",
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    decidedBy: null,
    decidedAt: null
  };
}
async function addId(kv, index, id) {
  const ids = await readIds(kv, index);
  if (ids.includes(id)) {
    return;
  }
  await kv.set(index, [...ids, id]);
}
async function readIds(kv, index) {
  const value = await kv.get(index);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === "string");
}
async function readRecord(kv, key) {
  const value = await kv.get(key);
  return value === void 0 || value === null ? null : value;
}
async function readAll(kv, index, keyFor) {
  const ids = await readIds(kv, index);
  const records = [];
  for (const id of ids) {
    const record = await readRecord(kv, keyFor(id));
    if (record) {
      records.push(record);
    }
  }
  return records;
}
function matchesAudit(event, query) {
  return auditMatches(event, query);
}

// src/product/handler.ts
var store = createKvsStore({
  async get(key) {
    return import_kvs.kvs.get(key);
  },
  async set(key, value) {
    await import_kvs.kvs.set(key, value);
  },
  async list(prefix) {
    const keys = [];
    let cursor;
    do {
      let query = import_kvs.kvs.query().where("key", import_kvs.WhereConditions.beginsWith(prefix)).limit(100);
      if (cursor) {
        query = query.cursor(cursor);
      }
      const page = await query.getMany();
      for (const result of page.results) {
        keys.push(result.key);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return keys;
  }
});
async function mcpHandler(request) {
  const tokenHash = process.env.JIRAGUARD_PROOF_TOKEN_HASH ?? "";
  const project = process.env.JIRAGUARD_PROOF_PROJECT ?? "";
  const name = process.env.JIRAGUARD_PROOF_NAME || "proof";
  try {
    await ensureProofAgent(store, { tokenHash, project, name });
  } catch {
    return {
      statusCode: 500,
      headers: { "Content-Type": ["application/json"] },
      body: JSON.stringify({ error: "JiraGuard proof agent is not configured." })
    };
  }
  return handleMcp(request, { store, jira: createCloudJira(requestJira) });
}
async function requestJira(path, init) {
  const method = init?.method ?? "GET";
  const options = {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: init?.body === void 0 ? void 0 : JSON.stringify(init.body)
  };
  if (path === "/search/jql") {
    return (0, import_api.asApp)().requestJira(import_api.route`/rest/api/3/search/jql`, options);
  }
  const comment = /^\/issue\/([^/]+)\/comment$/.exec(path);
  if (comment) {
    const issueKey = decodeURIComponent(comment[1]);
    return (0, import_api.asApp)().requestJira(import_api.route`/rest/api/3/issue/${issueKey}/comment`, options);
  }
  const transitions = /^\/issue\/([^/]+)\/transitions$/.exec(path);
  if (transitions) {
    const issueKey = decodeURIComponent(transitions[1]);
    return (0, import_api.asApp)().requestJira(import_api.route`/rest/api/3/issue/${issueKey}/transitions`, options);
  }
  const assignee = /^\/issue\/([^/]+)\/assignee$/.exec(path);
  if (assignee) {
    const issueKey = decodeURIComponent(assignee[1]);
    return (0, import_api.asApp)().requestJira(import_api.route`/rest/api/3/issue/${issueKey}/assignee`, options);
  }
  const withFields = /^\/issue\/([^/]+)\?fields=(.+)$/.exec(path);
  if (withFields) {
    const issueKey = decodeURIComponent(withFields[1]);
    const fields = decodeURIComponent(withFields[2]);
    return (0, import_api.asApp)().requestJira(import_api.route`/rest/api/3/issue/${issueKey}?fields=${fields}`, options);
  }
  const issue = /^\/issue\/([^/]+)$/.exec(path);
  if (issue) {
    const issueKey = decodeURIComponent(issue[1]);
    return (0, import_api.asApp)().requestJira(import_api.route`/rest/api/3/issue/${issueKey}`, options);
  }
  throw new Error("unsupported jira path");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  mcpHandler
});
