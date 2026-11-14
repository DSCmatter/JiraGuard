import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveToken } from "../auth/token.ts";
import { DEFAULT_POLICY_LIMITS } from "../domain/records.ts";
import type { JiraWork } from "../gate/handle.ts";
import { createMemoryStore, type AuditQuery, type RecordStore } from "../storage/memory.ts";
import { handleAdmin, parseAccountId, type AdminDeps } from "./desk.ts";

const ENDPOINT = "https://example.test/mcp";

function idleJira(): JiraWork {
  const fail = async (): Promise<never> => {
    throw new Error("jira");
  };
  return {
    search: fail,
    getIssue: fail,
    listTransitions: fail,
    addComment: fail,
    transition: fail,
    assign: fail,
    updateFields: fail,
  };
}

function depsFor(store: RecordStore, actor: AdminDeps["actor"] = parseAccountId("acct-admin")): AdminDeps {
  return { store, jira: idleJira(), endpointUrl: ENDPOINT, actor };
}

function watchAudits(store: RecordStore): { store: RecordStore; queries: Array<AuditQuery | undefined> } {
  const queries: Array<AuditQuery | undefined> = [];
  return {
    queries,
    store: {
      ...store,
      async listAudits(query) {
        queries.push(query);
        return store.listAudits(query);
      },
    },
  };
}

const createCommand = {
  type: "createAgent" as const,
  name: "Inspector",
  description: "",
  allowedProjects: ["PROJ"],
  allowedTools: ["guard_whoami"],
  writeMode: "approve" as const,
};

