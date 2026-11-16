import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';

const secret = 'fixture-secret-do-not-print';
async function fixture(handler, run) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body, headers: req.headers });
    handler(req, res, body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
function probe(mode, origin, extra = {}) {
  return new Promise(resolve => {
    const env = { PATH: process.env.PATH, AIX_PROBE: '1', AIX_PROBE_BASE_URL: origin, ...extra };
    const child = spawn(process.execPath, ['scripts/probe-connection.mjs', mode], { env });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    child.on('close', code => resolve({ code, output }));
  });
}
const json = (res, body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };

test('network work requires explicit opt-in and credentials before the first request', async () => {
  await fixture(() => assert.fail('must not contact server'), async (origin, requests) => {
    for (const extra of [{ AIX_PROBE: '' }, {}]) {
      const result = await probe('api', origin, extra);
      assert.equal(result.code, 1);
      assert.match(result.output, /opt-in|AIX_API_KEY/);
    }
    assert.equal(requests.length, 0);
  });
});

test('public checks validate the advertised MCP endpoint and an unauthenticated challenge', async () => {
  await fixture((req, res) => {
    if (req.url === '/api/aix/mcp/server-card') return json(res, { remotes: [{ type: 'streamable-http', url: `http://${req.headers.host}/api/aix/mcp` }] });
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="https://aix.brambles.ai/.well-known/oauth-protected-resource"');
    res.end();
  }, async (origin, requests) => {
    const result = await probe('public', origin, { AIX_API_KEY: secret, AIX_MCP_TOKEN: secret });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(requests.map(r => [r.method, r.url]), [['GET', '/api/aix/mcp/server-card'], ['POST', '/api/aix/mcp']]);
    assert.ok(requests.every(r => !r.auth));
    assert.equal(requests[1].body.method, 'initialize');
  });
});

test('API checks read only activity and never print its response or credential', async () => {
  await fixture((_req, res) => json(res, { environment: 'test', principal_id: secret, earnings: { accrued_cents: 123 } }), async (origin, requests) => {
    const result = await probe('api', origin, { AIX_API_KEY: secret });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(requests.map(r => [r.method, r.url]), [['GET', '/api/aix/activity?days=1']]);
    assert.equal(requests[0].auth, `Bearer ${secret}`);
    assert.doesNotMatch(result.output, /fixture-secret|accrued_cents|123/);
  });
});

test('MCP negotiates, notifies and lists tools without calling any tool (including SSE)', async () => {
  for (const sse of [false, true]) await fixture((req, res, body) => {
    if (body.method === 'notifications/initialized') { res.statusCode = 202; return res.end(); }
    const result = body.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { tools: [{ name: 'submit_intent', inputSchema: { type: 'object' } }] };
    res.setHeader('Mcp-Session-Id', 'fixture-session');
    if (sse) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`);
    } else json(res, { jsonrpc: '2.0', id: body.id, result });
  }, async (origin, requests) => {
    const result = await probe('mcp', origin, { AIX_MCP_TOKEN: secret });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(requests.map(r => r.body.method), ['initialize', 'notifications/initialized', 'tools/list']);
    assert.ok(requests.every(r => r.url === '/api/aix/mcp' && r.method === 'POST' && r.auth === `Bearer ${secret}`));
    assert.equal(requests[2].headers['mcp-session-id'], 'fixture-session');
    assert.equal(requests[2].headers['mcp-protocol-version'], '2025-03-26');
    assert.doesNotMatch(result.output, /fixture-secret|submit_intent/);
  });
});

test('HTTP rejection, malformed JSON, invalid success shapes and JSON-RPC errors fail without reflecting response data', async () => {
  const cases = [
    ['api', (res) => { res.statusCode = 403; json(res, { error: secret }); }, /HTTP 403/],
    ['api', (res) => { res.end(secret); }, /invalid JSON/],
    ['api', (res) => json(res, {}), /activity response/],
    ['mcp', (res) => json(res, { jsonrpc: '2.0', id: 1, error: { code: -32603, message: secret } }), /JSON-RPC error/],
    ['mcp', (res) => json(res, { jsonrpc: '2.0', id: 999, result: {} }), /JSON-RPC response/],
    ['mcp', (res) => json(res, { jsonrpc: '2.0', id: 1, result: { protocolVersion: 'future', capabilities: {}, serverInfo: {} } }), /initialize response/],
  ];
  for (const [mode, handler, error] of cases) await fixture((_req, res) => handler(res), async origin => {
    const result = await probe(mode, origin, { AIX_API_KEY: secret, AIX_MCP_TOKEN: secret });
    assert.equal(result.code, 1);
    assert.match(result.output, error);
    assert.ok(!result.output.includes(secret));
  });
});

test('redirects never forward credentials or visit another path', async () => {
  await fixture((_req, res) => { res.statusCode = 302; res.setHeader('Location', '/handoffs/danger/redeem'); res.end(); }, async (origin, requests) => {
    const result = await probe('api', origin, { AIX_API_KEY: secret });
    assert.equal(result.code, 1);
    assert.equal(requests.length, 1);
    assert.match(result.output, /redirect/);
  });
});

test('untrusted base URLs, bad arguments and query credentials are rejected before networking', async () => {
  for (const origin of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?key=secret', 'https://example.com/path']) {
    const result = await probe('public', origin);
    assert.equal(result.code, 1);
    assert.match(result.output, /base URL/);
  }
  const result = await probe('redeem', 'http://127.0.0.1:1');
  assert.equal(result.code, 1);
  assert.match(result.output, /public\|api\|mcp/);
});

test('timeout and bounded response failures exit nonzero', async () => {
  for (const respond of [(_req, _res) => {}, (_req, res) => res.end('x'.repeat(1_050_000))]) {
    await fixture(respond, async origin => {
      const result = await probe('api', origin, { AIX_API_KEY: secret, AIX_PROBE_TIMEOUT_MS: '100' });
      assert.equal(result.code, 1);
      assert.match(result.output, /timeout|too large/);
    });
  }
});
