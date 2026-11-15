// Builds the Custom UI bundle that Forge serves from static/admin-ui.
// Run through `npm run build` in product/, or `npm run deploy` to build and deploy.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, "static", "admin-ui");

mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, "src", "frontend", "main.jsx")],
  outdir,
  entryNames: "guard",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});

// The frame must load guard.css and guard.js by relative path. A cached 404 of the old names would leave the page on Jira's grey bars.
writeFileSync(
  path.join(outdir, "index.html"),
  [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "    <title>JiraGuard</title>",
    '    <link rel="stylesheet" href="./guard.css" />',
    "  </head>",
    "  <body>",
    '    <div id="root"></div>',
    '    <script src="./guard.js"></script>',
    "  </body>",
    "</html>",
    "",
  ].join("\n"),
);
