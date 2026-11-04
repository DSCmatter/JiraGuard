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
};

export function searchProjectJql(policy: PolicyRecord): string {
  if (policy.allowedProjects.length === 0) {
    return "id = 0";
  }
  const names = policy.allowedProjects.map((key) => `"${key}"`).join(", ");
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
  if (project === "deny") {
    return { kind: "deny", reason: "project", agentMessage: PROJECT_DENIAL };
  }
  if (project && !policy.allowedProjects.includes(project)) {
    return { kind: "deny", reason: "project", agentMessage: PROJECT_DENIAL };
  }

  if (!WRITE_TOOLS.has(request.tool)) {
    return { kind: "allow" };
  }
  return writeDecision(policy.writeMode, request.fields, request.before);
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

function scopedProject(request: DecisionRequest): string | null | "deny" {
  const fromKey = request.issueKey ? issueProject(request.issueKey) : null;
  if (request.issueKey && !fromKey) {
    return "deny";
  }
  if (fromKey && request.project && fromKey !== request.project) {
    return "deny";
  }
  return fromKey ?? request.project ?? null;
}

function writeDecision(
  mode: WriteMode,
  fields: Record<string, Json> | undefined,
  before: Record<string, Json> | undefined,
): Decision {
  switch (mode) {
    case "deny":
      return {
        kind: "deny",
        reason: "write_mode",
        agentMessage: "Denied: this agent is not allowed to write. Call guard_whoami for full details.",
      };
    case "approve":
      return {
        kind: "needs_approval",
        diff: Object.entries(fields ?? {}).map(([field, after]) => ({
          field,
          before: before && field in before ? before[field] : null,
          after,
        })),
      };
    case "allow":
      return { kind: "allow" };
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
}
