const crypto = require('crypto');
const { kvs } = require('@forge/kvs');
const { asApp, route } = require('@forge/api');

const TOKEN_HASH = 'ababb95c52af84419a6cf4c9f76ca3fab0a23e19b52239e946cd8966588bbc08';

const JSON_HEADERS = {
  'Content-Type': ['application/json'],
  'Access-Control-Allow-Origin': ['*'],
  'Access-Control-Allow-Headers': ['authorization, content-type, accept, mcp-protocol-version, mcp-session-id'],
  'Access-Control-Allow-Methods': ['POST, OPTIONS']
};

function respond(statusCode, payload) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: payload === undefined ? '' : JSON.stringify(payload)
  };
}

function headerValue(request, name) {
  const headers = request.headers || {};
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  if (!key) {
    return '';
  }
  const value = headers[key];
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function tokenOk(request) {
  const raw = headerValue(request, 'authorization');
  const match = /^Bearer\s+(\S+)/i.exec(raw);
  if (!match) {
    return false;
  }
  const hash = crypto.createHash('sha256').update(match[1]).digest('hex');
  if (hash.length !== TOKEN_HASH.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(TOKEN_HASH));
}

async function storageFacts(probe) {
  const small = { id: 'evt_spike', outcome: 'allowed', ts: Date.now() };
  await kvs.set('spike:event', small);
  const got = await kvs.get('spike:event');
  const listed = await kvs.query().limit(5).getMany();
  const facts = {
    roundtrip: Boolean(got && got.id === 'evt_spike'),
    queryCount: listed && listed.results ? listed.results.length : 0
  };
  try {
    await kvs.entity('spike-event').set('evt_spike', { agentId: 'spike', ts: 1 });
    const rows = await kvs
      .entity('spike-event')
      .query()
      .index('by-agent-ts', { partition: ['spike'] })
      .limit(5)
      .getMany();
    facts.entityRows = rows && rows.results ? rows.results.length : 0;
  } catch (error) {
    facts.entityError = error instanceof Error ? error.message : String(error);
  }
  if (probe === 'storage-limit') {
    const blob = 'x'.repeat(250 * 1024);
    try {
      await kvs.set('spike:big', { blob });
      facts.oversize = { ok: true, bytes: blob.length };
    } catch (error) {
      facts.oversize = {
        ok: false,
        bytes: blob.length,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return facts;
}

function sdkFact() {
  try {
    const mcp = require('@modelcontextprotocol/server');
    return { loaded: true, keys: Object.keys(mcp).slice(0, 12) };
  } catch (error) {
    return { loaded: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function jiraFact() {
  try {
    const projects = await asApp().requestJira(route`/rest/api/3/project/search?maxResults=1`);
    const projectsText = await projects.text();
    if (!projects.ok) {
      return { ok: false, status: projects.status, body: projectsText.slice(0, 500) };
    }
    const projectsJson = JSON.parse(projectsText);
    const project = (projectsJson.values || [])[0];
    let projectKey = project && project.key;
    if (!projectKey) {
      const made = await asApp().requestJira(route`/rest/api/3/project`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'SPIKE',
          name: 'JiraGuard spike',
          projectTypeKey: 'software',
          projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-agility-kanban',
          leadAccountId: '712020:ee715c8e-61f8-4c38-b855-d0f46ceac863'
        })
      });
      const madeText = await made.text();
      if (!made.ok) {
        return { ok: false, status: made.status, body: madeText.slice(0, 800) };
      }
      projectKey = 'SPIKE';
    }
    const created = await asApp().requestJira(route`/rest/api/3/issue`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          summary: 'JiraGuard spike',
          issuetype: { name: 'Task' }
        }
      })
    });
    const createdText = await created.text();
    if (!created.ok) {
      return { ok: false, status: created.status, project: projectKey, body: createdText.slice(0, 500) };
    }
    const key = JSON.parse(createdText).key;
    const comment = await asApp().requestJira(route`/rest/api/3/issue/${key}/comment`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'JiraGuard spike via agent spike' }]
            }
          ]
        }
      })
    });
    const commentText = await comment.text();
    const commentJson = comment.ok ? JSON.parse(commentText) : null;
    return {
      ok: comment.ok,
      status: comment.status,
      issue: key,
      author: commentJson && commentJson.author ? commentJson.author.displayName : undefined,
      accountType: commentJson && commentJson.author ? commentJson.author.accountType : undefined,
      body: comment.ok ? undefined : commentText.slice(0, 500)
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const TOOL = {
  name: 'guard_whoami',
  description: 'Show this spike agent and the storage roundtrip.',
  inputSchema: {
    type: 'object',
    properties: {
      probe: { type: 'string', enum: ['jira', 'storage-limit'] }
    }
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
};

async function whoami(args) {
  const probe = args && args.probe;
  const data = {
    agent: 'spike',
    allowedTools: ['guard_whoami'],
    allowedProjects: [],
    writeMode: 'approve',
    rateLimit: { reads: 120, writes: 20, windowSeconds: 3600, enforced: false },
    sdk: sdkFact(),
    storage: await storageFacts(probe)
  };
  if (probe === 'jira') {
    data.jira = await jiraFact();
  }
  const envelope = {
    status: 'ok',
    data,
    guard: { flagged: false, reasons: [] },
    audit: { eventId: 'evt_spike' }
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope
  };
}

async function handleRpc(message) {
  const id = Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : null;
  if (message.method === 'notifications/initialized') {
    return { notification: true };
  }
  if (message.method === 'initialize') {
    const requested = message.params && message.params.protocolVersion;
    return {
      id,
      result: {
        protocolVersion: typeof requested === 'string' ? requested : '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'jiraguard-spike', version: '0.0.1' }
      }
    };
  }
  if (message.method === 'ping') {
    return { id, result: {} };
  }
  if (message.method === 'tools/list') {
    return { id, result: { tools: [TOOL] } };
  }
  if (message.method === 'tools/call') {
    const name = message.params && message.params.name;
    if (name !== 'guard_whoami') {
      return { id, error: { code: -32602, message: 'Unknown tool' } };
    }
    const result = await whoami((message.params && message.params.arguments) || {});
    return { id, result };
  }
  return { id, error: { code: -32601, message: 'Method not found' } };
}

exports.mcpHandler = async (request) => {
  if (request.method === 'OPTIONS') {
    return respond(204);
  }
  if (!tokenOk(request)) {
    let id = null;
    try {
      const parsed = JSON.parse(request.body || '{}');
      id = parsed.id ?? null;
    } catch (error) {
      id = null;
    }
    return respond(401, {
      jsonrpc: '2.0',
      id,
      error: { code: -32001, message: '401: missing, invalid or revoked agent token.' }
    });
  }
  let message;
  try {
    message = JSON.parse(request.body || '');
  } catch (error) {
    return respond(400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' }
    });
  }
  const outcome = await handleRpc(message);
  if (outcome.notification) {
    return respond(202);
  }
  const payload = { jsonrpc: '2.0', id: outcome.id ?? null };
  if (outcome.error) {
    payload.error = outcome.error;
  } else {
    payload.result = outcome.result;
  }
  return respond(200, payload);
};
