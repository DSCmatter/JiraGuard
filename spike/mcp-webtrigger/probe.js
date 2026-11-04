const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const token = fs.readFileSync('.spike-token', 'utf8').trim();
const url = fs.readFileSync('.webtrigger-url', 'utf8').trim();
const launcher = path.join(__dirname, 'node_modules', '@modelcontextprotocol', 'inspector', 'clients', 'launcher', 'build', 'index.js');

function runInspector(method, extra) {
  const args = [
    '--yes',
    '@modelcontextprotocol/inspector',
    '--cli',
    '--transport',
    'http',
    '--server-url',
    url,
    '--header',
    `Authorization: Bearer ${token}`,
    '--method',
    method,
    '--format',
    'json',
    '--quiet',
    ...extra
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, ...args.slice(2)], {
      shell: false,
      windowsHide: true
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('close', (code) => {
      const redact = (text) => text.split(token).join('[token]');
      resolve({ method, code, out: redact(out).slice(0, 2500), err: redact(err).slice(0, 1500) });
    });
  });
}

async function call(label, body, auth) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  };
  if (auth) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { method: 'POST', headers, body });
  const text = await res.text();
  return { label, status: res.status, type: res.headers.get('content-type'), body: text.slice(0, 1500) };
}

async function main() {
  const inspector = [];
  inspector.push(await runInspector('initialize', []));
  inspector.push(await runInspector('tools/list', []));
  inspector.push(await runInspector('tools/call', ['--tool-name', 'guard_whoami', '--tool-args-json', '{}']));
  const noAuth = await call(
    'no-auth',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0' } }
    }),
    false
  );
  const jira = await call(
    'jira',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'guard_whoami', arguments: { probe: 'jira' } }
    }),
    true
  );
  console.log(JSON.stringify({ inspector, noAuth, jira }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
