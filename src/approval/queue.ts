import type { Json, PendingAction } from "../domain/records.ts";
import { executeAllowed, readBefore, type JiraWork, type ToolCall } from "../gate/handle.ts";
import type { RecordStore } from "../storage/memory.ts";

export type QueueRow = {
  id: string;
  agentId: string;
  agentName: string;
  issueKey: string;
  tool: string;
  diff: PendingAction["diff"];
  status: "pending" | "uncertain";
};

export type DecisionResult = { ok: true } | { ok: false; reason: string };

const NOT_WAITING = "That action is not waiting for approval.";
const ISSUE_GONE = "That issue is no longer available.";
const ISSUE_CHANGED = "The issue changed since this action was requested.";

export async function listApprovalQueue(store: RecordStore): Promise<QueueRow[]> {
  const actions = await store.listPending();
  const rows: QueueRow[] = [];
  for (const action of actions) {
    if (action.status !== "pending" && action.status !== "uncertain") {
      continue;
    }
    const agent = await store.getAgent(action.agentId);
    rows.push({
      id: action.id,
      agentId: action.agentId,
      agentName: agent?.name ?? "unknown",
      issueKey: action.issueKey,
      tool: action.tool,
      diff: action.diff,
      status: action.status,
    });
  }
  return rows;
}

export async function approvePending(
  store: RecordStore,
  jira: JiraWork,
  actionId: string,
  decidedBy: string,
): Promise<DecisionResult> {
  const action = await store.claimPending(actionId);
  if (!action) {
    return { ok: false, reason: NOT_WAITING };
  }
  const call = callFrom(action);
  const agent = await store.getAgent(action.agentId);
  const policy = agent ? await store.getPolicy(agent.policy_id) : null;
  if (!call || !agent || !policy) {
    await store.finishPending(action.id, "rejected", decidedBy);
    return { ok: false, reason: NOT_WAITING };
  }
  const storedBefore = snapshot(action.args.before);
  if (storedBefore) {
    let current: Record<string, Json> | null;
    try {
      current = await readBefore(jira, call);
    } catch {
      await store.finishPending(action.id, "rejected", decidedBy);
      return { ok: false, reason: ISSUE_GONE };
    }
    if (JSON.stringify(current) !== JSON.stringify(storedBefore)) {
      await store.finishPending(action.id, "rejected", decidedBy);
      return { ok: false, reason: ISSUE_CHANGED };
    }
  }
  try {
    await executeAllowed(call, agent, policy, jira);
  } catch {
    await store.finishPending(action.id, "uncertain", decidedBy);
    await store.appendAudit(audit(action, "uncertain", "uncertain", storedBefore, afterFrom(action)));
    return { ok: false, reason: "The write did not finish. Jira may already have changed." };
  }
  const finished = await store.finishPending(action.id, "approved", decidedBy);
  if (!finished) {
    return { ok: false, reason: NOT_WAITING };
  }
  await store.appendAudit(audit(action, "approved", null, storedBefore, afterFrom(action)));
  return { ok: true };
}

export async function rejectPending(
  store: RecordStore,
  actionId: string,
  decidedBy: string,
): Promise<DecisionResult> {
  const action = await store.claimPending(actionId);
  if (!action) {
    return { ok: false, reason: NOT_WAITING };
  }
  const finished = await store.finishPending(action.id, "rejected", decidedBy);
  if (!finished) {
    return { ok: false, reason: NOT_WAITING };
  }
  await store.appendAudit(audit(action, "rejected", null, snapshot(action.args.before), null));
  return { ok: true };
}

function callFrom(action: PendingAction): ToolCall | null {
  const args = action.args;
  switch (action.tool) {
    case "jira_add_comment":
      return typeof args.body === "string"
        ? { tool: "jira_add_comment", issueKey: action.issueKey, body: args.body }
        : null;
    case "jira_transition_issue":
      if (typeof args.transitionId === "string") {
        return { tool: "jira_transition_issue", issueKey: action.issueKey, target: { transitionId: args.transitionId } };
      }
      if (typeof args.toStatus === "string") {
        return { tool: "jira_transition_issue", issueKey: action.issueKey, target: { toStatus: args.toStatus } };
      }
      return null;
    case "jira_assign_issue":
      if (typeof args.accountId === "string" || args.accountId === null) {
        return { tool: "jira_assign_issue", issueKey: action.issueKey, accountId: args.accountId };
      }
      return null;
    case "jira_update_fields":
      if (args.fields && typeof args.fields === "object" && !Array.isArray(args.fields)) {
        return { tool: "jira_update_fields", issueKey: action.issueKey, fields: args.fields };
      }
      return null;
    default:
      return null;
  }
}

function snapshot(value: Json | undefined): Record<string, Json> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function afterFrom(action: PendingAction): Record<string, Json> {
  const after: Record<string, Json> = {};
  for (const entry of action.diff) {
    after[entry.field] = entry.after;
  }
  return after;
}

function audit(
  action: PendingAction,
  outcome: "approved" | "rejected" | "uncertain",
  reason: string | null,
  before: Record<string, Json> | null,
  after: Record<string, Json> | null,
) {
  const project = /^([A-Z][A-Z0-9_]+)-\d+$/.exec(action.issueKey)?.[1] ?? null;
  return {
    agentId: action.agentId,
    tool: action.tool,
    issueKey: action.issueKey,
    project,
    outcome,
    reason,
    before,
    after,
    injectionFlagged: false,
    requestId: action.id,
  };
}
