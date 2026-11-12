import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Json } from "../domain/records.ts";
import { nextCall } from "../policy/decide.ts";
import { createMemoryStore, type RecordStore } from "../storage/memory.ts";
import { handleMcp, seedProofAgent, type CommentDocument, type JiraWork, type ProofSeed, type WebtriggerRequest } from "./handle.ts";

const OPAQUE =
  "Denied: that issue is not available to this agent. Use jira_search_issues to find issues you can access.";

const CATALOG = [
  "guard_whoami",
  "jira_search_issues",
  "jira_get_issue",
  "jira_list_transitions",
  "jira_add_comment",
  "jira_transition_issue",
  "jira_assign_issue",
  "jira_update_fields",
];

function call(token: string | null, id: number, name: string, args: Record<string, unknown>): WebtriggerRequest {
  return {
    method: "POST",
    headers: token === null ? {} : { authorization: [`Bearer ${token}`] },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  };
}

function port(overrides: Partial<JiraWork> = {}): JiraWork {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected Jira call");
  };
  return {
    search: overrides.search ?? unexpected,
    getIssue: overrides.getIssue ?? unexpected,
    listTransitions: overrides.listTransitions ?? unexpected,
    addComment: overrides.addComment ?? unexpected,
    transition: overrides.transition ?? unexpected,
    assign: overrides.assign ?? unexpected,
    updateFields: overrides.updateFields ?? unexpected,
  };
}

async function seed(store: RecordStore, overrides: Partial<ProofSeed> = {}) {
  return seedProofAgent(store, {
    name: "alpha-reader",
    description: "project A only",
    createdBy: "proof",
    allowedTools: [...CATALOG, "jira_create_issue"],
    allowedProjects: ["ALPHA"],
    writeMode: "allow",
    fieldAllowList: ["labels"],
    rateLimit: { reads: 120, writes: 20, windowSeconds: 3600 },
    maxResults: 25,
    ...overrides,
  });
}

