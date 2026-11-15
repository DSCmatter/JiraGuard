import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { build, type Plugin } from "esbuild";

const require = createRequire(import.meta.url);
const modules = path.resolve("product/node_modules");
const frontend = path.resolve("product/src/frontend");

// The page talks to Jira only through the bridge, so the stub is the whole contract.
const bridgeStub: Plugin = {
  name: "bridge-stub",
  setup(build) {
    build.onResolve({ filter: /^@forge\/bridge$/ }, (args) => ({ path: args.path, namespace: "bridge-stub" }));
    build.onLoad({ filter: /.*/, namespace: "bridge-stub" }, (args) => ({
      loader: "js",
      resolveDir: modules,
      contents: "export function invoke() { return Promise.resolve(null); }",
    }));
  },
};

describe("admin page", () => {
  it("renders the heading from the real React tree", async () => {
    const outfile = path.join(mkdtempSync(path.join(tmpdir(), "admin-page-")), "page.cjs");
    await build({
      stdin: {
        contents: [
          `import React from "react";`,
          `import { renderToStaticMarkup } from "react-dom/server";`,
          `import App from "./App.jsx";`,
          `globalThis.__adminHtml = renderToStaticMarkup(React.createElement(App));`,
        ].join("\n"),
        resolveDir: frontend,
        loader: "jsx",
        sourcefile: "page-entry.jsx",
      },
      bundle: true,
      format: "cjs",
      platform: "node",
      outfile,
      jsx: "automatic",
      nodePaths: [modules],
      plugins: [bridgeStub],
    });
    require(outfile);
    assert.match(globalThis.__adminHtml, /JiraGuard/);
    assert.match(globalThis.__adminHtml, /Loading JiraGuard\./);
    assert.match(globalThis.__adminHtml, /Retry/);
  });
});
