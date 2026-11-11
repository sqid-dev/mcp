// Offline: a fake Sqid API, a verify stub that accepts "good" and rejects the rest,
// and a real MCP client over Streamable HTTP.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let upstream, seen = [], app, server, base;

before(async () => {
  upstream = http.createServer(async (req, res) => {
    let b = ''; for await (let c of req){ b += c; }
    let u = new URL(req.url, 'http://x'); seen.push({ method : req.method, path : u.pathname, query : Object.fromEntries(u.searchParams), body : b ? JSON.parse(b) : null, auth : req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    let P = u.pathname;
    if(P === '/api/sqid/me'){ return res.end(JSON.stringify({ email : 'dev@acme.com', role : 'owner', account : { hasSubscription : true } })); }
    if(P === '/api/sqid/projects'){ return res.end(JSON.stringify([{ _id : 'sdk1', name : 'Acme', state : { deployed : true, connected : true } }])); }
    if(P === '/api/sqid/sdks/sdk1/webhooks'){ return res.end(JSON.stringify([{ id : 'wh1', name : 'x', namespace : 'visitor.identification.created.v2', url : 'https://a.test/h', enabled : true, health : { status : 'healthy' } }])); }
    if(P === '/api/v2/projects/sdk1/webhook' && req.method === 'POST'){ return res.end(JSON.stringify({ _id : 'wh2' })); }
    if(P === '/api/v2/projects/sdk1/webhook/preview'){ return res.end(JSON.stringify({ id : 'evt', data : { visitor : { id : 'v1' } } })); }
    if(P === '/api/sqid/identities'){ return res.end(JSON.stringify({ identities : [{ _id : 'p1', sdk_id : 'sdk1', user : { email : 'j@n.test' } }], next : null })); }
    res.statusCode = 404; res.end(JSON.stringify({ error : 'nf' }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  process.env.SQID_API = `http://127.0.0.1:${upstream.address().port}`;
  // A publishable key encodes the Clerk frontend API host; the metadata handlers derive the issuer from it.
  process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_' + Buffer.from('clerk.example.test$').toString('base64');
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  const { createApp } = await import('../src/app.js');
  const { serve } = await import('@hono/node-server');
  let minted = [];
  app = createApp({ verify : async (token) => token === 'good' ? { token, clientId : 'c1', scopes : ['email', 'profile'], extra : { userId : 'user_1' } } : undefined, mint : async (userId) => { minted.push(userId); return 'mt_fake_' + userId; } });
  app.minted = minted;
  server = serve({ fetch : app.fetch, port : 0, hostname : '127.0.0.1' });
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); upstream?.close(); });

test('metadata: protected resource points at the resource URL; no token is 401 with WWW-Authenticate', async () => {
  let prm = await (await fetch(base + '/.well-known/oauth-protected-resource')).json();
  assert.ok(prm.resource); assert.deepEqual(prm.scopes_supported, ['profile', 'email']); assert.ok(Array.isArray(prm.authorization_servers));
  let r = await fetch(base + '/mcp', { method : 'POST', headers : { 'content-type' : 'application/json' }, body : '{}' });
  assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate') || '', /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp", scope="profile email"/);
  let g = await fetch(base + '/mcp');
  assert.equal(g.status, 401, 'unauthenticated GET gets the same challenge'); assert.match(g.headers.get('www-authenticate') || '', /scope="profile email"/);
  let bad = await fetch(base + '/mcp', { method : 'POST', headers : { 'content-type' : 'application/json', authorization : 'Bearer nope' }, body : '{}' });
  assert.equal(bad.status, 401);
});

test('rate limit: a tripped per-IP limiter answers 429 before auth', async () => {
  const { createApp } = await import('../src/app.js');
  let a = createApp({ verify : async () => undefined });
  let res = await a.request('http://x/mcp', { method : 'POST', headers : { 'cf-connecting-ip' : '1.2.3.4' } }, { RL_IP : { limit : async () => ({ success : false }) } });
  assert.equal(res.status, 429);
  let ok = await a.request('http://x/mcp', { method : 'POST', headers : { 'cf-connecting-ip' : '1.2.3.4' } }, { RL_IP : { limit : async () => ({ success : true }) } });
  assert.equal(ok.status, 401, 'under the limit the normal challenge follows');
});

test('tools: list, whoami forwards the token, add_webhook defaults to identification, preview, list_visitors', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  let client = new Client({ name : 'test', version : '0' });
  let transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit : { headers : { authorization : 'Bearer good' } } });
  await client.connect(transport);
  let tools = (await client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(tools, ['add_webhook', 'create_site', 'enrich_contact', 'get_billing_status', 'get_signals_status', 'get_site_status', 'get_snippet', 'get_visitor', 'list_moments', 'list_sites', 'list_visitors', 'list_webhooks', 'preview_webhook', 'set_signals', 'test_webhook', 'whoami']);
  let all = (await client.listTools()).tools; let ro = (n) => all.find(t => t.name === n).annotations.readOnlyHint;
  assert.equal(ro('get_signals_status'), true); assert.equal(ro('list_sites'), true); assert.equal(ro('set_signals'), false); assert.equal(ro('add_webhook'), false); assert.equal(ro('create_site'), false);

  let who = JSON.parse((await client.callTool({ name : 'whoami', arguments : {} })).content[0].text);
  assert.equal(who.data.email, 'dev@acme.com');
  assert.equal(seen.find(r => r.path === '/api/sqid/me').auth, 'Bearer mt_fake_user_1', 'upstream sees the machine token for the verified user, never the client token');
  assert.ok(!seen.some(r => r.auth === 'Bearer good'), 'the MCP client token is never passed through');

  let add = JSON.parse((await client.callTool({ name : 'add_webhook', arguments : { url : 'https://acme.test/api/visitors' } })).content[0].text);
  assert.equal(add.data.event, 'identification'); assert.equal(add.data.id, 'wh2');
  let post = seen.find(r => r.method === 'POST' && r.path === '/api/v2/projects/sdk1/webhook');
  assert.equal(post.body.namespace, 'visitor.identification.created.v2');

  let pv = JSON.parse((await client.callTool({ name : 'preview_webhook', arguments : {} })).content[0].text);
  assert.equal(pv.data.payload.data.visitor.id, 'v1');

  let vl = JSON.parse((await client.callTool({ name : 'list_visitors', arguments : { search : 'nor' } })).content[0].text);
  assert.equal(vl.data.visitors[0].email, 'j@n.test');

  let st = JSON.parse((await client.callTool({ name : 'get_site_status', arguments : {} })).content[0].text);
  assert.equal(st.data.stream_is_live, true);

  let httpBad = await client.callTool({ name : 'add_webhook', arguments : { url : 'https://acme.test/x', event : 'moment' } });
  assert.equal(JSON.parse(httpBad.content[0].text).ok, true);
  let nf = await client.callTool({ name : 'test_webhook', arguments : { webhook_id : 'nope' } });
  assert.equal(nf.isError, true); assert.equal(JSON.parse(nf.content[0].text).error.code, 'webhook_not_found');
  assert.deepEqual(app.minted, ['user_1'], 'one machine token per person, cached');
  await client.close();
});