function parsed(response: { body: string }): Record<string, unknown> {
  const value: unknown = JSON.parse(response.body);
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function structured(response: { body: string }): Record<string, unknown> {
  const body = parsed(response);
  const result = body.result;
  assert.equal(typeof result, "object");
  assert.notEqual(result, null);
  const content = (result as Record<string, unknown>).structuredContent;
  assert.equal(typeof content, "object");
  assert.notEqual(content, null);
  return content as Record<string, unknown>;
}

describe("handleMcp", () => {
  it("scopes search to ALPHA and drops a BETA issue the port returns", async () => {
    const store = createMemoryStore();
    const { token } = await seed(store);
    const sent: string[] = [];
    const jira = port({
      async search(query) {
        sent.push(query.jql);
        return {
          issues: [
            { key: "ALPHA-1", fields: { summary: "in A" } },
            { key: "BETA-9", fields: { summary: "leak" } },
          ],
          total: 2,
          nextStartAt: 2,
        };
      },
    });

    const response = await handleMcp(
      call(token, 1, "jira_search_issues", { jql: 'text ~ "blocker" OR project = BETA' }),
      { store, jira },
    );

    assert.equal(response.statusCode, 200);
    assert.equal(sent[0], '(text ~ "blocker" OR project = BETA) AND (project in ("ALPHA"))');
    const data = structured(response).data as { issues: Array<{ key: string }>; total: number; nextStartAt: number | null };
    assert.deepEqual(
      data.issues.map((issue) => issue.key),
      ["ALPHA-1"],
    );
    assert.equal(data.total, null);
    assert.equal(data.nextStartAt, 2);
    assert.equal(response.body.includes("BETA"), false);
  });

  it("denies an update field outside the allow-list", async () => {
    const store = createMemoryStore();
    const { token } = await seed(store, { writeMode: "approve" });
    let called = false;
    const jira = port({
      async updateFields() {
        called = true;
      },
    });

    const response = await handleMcp(
      call(token, 9, "jira_update_fields", { issueKey: "ALPHA-1", fields: { security: "internal" } }),
      { store, jira },
    );
    const content = structured(response);

    assert.equal(content.status, "denied");
    assert.equal(content.message, "Denied: field 'security' is not editable by this agent. Editable fields: labels.");
    assert.equal(called, false);
  });

  it("denies a BETA issue read without calling Jira", async () => {
    const store = createMemoryStore();
    const { token } = await seed(store);
    let getCalled = false;
    const jira = port({
      async getIssue() {
        getCalled = true;
        return { key: "BETA-4", fields: {} };
      },
    });

    const response = await handleMcp(call(token, 2, "jira_get_issue", { issueKey: "BETA-4" }), { store, jira });
    const body = parsed(response);
    const result = body.result as { isError?: boolean };
    const content = structured(response);

    assert.equal(response.statusCode, 200);
    assert.equal(result.isError, true);
    assert.equal(content.status, "denied");
    assert.equal(content.message, OPAQUE);
    assert.equal(String(content.message).includes("BETA"), false);
    assert.equal(response.body.includes("BETA"), false);
    assert.equal(getCalled, false);
    const audits = await store.listAudits();
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.outcome, "denied");
    assert.equal(audits[0]?.issueKey, "BETA-4");
  });

  it("keeps a malformed forbidden key on the project denial", async () => {
    const store = createMemoryStore();
    const { token } = await seed(store);
    let getCalled = false;
    const jira = port({
      async getIssue() {
        getCalled = true;
        return { key: "BETA-4", fields: {} };
      },
    });

    const response = await handleMcp(call(token, 3, "jira_get_issue", { issueKey: "BETA-nope" }), { store, jira });
    const content = structured(response);

    assert.equal(response.statusCode, 200);
    assert.equal(content.status, "denied");
    assert.equal(content.message, OPAQUE);
    assert.equal(response.body.includes("BETA"), false);
    assert.equal(getCalled, false);
  });

  it("lists catalog tools with annotations and omits jira_create_issue", async () => {
    const store = createMemoryStore();
    const { token } = await seed(store);
    const jira = port();
    const response = await handleMcp(
      {
        method: "POST",
        headers: { authorization: [`Bearer ${token}`] },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      },
      { store, jira },
    );

    assert.equal(response.statusCode, 200);
    const result = parsed(response).result as { tools: Array<{ name: string; annotations: Record<string, boolean> }> };
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      CATALOG,
    );
    assert.equal(result.tools.some((tool) => tool.name === "jira_create_issue"), false);
    const annotations: Record<string, [boolean, boolean, boolean, boolean]> = {
      guard_whoami: [true, false, true, false],
      jira_search_issues: [true, false, true, true],
      jira_get_issue: [true, false, true, true],
      jira_list_transitions: [true, false, true, true],
      jira_add_comment: [false, false, false, true],
      jira_transition_issue: [false, false, false, true],
      jira_assign_issue: [false, false, true, true],
      jira_update_fields: [false, false, true, true],
    };
    for (const tool of result.tools) {
      const expected = annotations[tool.name];
      assert.deepEqual(
        [tool.annotations.readOnlyHint, tool.annotations.destructiveHint, tool.annotations.idempotentHint, tool.annotations.openWorldHint],
        expected,
        tool.name,
      );
    }
  });

  it("reports the agent, catalog tools, and rate-limit ceilings", async () => {
    const store = createMemoryStore();
    const { token } = await seed(store, { name: "alpha-reader" });
    const response = await handleMcp(call(token, 8, "guard_whoami", {}), { store, jira: port() });
    const content = structured(response);
    const data = content.data as {
      agent?: string;
      allowedTools?: string[];
      allowedProjects?: string[];
      writeMode?: string;
      rateLimit?: { reads: number; writes: number; windowSeconds: number };
    };

    assert.equal(response.statusCode, 200);
    assert.equal(content.status, "ok");
    assert.equal(data.agent, "alpha-reader");
    assert.deepEqual(data.allowedTools, CATALOG);
    assert.deepEqual(data.allowedProjects, ["ALPHA"]);
    assert.equal(data.writeMode, "allow");
    assert.deepEqual(data.rateLimit, { reads: 120, writes: 20, windowSeconds: 3600 });
    assert.equal(response.body.includes("fieldAllowList"), false);
    assert.equal(response.body.includes("labels"), false);
  });

  it("holds an approve comment and does not call Jira", async () => {
    const store = createMemoryStore();
    const { token } = await seed(store, {
      name: "alpha-writer",
      allowedTools: ["jira_add_comment"],
      writeMode: "approve",
    });
    let commented = false;
    const jira = port({
      async addComment() {
        commented = true;
        return { id: "10001" };
      },
    });

    const response = await handleMcp(
      call(token, 5, "jira_add_comment", { issueKey: "ALPHA-1", body: "shipped" }),
      { store, jira },
    );
    const body = parsed(response);
    const result = body.result as { isError?: boolean };
    const content = structured(response);
    const data = content.data as { diff?: Array<{ field: string; before: Json; after: Json }> };

    assert.equal(response.statusCode, 200);
    assert.equal(result.isError, false);
    assert.equal(content.status, "pending_approval");
    assert.deepEqual(data.diff, [{ field: "body", before: null, after: "shipped" }]);
    assert.equal(response.body.includes("actionId"), false);
    assert.equal(commented, false);
    assert.deepEqual(await store.listPending(), []);
  });

  it("sends the agent name on an allowed comment", async () => {
    const store = createMemoryStore();
    const { token } = await seed(store, { name: "proof", allowedTools: ["jira_add_comment"] });
    const comments: CommentDocument[] = [];
    const jira = port({
      async addComment(_issueKey, body) {
        comments.push(body);
        return { id: "10002" };
      },
    });

    const response = await handleMcp(
      call(token, 6, "jira_add_comment", { issueKey: "ALPHA-3", body: "ship the notes" }),
      { store, jira },
    );
    const content = structured(response);

    assert.equal(response.statusCode, 200);
    assert.equal(content.status, "ok");
    assert.equal(comments.length, 1);
    assert.equal(comments[0]?.content[0]?.content[0]?.text, "via agent proof: ship the notes");
  });

  it("returns the auth sentence for a missing bearer", async () => {
    const store = createMemoryStore();
    const decision = await nextCall(store, "", { tool: "jira_get_issue" });
    assert.equal(decision.kind, "deny");
    if (decision.kind !== "deny") {
      return;
    }
    const response = await handleMcp(call(null, 7, "jira_get_issue", { issueKey: "ALPHA-1" }), {
      store,
      jira: port(),
    });
    const body = parsed(response);
    const error = body.error as { message?: string };

    assert.equal(response.statusCode, 401);
    assert.equal(error.message, decision.agentMessage);
    const audits = await store.listAudits({ outcome: "auth_failed" });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.agentId, "unknown");
  });

  it("rejects a tools call whose jsonrpc version is not 2.0", async () => {
    const store = createMemoryStore();
    const { token } = await seed(store);
    let called = false;
    const jira = port({
      async addComment() {
        called = true;
        return { id: "1" };
      },
    });
    const response = await handleMcp(
      {
        method: "POST",
        headers: { authorization: [`Bearer ${token}`] },
        body: JSON.stringify({
          id: 11,
          method: "tools/call",
          params: { name: "jira_add_comment", arguments: { issueKey: "ALPHA-1", body: "no" } },
        }),
      },
      { store, jira },
    );
    const body = parsed(response);
    const error = body.error as { code?: number };

    assert.equal(error.code, -32600);
    assert.equal(called, false);
  });

  it("answers initialize with the protocol version this server implements", async () => {
    const store = createMemoryStore();
    const { token } = await seed(store);
    const response = await handleMcp(
      {
        method: "POST",
        headers: { authorization: [`Bearer ${token}`] },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 12,
          method: "initialize",
          params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "old", version: "0" } },
        }),
      },
      { store, jira: port() },
    );
    const body = parsed(response);
    const result = body.result as { protocolVersion?: string };

    assert.equal(response.statusCode, 200);
    assert.equal(result.protocolVersion, "2025-11-25");
  });

  it("records an allowed read, a denial, and an auth failure", async () => {
    const store = createMemoryStore();
    const { token, agentId } = await seed(store);
    const jira = port({
      async getIssue() {
        return { key: "ALPHA-1", fields: { summary: "notes" } };
      },
    });
    await handleMcp(call(token, 20, "jira_get_issue", { issueKey: "ALPHA-1" }), { store, jira });
    await handleMcp(call(token, 21, "jira_get_issue", { issueKey: "BETA-4" }), { store, jira });
    await handleMcp(call(null, 22, "jira_get_issue", { issueKey: "ALPHA-1" }), { store, jira });

    const mine = await store.listAudits({ agentId });
    assert.deepEqual(
      mine.map((event) => event.outcome),
      ["allowed", "denied"],
    );
    const failed = await store.listAudits({ outcome: "auth_failed" });
    assert.equal(failed.length, 1);
    const allowed = await store.listAudits({ agentId, outcome: "allowed", from: mine[0]?.ts, to: mine[0]?.ts });
    assert.equal(allowed.length, 1);
    assert.equal(allowed[0]?.tool, "jira_get_issue");
  });

  it("does not read Jira when the audit cannot be stored", async () => {
    const store = createMemoryStore();
    const { token } = await seed(store);
    store.appendAudit = async () => {
      throw new Error("full");
    };
    let called = false;
    const jira = port({
      async getIssue() {
        called = true;
        return { key: "ALPHA-1", fields: {} };
      },
    });
    const response = await handleMcp(call(token, 23, "jira_get_issue", { issueKey: "ALPHA-1" }), { store, jira });
    assert.equal(structured(response).status, "error");
    assert.equal(called, false);
  });

  it("returns a JSON-RPC parse error and records one audit", async () => {
    const store = createMemoryStore();
    const response = await handleMcp(
      { method: "POST", headers: {}, body: "{" },
      { store, jira: port() },
    );
    const body = parsed(response);
    const error = body.error as { code?: number };
    const audits = await store.listAudits();

    assert.equal(response.statusCode, 400);
    assert.equal(error.code, -32700);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.outcome, "denied");
    assert.equal(audits[0]?.reason, "parse");
  });
});
