#!/usr/bin/env node
import http from 'node:http';
import readline from 'node:readline';

const disabled = process.env.SHOPWARE_MCP_AVAILABLE !== 'true';
const endpoint = process.env.SHOPWARE_MCP_URL || 'http://host.docker.internal:18080/api/_mcp';
const accessKey = process.env.SHOPWARE_MCP_ACCESS_KEY || '';
const secretAccessKey = process.env.SHOPWARE_MCP_SECRET_ACCESS_KEY || '';
const protocolVersion = '2025-03-26';
const httpMode = process.argv.includes('--http');
const listenHost = process.env.SHOPWARE_MCP_BRIDGE_HOST || '127.0.0.1';
const listenPort = Number(process.env.SHOPWARE_MCP_BRIDGE_PORT || '18765');

let sessionId = null;
let remoteUnavailable = disabled || !accessKey || !secretAccessKey;

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, message, code = -32000) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function emptyList(method) {
  if (method === 'tools/list') {
    return { tools: [] };
  }
  if (method === 'resources/list') {
    return { resources: [] };
  }
  if (method === 'prompts/list') {
    return { prompts: [] };
  }

  return null;
}

function localInitialize(id) {
  return result(id, {
    protocolVersion,
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
    serverInfo: {
      name: 'shopware-mcp-bridge',
      version: '1.0.0',
    },
  });
}

async function forward(message) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'sw-access-key': accessKey,
    'sw-secret-access-key': secretAccessKey,
  };

  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });

  const nextSessionId = response.headers.get('mcp-session-id');
  if (nextSessionId) {
    sessionId = nextSessionId;
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Shopware MCP HTTP ${response.status}: ${body.slice(0, 500)}`);
  }

  if (!body.trim()) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    const data = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .join('\n');

    return data ? JSON.parse(data) : null;
  }

  return JSON.parse(body);
}

async function handle(message) {
  const method = message.method;
  const id = message.id;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    if (remoteUnavailable) {
      return localInitialize(id);
    }

    try {
      const response = await forward(message);
      if (response) {
        return response;
      } else {
        return localInitialize(id);
      }
    } catch (e) {
      remoteUnavailable = true;
      console.error(`[shopware-mcp-bridge] Shopware MCP unavailable during initialize: ${e.message}`);
      return localInitialize(id);
    }
  }

  if (isNotification) {
    if (!remoteUnavailable) {
      try {
        await forward(message);
      } catch (e) {
        console.error(`[shopware-mcp-bridge] Ignored failed notification ${method}: ${e.message}`);
      }
    }
    return null;
  }

  if (remoteUnavailable) {
    const empty = emptyList(method);
    if (empty) {
      return result(id, empty);
    }

    return error(id, 'Shopware MCP is not available for this reported version or the bridge has no credentials.', -32601);
  }

  try {
    const response = await forward(message);
    if (response) {
      return response;
    }

    return result(id, {});
  } catch (e) {
    if (emptyList(method)) {
      remoteUnavailable = true;
      console.error(`[shopware-mcp-bridge] Shopware MCP became unavailable for ${method}: ${e.message}`);
      return result(id, emptyList(method));
    }

    return error(id, e.message);
  }
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (e) {
    process.stdout.write(`${JSON.stringify(error(null, `Invalid JSON-RPC payload: ${e.message}`, -32700))}\n`);
    return;
  }

  const response = await handle(message);
  if (response) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

function startStdio() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  rl.on('line', (line) => {
    void handleLine(line);
  });
}

function startHttp() {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    if (request.method === 'DELETE') {
      void closeRemoteSession().finally(() => {
        response.writeHead(200);
        response.end();
      });
      return;
    }

    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      void (async () => {
        let message;
        try {
          message = JSON.parse(body);
        } catch (e) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify(error(null, `Invalid JSON-RPC payload: ${e.message}`, -32700)));
          return;
        }

        const payload = await handle(message);
        if (!payload) {
          response.writeHead(202);
          response.end();
          return;
        }

        response.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'shopware-mcp-bridge',
        });
        response.end(JSON.stringify(payload));
      })();
    });
  });

  server.listen(listenPort, listenHost, () => {
    console.error(`[shopware-mcp-bridge] listening on http://${listenHost}:${listenPort}/mcp`);
  });
}

async function closeRemoteSession() {
  if (remoteUnavailable || !sessionId) {
    return;
  }

  try {
    await fetch(endpoint, {
      method: 'DELETE',
      headers: {
        'sw-access-key': accessKey,
        'sw-secret-access-key': secretAccessKey,
        'mcp-session-id': sessionId,
      },
    });
  } catch {
    // Best-effort cleanup only.
  }
}

process.on('SIGTERM', async () => {
  await closeRemoteSession();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await closeRemoteSession();
  process.exit(0);
});

if (httpMode) {
  startHttp();
} else {
  startStdio();
}
