import { asApp, asUser, route, webTrigger } from "@forge/api";
import { makeResolver, type Request } from "@forge/resolver";
import { ForgeKvsAPIError, kvs, WhereConditions } from "@forge/kvs";
import { handleAdmin, parseAccountId } from "../admin/desk.ts";
import { handleMcp, type WebtriggerRequest, type WebtriggerResponse } from "../gate/handle.ts";
import { createCloudJira, type JiraHttp } from "../jira/cloud.ts";
import { ensureProofAgent } from "./proof.ts";
import { createKvsStore } from "../storage/kvs.ts";

const store = createKvsStore({
  async get(key) {
    return kvs.get(key);
  },
  async set(key, value) {
    await kvs.set(key, value);
  },
  async create(key, value) {
    try {
      await kvs.set(key, value, { keyPolicy: "FAIL_IF_EXISTS" });
      return true;
    } catch (error) {
      if (error instanceof ForgeKvsAPIError && error.code === "KEY_CONFLICT") {
        return false;
      }
      throw error;
    }
  },
  async delete(key) {
    await kvs.delete(key);
  },
  async list(prefix) {
    const rows: Array<{ key: string; value: unknown }> = [];
    let cursor: string | undefined;
    do {
      let query = kvs.query().where("key", WhereConditions.beginsWith(prefix)).limit(100);
      if (cursor) {
        query = query.cursor(cursor);
      }
      const page = await query.getMany();
      for (const result of page.results) {
        rows.push({ key: result.key, value: result.value });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return rows;
  },
});

export async function mcpHandler(request: WebtriggerRequest): Promise<WebtriggerResponse> {
  const tokenHash = process.env.JIRAGUARD_PROOF_TOKEN_HASH ?? "";
  const project = process.env.JIRAGUARD_PROOF_PROJECT ?? "";
  const name = process.env.JIRAGUARD_PROOF_NAME || "proof";
  try {
    await ensureProofAgent(store, { tokenHash, project, name });
  } catch {
    return {
      statusCode: 500,
      headers: { "Content-Type": ["application/json"] },
      body: JSON.stringify({ error: "JiraGuard proof agent is not configured." }),
    };
  }
  return handleMcp(request, { store, jira: createCloudJira(requestJira) });
}

export const adminResolver = makeResolver({
  async run(request: Request) {
    if (!(await callerIsAdmin())) {
      return { type: "rejected", reason: "Jira admin permission is required.", desk: null };
    }
    return handleAdmin(
      {
        store,
        jira: createCloudJira(requestJira),
        endpointUrl: await endpointUrlOrBlank(),
        actor: parseAccountId(request.context?.accountId),
      },
      request.payload,
    );
  },
});

async function callerIsAdmin(): Promise<boolean> {
  try {
    const response = await asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as {
      permissions?: { ADMINISTER?: { havePermission?: boolean } };
    };
    return body.permissions?.ADMINISTER?.havePermission === true;
  } catch {
    return false;
  }
}

async function endpointUrlOrBlank(): Promise<string> {
  try {
    const url = await webTrigger.getUrl("mcp-endpoint");
    return typeof url === "string" ? url : "";
  } catch {
    return "";
  }
}

async function requestJira(path: string, init?: { method?: string; body?: unknown }): Promise<JiraHttp> {
  const method = init?.method ?? "GET";
  const options = {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  };
  if (path === "/search/jql") {
    return asApp().requestJira(route`/rest/api/3/search/jql`, options);
  }
  const comment = /^\/issue\/([^/]+)\/comment$/.exec(path);
  if (comment) {
    const issueKey = decodeURIComponent(comment[1]);
    return asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, options);
  }
  const transitions = /^\/issue\/([^/]+)\/transitions$/.exec(path);
  if (transitions) {
    const issueKey = decodeURIComponent(transitions[1]);
    return asApp().requestJira(route`/rest/api/3/issue/${issueKey}/transitions`, options);
  }
  const assignee = /^\/issue\/([^/]+)\/assignee$/.exec(path);
  if (assignee) {
    const issueKey = decodeURIComponent(assignee[1]);
    return asApp().requestJira(route`/rest/api/3/issue/${issueKey}/assignee`, options);
  }
  const withFields = /^\/issue\/([^/]+)\?fields=(.+)$/.exec(path);
  if (withFields) {
    const issueKey = decodeURIComponent(withFields[1]);
    const fields = decodeURIComponent(withFields[2]);
    return asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=${fields}`, options);
  }
  const issue = /^\/issue\/([^/]+)$/.exec(path);
  if (issue) {
    const issueKey = decodeURIComponent(issue[1]);
    return asApp().requestJira(route`/rest/api/3/issue/${issueKey}`, options);
  }
  throw new Error("unsupported jira path");
}
