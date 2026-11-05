import type { FieldDiff, Json, PolicyRecord, WriteMode } from "../domain/records.ts";
import { resolveToken } from "../auth/token.ts";
import type { RecordStore } from "../storage/memory.ts";

const WRITE_TOOLS = new Set([
  "jira_add_comment",
  "jira_transition_issue",
  "jira_assign_issue",
  "jira_update_fields",
  "jira_create_issue",
]);

const PROJECT_DENIAL =
  "Denied: that issue is not available to this agent. Use jira_search_issues to find issues you can access.";

const AUTH_DENIAL = "401: missing, invalid or revoked agent token.";

const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

export type Decision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string; agentMessage: string }
  | { kind: "needs_approval"; diff: FieldDiff[] };

export type DecisionRequest = {
  tool: string;
  project?: string | null;
  issueKey?: string | null;
  fields?: Record<string, Json>;
  before?: Record<string, Json>;
  body?: string;
  transitionId?: string;
  toStatus?: string;
  accountId?: string | null;
};

export function searchProjectJql(policy: PolicyRecord): string {
  const keys = policy.allowedProjects.filter((key) => PROJECT_KEY.test(key));
  if (keys.length === 0) {
    return "id = 0";
  }
  const names = keys.map((key) => `"${key}"`).join(", ");
  return `project in (${names})`;
}

export function decide(policy: PolicyRecord, request: DecisionRequest): Decision {
  if (!policy.allowedTools.includes(request.tool)) {
    const listed = policy.allowedTools.length === 0 ? "none" : policy.allowedTools.join(", ");
    return {
      kind: "deny",
      reason: "tool",
      agentMessage: `Denied: this agent is not allowed to use ${request.tool}. Allowed tools: ${listed}. Call guard_whoami for full details.`,
    };
  }

  const project = scopedProject(request);
  if (project === "deny" || (request.tool === "jira_create_issue" && !project)) {
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

export async function nextCall(
  store: RecordStore,
  token: string,
  request: DecisionRequest,
): Promise<Decision> {
  const agent = await resolveToken(store, token);
  if (!agent) {
    return { kind: "deny", reason: "auth", agentMessage: AUTH_DENIAL };
  }
  const policy = await store.getPolicy(agent.policy_id);
  if (!policy) {
    return {
      kind: "deny",
      reason: "policy",
      agentMessage: "Denied: this agent has no policy. Call guard_whoami for full details.",
    };
  }
  return decide(policy, request);
}

function issueProject(issueKey: string): string | null {
  const match = /^([A-Z][A-Z0-9_]+)-\d+$/.exec(issueKey);
  return match ? match[1] : null;
}

function fieldProject(fields: Record<string, Json> | undefined): string | null | "deny" {
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

function scopedProject(request: DecisionRequest): string | null | "deny" {
  const fromKey = request.issueKey ? issueProject(request.issueKey) : null;
  const fromFields = fieldProject(request.fields);
  if (request.issueKey && !fromKey) {
    return "deny";
  }
  if (fromFields === "deny") {
    return "deny";
  }
  const named = [fromKey, request.project ?? null, fromFields].filter((item): item is string => item !== null);
  if (named.some((item) => item !== named[0])) {
    return "deny";
  }
  return named[0] ?? null;
}

function proposedChanges(request: DecisionRequest): Array<[string, Json]> {
  const changes: Array<[string, Json]> = Object.entries(request.fields ?? {});
  if (request.body !== undefined) {
    changes.push(["body", request.body]);
  }
  if (request.transitionId !== undefined) {
    changes.push(["transitionId", request.transitionId]);
  }
  if (request.toStatus !== undefined) {
    changes.push(["toStatus", request.toStatus]);
  }
  if (request.accountId !== undefined) {
    changes.push(["accountId", request.accountId]);
  }
  return changes;
}

function writeDecision(mode: WriteMode, request: DecisionRequest): Decision {
  switch (mode) {
    case "deny":
      return {
        kind: "deny",
        reason: "write_mode",
        agentMessage: "Denied: this agent is not allowed to write. Call guard_whoami for full details.",
      };
    case "approve": {
      const before = request.before;
      return {
        kind: "needs_approval",
        diff: proposedChanges(request).map(([field, after]) => ({
          field,
          before: before && field in before ? before[field] : null,
          after,
        })),
      };
    }
    case "allow":
      return { kind: "allow" };
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
}
