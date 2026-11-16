#!/usr/bin/env node
// Deliberately no tools/call, receiver/config, handoff URLs, key issuance, or writes.
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const protocols = ['2025-03-26', '2025-06-18', '2025-11-25'];

async function main() {
  if (process.env.AIX_PROBE !== '1') fail('opt-in required: set AIX_PROBE=1');
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['public', 'api', 'mcp'].includes(mode)) fail('usage: node scripts/probe-connection.mjs public|api|mcp');
  let base;
  try { base = new URL(process.env.AIX_PROBE_BASE_URL || 'https://aix.brambles.ai'); }
  catch { fail('invalid base URL'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) || base.username || base.password || base.search || base.hash || base.pathname !== '/') fail('base URL must be an HTTPS origin (HTTP loopback allowed for fixtures)');
  const timeout = Number(process.env.AIX_PROBE_TIMEOUT_MS || 10000);
  if (!Number.isInteger(timeout) || timeout < 50 || timeout > 60000) fail('AIX_PROBE_TIMEOUT_MS must be 50..60000');
  const token = mode === 'public' ? null : mode === 'api' ? process.env.AIX_API_KEY : process.env.AIX_MCP_TOKEN || process.env.AIX_API_KEY;
  if (mode !== 'public' && !token) fail(mode === 'api' ? 'AIX_API_KEY is required' : 'AIX_MCP_TOKEN or AIX_API_KEY is required');

  async function request(path, options = {}, rpcId) {
    const signal = AbortSignal.timeout(timeout);
    let response;
    try { response = await fetch(new URL(path, base), { ...options, redirect: 'manual', signal }); }
    catch { fail(signal.aborted ? 'request timeout' : 'network request failed'); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); fail('redirect refused'); }
    if (!response.ok) { await response.body?.cancel(); fail(`HTTP ${response.status}`); }
    if (response.status === 202 || response.status === 204) { await response.body?.cancel(); return { response, data: null }; }
    const reader = response.body?.getReader();
    if (!reader) fail('missing response body');
    const decoder = new TextDecoder();
    let text = '', bytes = 0;
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1_048_576) fail('response too large');
        text += decoder.decode(value, { stream: true });
        if (sse) {
          // Stop on the requested JSON-RPC result; do not wait for an SSE stream to close.
          let end;
          while ((end = /\r?\n\r?\n/.exec(text))) {
            const event = text.slice(0, end.index);
            text = text.slice(end.index + end[0].length);
            const payload = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!payload) continue;
            let data;
            try { data = JSON.parse(payload); } catch { fail('invalid JSON'); }
            if (data.id === rpcId) return { response, data };
          }
        }
      }
    } catch (error) {
      if (signal.aborted) fail('request timeout');
      // Only locally constructed errors have safe messages; never print response text.
      if (error.message === 'response too large' || error.message === 'invalid JSON') throw error;
      fail('response read failed');
    } finally { await reader.cancel().catch(() => {}); }
    if (sse) fail('invalid JSON-RPC response');
    try { return { response, data: JSON.parse(text) }; } catch { fail('invalid JSON'); }
  }
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: protocols[0], capabilities: {}, clientInfo: { name: 'aix-read-only-probe', version: '0.1.0' } } };
  const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  if (mode === 'public') {
    const { data } = await request('/api/aix/mcp/server-card');
    if (!Array.isArray(data?.remotes) || !data.remotes.some(remote => remote.type === 'streamable-http' && remote.url === new URL('/api/aix/mcp', base).href)) fail('invalid MCP server card');
    const signal = AbortSignal.timeout(timeout);
    let challenge;
    try { challenge = await fetch(new URL('/api/aix/mcp', base), { method: 'POST', headers, body: JSON.stringify(initialize), redirect: 'manual', signal }); }
    catch { fail(signal.aborted ? 'request timeout' : 'network request failed'); }
    await challenge.body?.cancel();
    if (challenge.status !== 401 || !/^Bearer\b/i.test(challenge.headers.get('www-authenticate') || '')) fail('expected HTTP 401 Bearer challenge');
    console.log('PASS public: MCP server card and unauthenticated Bearer challenge');
  } else if (mode === 'api') {
    const { data } = await request('/api/aix/activity?days=1', { headers });
    if (!object(data) || !['test', 'live'].includes(data.environment) || typeof data.principal_id !== 'string') fail('invalid activity response');
    console.log('PASS api: authenticated activity read (response withheld)');
  } else {
    const rpc = async body => {
      const result = await request('/api/aix/mcp', { method: 'POST', headers, body: JSON.stringify(body) }, body.id);
      if (body.id !== undefined) {
        if (!object(result.data) || result.data.jsonrpc !== '2.0' || result.data.id !== body.id) fail('invalid JSON-RPC response');
        if (result.data.error) fail('JSON-RPC error');
        if (!object(result.data.result)) fail('invalid JSON-RPC result');
      }
      return result;
    };
    const initialized = await rpc(initialize);
    const info = initialized.data.result;
    if (!protocols.includes(info.protocolVersion) || !object(info.capabilities) || !object(info.serverInfo) || typeof info.serverInfo.name !== 'string' || typeof info.serverInfo.version !== 'string') fail('invalid initialize response');
    headers['MCP-Protocol-Version'] = info.protocolVersion;
    const session = initialized.response.headers.get('mcp-session-id');
    if (session) headers['Mcp-Session-Id'] = session;
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    if (!Array.isArray(listed.data.result.tools) || !listed.data.result.tools.every(tool => typeof tool.name === 'string' && object(tool.inputSchema))) fail('invalid tools/list response');
    console.log('PASS mcp: initialized and listed tools; no tool was called');
  }
}
main().catch(error => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });
