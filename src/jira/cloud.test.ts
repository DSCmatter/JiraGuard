import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCloudJira, type JiraHttp, type JiraRequest } from "./cloud.ts";

function http(status: number, body: string): JiraHttp {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
  };
}

describe("cloud jira", () => {
  it("sends the search jql and reads issue keys", async () => {
    const paths: string[] = [];
    const request: JiraRequest = async (path, init) => {
      paths.push(`${init?.method ?? "GET"} ${path}`);
      return http(200, JSON.stringify({ issues: [{ key: "SPIKE-1", fields: { summary: "notes" } }], isLast: true }));
    };
    const page = await createCloudJira(request).search({
      jql: 'project in ("SPIKE")',
      fields: ["summary"],
      limit: 10,
      startAt: 0,
    });
    assert.deepEqual(paths, ['POST /search/jql']);
    assert.deepEqual(page.issues.map((issue) => issue.key), ["SPIKE-1"]);
    assert.equal(page.total, null);
  });

  it("reaches startAt 200 and keeps Jira's total", async () => {
    let calls = 0;
    const request: JiraRequest = async (_path, init) => {
      calls += 1;
      const max = typeof init?.body === "object" && init.body && !Array.isArray(init.body) && typeof init.body.maxResults === "number"
        ? init.body.maxResults
        : 0;
      const issues = Array.from({ length: max }, (_item, index) => ({ key: `SPIKE-${calls}-${index}`, fields: {} }));
      return http(200, JSON.stringify({ issues, nextPageToken: "next", total: 5000 }));
    };
    const page = await createCloudJira(request).search({
      jql: "order by created",
      fields: ["summary"],
      limit: 10,
      startAt: 200,
    });
    assert.equal(page.issues.length, 10);
    assert.equal(page.total, 5000);
    assert.ok(calls < 21);
  });

  it("hides the Jira body when the status is not ok", async () => {
    const request: JiraRequest = async () => http(400, "project SECRET does not exist");
    await assert.rejects(
      () => createCloudJira(request).getIssue("SPIKE-1", ["summary"]),
      (error: unknown) => error instanceof Error && error.message === "Jira 400" && !error.message.includes("SECRET"),
    );
  });
});
