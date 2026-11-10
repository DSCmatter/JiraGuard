import type { Json } from "../domain/records.ts";
import type {
  CommentDocument,
  IssueView,
  JiraWork,
  SearchPage,
  TransitionChoice,
  TransitionTarget,
} from "../gate/handle.ts";

export type JiraHttp = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

export type JiraRequest = (path: string, init?: { method?: string; body?: Json }) => Promise<JiraHttp>;

const PAGE_WALKS = 20;

export function createCloudJira(request: JiraRequest): JiraWork {
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
        body: { update: { comment: [{ add: { body: documentJson(body) } }] } },
      });
      const payload = await send(request, `/issue/${encodeURIComponent(issueKey)}?fields=comment`);
      return { id: latestCommentId(payload) };
    },
    async transition(issueKey, target) {
      const id = "transitionId" in target ? target.transitionId : await transitionIdFor(request, issueKey, target);
      await send(request, `/issue/${encodeURIComponent(issueKey)}/transitions`, {
        method: "POST",
        body: { transition: { id } },
      });
    },
    async assign(issueKey, accountId) {
      await send(request, `/issue/${encodeURIComponent(issueKey)}/assignee`, {
        method: "PUT",
        body: { accountId },
      });
    },
    async updateFields(issueKey, fields) {
      await send(request, `/issue/${encodeURIComponent(issueKey)}`, {
        method: "PUT",
        body: { fields },
      });
    },
  };
}

async function searchPages(
  request: JiraRequest,
  query: { jql: string; fields: string[]; limit: number; startAt: number },
): Promise<SearchPage> {
  let skipped = 0;
  let pageToken: string | null = null;
  for (let walk = 0; walk < PAGE_WALKS; walk += 1) {
    const body: { [key: string]: Json } = {
      jql: query.jql,
      maxResults: query.limit,
      fields: query.fields,
    };
    if (pageToken) {
      body.nextPageToken = pageToken;
    }
    const payload = await send(request, "/search/jql", { method: "POST", body });
    const issues = issuesFrom(payload);
    const next = optionalString(payload, "nextPageToken");
    if (skipped + issues.length <= query.startAt) {
      skipped += issues.length;
      if (!next) {
        return { issues: [], total: 0, nextStartAt: null };
      }
      pageToken = next;
      continue;
    }
    const start = query.startAt - skipped;
    const slice = issues.slice(start, start + query.limit);
    return {
      issues: slice,
      total: slice.length,
      nextStartAt: next ? query.startAt + slice.length : null,
    };
  }
  return { issues: [], total: 0, nextStartAt: null };
}

async function transitionIdFor(request: JiraRequest, issueKey: string, target: TransitionTarget): Promise<string> {
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

async function send(request: JiraRequest, path: string, init?: { method?: string; body?: Json }): Promise<unknown> {
  const response = await request(path, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Jira ${response.status}`);
  }
  if (text === "") {
    return null;
  }
  return JSON.parse(text) as unknown;
}

function issuesFrom(payload: unknown): IssueView[] {
  if (!isRecord(payload) || !Array.isArray(payload.issues)) {
    return [];
  }
  return payload.issues.map((issue) => issueFrom(issue));
}

function issueFrom(payload: unknown): IssueView {
  if (!isRecord(payload) || typeof payload.key !== "string") {
    throw new Error("Jira issue has no key");
  }
  const fields = isRecord(payload.fields) ? (payload.fields as Record<string, Json>) : {};
  return { key: payload.key, fields };
}

function transitionsFrom(payload: unknown): TransitionChoice[] {
  if (!isRecord(payload) || !Array.isArray(payload.transitions)) {
    return [];
  }
  return payload.transitions.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") {
      throw new Error("Jira transition is incomplete");
    }
    const to = isRecord(item.to) && typeof item.to.name === "string" ? item.to.name : "";
    return { id: item.id, name: item.name, to };
  });
}

function documentJson(body: CommentDocument): Json {
  return body;
}

function latestCommentId(payload: unknown): string {
  if (!isRecord(payload) || !isRecord(payload.fields) || !isRecord(payload.fields.comment)) {
    throw new Error("Jira comment was not stored");
  }
  const comments = payload.fields.comment.comments;
  if (!Array.isArray(comments) || comments.length === 0) {
    throw new Error("Jira comment was not stored");
  }
  const last = comments[comments.length - 1];
  return stringField(last, "id");
}

function stringField(payload: unknown, key: string): string {
  if (!isRecord(payload) || typeof payload[key] !== "string") {
    throw new Error("Jira response is incomplete");
  }
  return payload[key];
}

function optionalString(payload: unknown, key: string): string | null {
  if (!isRecord(payload) || typeof payload[key] !== "string" || payload[key] === "") {
    return null;
  }
  return payload[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
