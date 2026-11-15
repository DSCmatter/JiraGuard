import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { build, type Plugin } from "esbuild";

const require = createRequire(import.meta.url);
const modules = path.resolve("product/node_modules");

const forgeStub: Plugin = {
  name: "forge-stub",
  setup(build) {
    build.onResolve({ filter: /^@forge\/(react|bridge)$/ }, (args) => ({
      path: args.path,
      namespace: "forge-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "forge-stub" }, (args) => ({
      loader: "js",
      resolveDir: modules,
      contents:
        args.path === "@forge/bridge"
          ? "export function invoke() { return Promise.resolve(null); }"
          : `
              import React from "react";
              import { renderToStaticMarkup } from "react-dom/server";
              const pass = (props) => React.createElement("div", null, props && props.children);
              export const Button = pass;
              export const Checkbox = pass;
              export const DatePicker = pass;
              export const DynamicTable = pass;
              export const Heading = pass;
              export const Inline = pass;
              export const Label = pass;
              export const SectionMessage = pass;
              export const SectionMessageAction = pass;
              export const Select = pass;
              export const Stack = pass;
              export const Tab = pass;
              export const TabList = pass;
              export const TabPanel = pass;
              export const Tabs = pass;
              export const Text = pass;
              export const Textfield = pass;
              export default { render(node) { globalThis.__adminHtml = renderToStaticMarkup(node); } };
            `,
    }));
  },
};

describe("admin page", () => {
  it("renders the heading without a missing desk binding", async () => {
    const outfile = path.join(mkdtempSync(path.join(tmpdir(), "admin-page-")), "page.cjs");
    await build({
      entryPoints: [path.resolve("product/src/frontend/admin.jsx")],
      bundle: true,
      format: "cjs",
      platform: "node",
      outfile,
      jsx: "automatic",
      nodePaths: [modules],
      plugins: [forgeStub],
    });
    require(outfile);
    assert.match(globalThis.__adminHtml, /JiraGuard/);
  });
});