describe("admin desk", () => {
  it("returns the token only on create, and the card has no token hash", async () => {
    const store = createMemoryStore();
    const deps = depsFor(store);
    const created = await handleAdmin(deps, createCommand);
    assert.equal(created.type, "created");
    if (created.type !== "created") {
      return;
    }
    assert.equal(created.token.length > 0, true);
    assert.equal(JSON.stringify(created.desk).includes(created.token), false);
    assert.equal(created.desk.endpointUrl, ENDPOINT);
    assert.equal(created.desk.agents[0]?.name, "Inspector");
    const card = created.desk.agents[0];
    assert.ok(card);
    assert.equal("token" in card, false);
    assert.equal("token_hash" in card, false);
    assert.equal("policy_id" in card, false);
    assert.equal("last_used_at" in card, false);
    assert.equal(card.policy.kind, "set");

    const opened = await handleAdmin(deps, { type: "open" });
    assert.equal(opened.type, "desk");
    if (opened.type !== "desk") {
      return;
    }
    assert.equal(JSON.stringify(opened).includes(created.token), false);
    assert.equal("token" in opened, false);
  });

  it("keeps hidden policy fields on save and skips an unchanged save", async () => {
    const store = createMemoryStore();
    const deps = depsFor(store);
    const created = await handleAdmin(deps, createCommand);
    assert.equal(created.type, "created");
    if (created.type !== "created") {
      return;
    }
    const agentId = created.desk.agents[0]?.id;
    assert.ok(agentId);
    const before = await store.listPolicies();
    const same = await handleAdmin(deps, {
      type: "savePolicy",
      agentId,
      allowedProjects: ["PROJ"],
      allowedTools: ["guard_whoami"],
      writeMode: "approve",
    });
    assert.equal(same.type, "desk");
    assert.equal((await store.listPolicies()).length, before.length);

    const saved = await handleAdmin(deps, {
      type: "savePolicy",
      agentId,
      allowedProjects: ["DOCS", "PROJ"],
      allowedTools: ["jira_get_issue", "guard_whoami"],
      writeMode: "allow",
    });
    assert.equal(saved.type, "desk");
    if (saved.type !== "desk") {
      return;
    }
    const storedAgent = await store.getAgent(agentId);
    assert.ok(storedAgent);
    const policy = await store.getPolicy(storedAgent.policy_id);
    assert.ok(policy);
    assert.deepEqual(policy.fieldAllowList, [...DEFAULT_POLICY_LIMITS.fieldAllowList]);
    assert.deepEqual(policy.rateLimit, { ...DEFAULT_POLICY_LIMITS.rateLimit });
    assert.equal(policy.maxResults, DEFAULT_POLICY_LIMITS.maxResults);
    assert.equal(policy.injectionMode, DEFAULT_POLICY_LIMITS.injectionMode);
    assert.deepEqual(policy.allowedProjects, ["DOCS", "PROJ"]);
    assert.deepEqual(policy.allowedTools, ["guard_whoami", "jira_get_issue"]);
    assert.equal(policy.writeMode, "allow");
    assert.equal(saved.desk.agents[0]?.policy.kind, "set");
    if (saved.desk.agents[0]?.policy.kind === "set") {
      assert.deepEqual(saved.desk.agents[0].policy.allowedProjects, ["DOCS", "PROJ"]);
    }
    assert.equal((await store.listPolicies()).length, before.length + 1);
  });

  it("writes nothing when guard_whoami is missing", async () => {
    const store = createMemoryStore();
    const result = await handleAdmin(depsFor(store), {
      ...createCommand,
      allowedTools: ["jira_get_issue"],
    });
    assert.equal(result.type, "rejected");
    assert.equal((await store.listAgents()).length, 0);
    assert.equal((await store.listPolicies()).length, 0);
  });

  it("leaves a revoked agent revoked", async () => {
    const store = createMemoryStore();
    const deps = depsFor(store);
    const created = await handleAdmin(deps, createCommand);
    assert.equal(created.type, "created");
    if (created.type !== "created") {
      return;
    }
    const agentId = created.desk.agents[0]?.id;
    assert.ok(agentId);
    const revoked = await handleAdmin(deps, { type: "revoke", agentId });
    assert.equal(revoked.type, "desk");
    if (revoked.type !== "desk") {
      return;
    }
    assert.equal(revoked.desk.agents[0]?.status, "revoked");
    assert.equal(await resolveToken(store, created.token), null);

    const again = await handleAdmin(deps, { type: "revoke", agentId });
    assert.equal(again.type, "desk");
    if (again.type !== "desk") {
      return;
    }
    assert.equal(again.desk.agents[0]?.status, "revoked");
    assert.equal((await store.getAgent(agentId))?.status, "revoked");
  });

  it("passes an injection filter to listAudits and keeps last use unfiltered", async () => {
    const memory = createMemoryStore();
    const { store, queries } = watchAudits(memory);
    const deps = depsFor(store);
    const created = await handleAdmin(deps, createCommand);
    assert.equal(created.type, "created");
    if (created.type !== "created") {
      return;
    }
    const agentId = created.desk.agents[0]?.id;
    assert.ok(agentId);
    const flagged = await memory.appendAudit({
      ts: "2026-11-14T01:00:00.000Z",
      agentId,
      tool: "guard_whoami",
      issueKey: null,
      project: null,
      outcome: "allowed",
      reason: null,
      before: null,
      after: null,
      injectionFlagged: true,
      requestId: "req_flag",
    });
    await memory.appendAudit({
      ts: "2026-11-14T02:00:00.000Z",
      agentId,
      tool: "guard_whoami",
      issueKey: null,
      project: null,
      outcome: "allowed",
      reason: null,
      before: null,
      after: null,
      injectionFlagged: false,
      requestId: "req_plain",
    });
    queries.length = 0;

    const filtered = await handleAdmin(deps, {
      type: "filterAudit",
      filter: { agentId, injectionFlagged: true },
    });
    assert.equal(filtered.type, "desk");
    if (filtered.type !== "desk") {
      return;
    }
    assert.equal(queries.length, 1);
    assert.equal(queries[0], undefined);
    assert.deepEqual(
      filtered.desk.audit.events.map((event) => event.id),
      [flagged.id],
    );
    assert.equal(filtered.desk.audit.events[0]?.tool, "guard_whoami");
    assert.equal(filtered.desk.audit.empty, "rows");
    assert.equal(filtered.desk.agents[0]?.lastUsedAt, "2026-11-14T02:00:00.000Z");
    assert.equal((await memory.getAgent(agentId))?.last_used_at, null);
  });

  it("uses a setup hint for an empty log and a different hint when a filter matches nothing", async () => {
    const store = createMemoryStore();
    const deps = depsFor(store);
    const opened = await handleAdmin(deps, { type: "open" });
    assert.equal(opened.type, "desk");
    if (opened.type !== "desk") {
      return;
    }
    assert.equal(opened.desk.audit.empty, "setup");
    assert.deepEqual(opened.desk.audit.events, []);

    const filtered = await handleAdmin(deps, {
      type: "filterAudit",
      filter: { outcome: "denied" },
    });
    assert.equal(filtered.type, "desk");
    if (filtered.type !== "desk") {
      return;
    }
    assert.equal(filtered.desk.audit.empty, "no-match");
    assert.notEqual(opened.desk.audit.empty, filtered.desk.audit.empty);
  });

  it("expands a calendar day across that UTC day", async () => {
    const memory = createMemoryStore();
    const { store } = watchAudits(memory);
    const event = await memory.appendAudit({
      ts: "2026-11-14T12:00:00.000Z",
      agentId: "agt_day",
      tool: "guard_whoami",
      issueKey: null,
      project: null,
      outcome: "allowed",
      reason: null,
      before: null,
      after: null,
      injectionFlagged: false,
      requestId: "req_day",
    });
    await memory.appendAudit({
      ts: "2026-11-15T12:00:00.000Z",
      agentId: "agt_day",
      tool: "guard_whoami",
      issueKey: null,
      project: null,
      outcome: "allowed",
      reason: null,
      before: null,
      after: null,
      injectionFlagged: false,
      requestId: "req_next",
    });
    const filtered = await handleAdmin(depsFor(store), {
      type: "filterAudit",
      filter: { from: "2026-11-14", to: "2026-11-14" },
    });
    assert.equal(filtered.type, "desk");
    if (filtered.type !== "desk") {
      return;
    }
    assert.deepEqual(
      filtered.desk.audit.events.map((row) => row.id),
      [event.id],
    );
  });

  it("rejects a bad date before any audit query", async () => {
    const memory = createMemoryStore();
    const { store, queries } = watchAudits(memory);
    const deps = depsFor(store);
    const created = await handleAdmin(deps, createCommand);
    assert.equal(created.type, "created");
    if (created.type !== "created") {
      return;
    }
    const agentId = created.desk.agents[0]?.id;
    assert.ok(agentId);
    const event = await memory.appendAudit({
      ts: "2026-11-14T03:00:00.000Z",
      agentId,
      tool: "guard_whoami",
      issueKey: null,
      project: null,
      outcome: "allowed",
      reason: null,
      before: null,
      after: null,
      injectionFlagged: false,
      requestId: "req_keep",
    });
    queries.length = 0;

    const badDay = await handleAdmin(deps, {
      type: "filterAudit",
      filter: { from: "2026-02-31" },
    });
    const reversed = await handleAdmin(deps, {
      type: "filterAudit",
      filter: { from: "2026-11-14", to: "2026-11-01" },
    });
    assert.equal(badDay.type, "rejected");
    assert.equal(reversed.type, "rejected");
    assert.equal(queries.length, 0);
    if (badDay.type === "rejected") {
      assert.equal(badDay.desk, null);
    }
    assert.deepEqual(await memory.listAudits(), [event]);
  });

  it("rejects a forbidden field and a signed-out write without storing an agent", async () => {
    const store = createMemoryStore();
    const forbidden = await handleAdmin(depsFor(store), { ...createCommand, token: "secret" });
    assert.equal(forbidden.type, "rejected");
    assert.equal((await store.listAgents()).length, 0);

    const signedOut = await handleAdmin(depsFor(store, null), createCommand);
    assert.equal(signedOut.type, "rejected");
    assert.equal((await store.listAgents()).length, 0);

    const opened = await handleAdmin(depsFor(store, null), { type: "open" });
    assert.equal(opened.type, "desk");
  });

  it("reads an account id only from a non-empty string", () => {
    assert.equal(parseAccountId("acct-admin"), "acct-admin");
    assert.equal(parseAccountId("  "), null);
    assert.equal(parseAccountId(""), null);
    assert.equal(parseAccountId(undefined), null);
  });
});
