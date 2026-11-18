// Offline: a fake Sqid API, a verify stub that accepts "good" and rejects the rest,
// and a real MCP client over Streamable HTTP.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let upstream, seen = [], app, server, base, started = true, sandboxMade = false, billingAccount = null;
const fakeJwt = (claims) => 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
let sbxOrigins = 'http://localhost:5173';

before(async () => {
  upstream = http.createServer(async (req, res) => {
    let b = ''; for await (let c of req){ b += c; }
    let u = new URL(req.url, 'http://x'); seen.push({ method : req.method, path : u.pathname, query : Object.fromEntries(u.searchParams), body : b ? JSON.parse(b) : null, auth : req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    let P = u.pathname;
    if(P === '/api/sqid/me'){ return res.end(JSON.stringify({ email : 'dev@acme.com', role : 'owner', account : { hasSubscription : !!started } })); }
    if(P === '/api/sqid/billing/start' && req.method === 'POST'){ started = true; return res.end(JSON.stringify({ started : true, plan : 'developer', sandbox_sdk_id : 'sbx1' })); }
    if(P === '/api/sqid/sandbox' && req.method === 'POST'){ sandboxMade = true; return res.end(JSON.stringify({ sdk_id : 'sbx1', created : true })); }
    if(P === '/api/projects/sbx1' && req.method === 'PATCH'){ sbxOrigins = JSON.parse(b).site_origins.join(','); return res.end(JSON.stringify({ _id : 'sbx1' })); }
    // Like platform2's projectRow: no origins field, the origins are the jwt's `site` claim.
    if(P === '/api/sqid/projects'){ return res.end(JSON.stringify([{ _id : 'sdk1', name : 'Acme', jwt : fakeJwt({ sdk_id : 'sdk1', site : 'https://acme.test' }), state : { deployed : true, connected : true } }, ...(started && sandboxMade ? [{ _id : 'sbx1', name : 'Sandbox', sandbox : true, jwt : fakeJwt({ site : sbxOrigins }), state : {} }] : [])])); }
    if(P === '/api/sqid/billing/account'){ return billingAccount ? res.end(JSON.stringify(billingAccount)) : (res.statusCode = 404, res.end('{}')); }
    if(P === '/api/sqid/billing'){ return res.end(JSON.stringify({ cards : [] })); }
    if(P === '/api/sqid/billing/card-link' && req.method === 'POST'){ if(u.searchParams.get('account') === 'nope@x.test'){ res.statusCode = 409; return res.end(JSON.stringify({ error : 'account_required' })); } return res.end(JSON.stringify({ url : 'https://app.sqid.dev/add-card/abcdefghijklmnopqrstuvwxyz012345', expires_at : '2026-11-18T20:00:00Z', account : 'dev@acme.com' })); }
    if(P === '/api/sqid/billing/refresh' && req.method === 'POST'){ return res.end(JSON.stringify({ cards : [] })); }
    if(P === '/api/sqid/billing/accounts'){ return res.end(JSON.stringify([{ ownerEmail : 'dev@acme.com', role : 'owner' }, { ownerEmail : 'boss@corp.test', role : 'billing_admin', name : 'Corp' }])); }
    if(P === '/api/v2/projects/sdk1/webhook/test'){ return res.end(JSON.stringify({ success : true, status : 204, data : '' })); }
    if(P === '/api/sdks/sdk1/tokens'){ return res.end(JSON.stringify([{ name : 'MCP', jwt : 'key1' }])); }
    if(P === '/pub/visitors/enrichment'){
      let e = JSON.parse(b).email;
      if(e === 'none@x.test'){ return res.end('false'); }
      if(e === 'broke@x.test'){ res.statusCode = 400; res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end('Not enough credits'); }
      if(e === 'rl@x.test'){ res.statusCode = 429; return res.end(JSON.stringify({ message : 'Rate limit exceeded' })); }
      if(e === 'odd@x.test'){ res.statusCode = 400; res.setHeader('content-type', 'text/plain'); return res.end('Invalid email format'); }
      return res.end(JSON.stringify({ user : { email : e, name : 'Jo' } }));
    }
    if(P === '/api/sqid/sdks/sdk1/webhooks'){ return res.end(JSON.stringify([{ id : 'wh1', name : 'x', namespace : 'visitor.identification.created.v2', url : 'https://a.test/h', enabled : true, health : { status : 'healthy' } }])); }
    if(P === '/api/v2/projects/sdk1/webhook' && req.method === 'POST'){ return res.end(JSON.stringify({ _id : 'wh2' })); }
    if(P === '/api/v2/projects/sdk1/webhook/preview'){ return res.end(JSON.stringify({ id : 'evt', data : { visitor : { id : 'v1' } } })); }
    if(P === '/api/sqid/identities'){ return res.end(JSON.stringify({ identities : [{ _id : 'p1', sdk_id : 'sdk1', user : { email : 'j@n.test' } }], next : null })); }
    res.statusCode = 404; res.end(JSON.stringify({ error : 'nf' }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  process.env.SQID_API = `http://127.0.0.1:${upstream.address().port}`;
  process.env.SQID_PUBLIC_API = `http://127.0.0.1:${upstream.address().port}/pub`;
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
  assert.deepEqual(tools, ['add_card', 'add_webhook', 'create_site', 'enrich_contact', 'get_billing_status', 'get_signals_status', 'get_site_status', 'get_snippet', 'get_started', 'get_visitor', 'list_moments', 'list_sites', 'list_visitors', 'list_webhooks', 'preview_webhook', 'set_signals', 'set_site_origins', 'test_webhook', 'whoami']);
  let prompts = (await client.listPrompts()).prompts.map(p => p.name);
  assert.deepEqual(prompts, ['setup']);
  let pr = await client.getPrompt({ name : 'setup', arguments : {} });
  assert.match(pr.messages[0].content.text, /get_started/);
  assert.match(pr.messages[0].content.text, /\(c\) Just let me see it work first/);
  assert.match(pr.messages[0].content.text, /explicit yes/);

  started = false;
  let gs = JSON.parse((await client.callTool({ name : 'get_started', arguments : {} })).content[0].text);
  assert.equal(gs.data.account.plan_started_now, true, 'no plan: Start free is called');
  assert.equal(gs.data.sandbox.id, 'sbx1', 'no sandbox on the account: POST /api/sqid/sandbox makes one'); assert.match(gs.data.sandbox.snippet, /sbx1/);
  assert.ok(seen.some(r => r.method === 'POST' && r.path === '/api/sqid/sandbox'));
  assert.deepEqual(gs.data.sandbox.origins, ['http://localhost:5173'], 'origins come from the jwt site claim'); assert.equal(gs.data.sandbox.origins_set, true);
  assert.deepEqual(gs.data.sites[0].origins, ['https://acme.test']);
  assert.deepEqual(gs.data.paths.map(p => p.id), ['own_site', 'embed_oem', 'just_try']);
  assert.equal(gs.data.paths.find(p => p.default).id, 'just_try');
  assert.deepEqual(gs.data.plans.map(p => p.id), ['developer', 'oem_launch', 'enterprise']);
  assert.match(gs.data.plans[1].price, /\$675\/month, 500 identifications/);
  assert.match(gs.data.account.plan_line, /^You're on the free Developer plan.*Sandbox is free.*25 real identified visitors are free.*\$0\.25 each.*nothing is charged/, 'billing unreachable, plan just started: still Developer');
  assert.match(gs.data.playground.what_youll_see, /anonymous visitor/);
  // add (default) keeps what was there
  let so = JSON.parse((await client.callTool({ name : 'set_site_origins', arguments : { site_id : 'sbx1', origins : ['http://localhost:3000/some/path'] } })).content[0].text);
  assert.equal(so.data.mode, 'add');
  assert.deepEqual(so.data.before, ['http://localhost:5173']); assert.deepEqual(so.data.origins, ['http://localhost:5173', 'http://localhost:3000']); assert.deepEqual(so.data.removed, []);
  assert.deepEqual(seen.filter(r => r.method === 'PATCH' && r.path === '/api/projects/sbx1').pop().body, { name : 'Sandbox', site_origins : ['http://localhost:5173', 'http://localhost:3000'], product_origins : ['http://localhost:5173', 'http://localhost:3000'] });
  // replace says what it removed
  let rp = JSON.parse((await client.callTool({ name : 'set_site_origins', arguments : { site_id : 'sbx1', origins : ['http://localhost:3000'], mode : 'replace' } })).content[0].text);
  assert.deepEqual(rp.data.origins, ['http://localhost:3000']); assert.deepEqual(rp.data.removed, ['http://localhost:5173']);
  let ls = JSON.parse((await client.callTool({ name : 'list_sites', arguments : {} })).content[0].text);
  assert.deepEqual(ls.data.find(x => x.id === 'sbx1').origins, ['http://localhost:3000']);
  assert.ok(!('jwt' in ls.data[0]), 'the jwt itself is not exposed');
  let sbxEnrich = await client.callTool({ name : 'enrich_contact', arguments : { site_id : 'sbx1', email : 'a@b.test' } });
  assert.equal(JSON.parse(sbxEnrich.content[0].text).error.code, 'sandbox_not_supported');
  assert.ok(seen.some(r => r.method === 'POST' && r.path === '/api/sqid/billing/start'));
  let gs2 = JSON.parse((await client.callTool({ name : 'get_started', arguments : {} })).content[0].text);
  assert.equal(gs2.data.account.plan_started_now, false, 'second call: plan already there');
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
  let tw = JSON.parse((await client.callTool({ name : 'test_webhook', arguments : { webhook_id : 'wh1' } })).content[0].text);
  assert.equal(tw.data.delivered, true, 'bare { success, status, data } is read'); assert.equal(tw.data.status, 204);

  let en = JSON.parse((await client.callTool({ name : 'enrich_contact', arguments : { email : 'jo@x.test' } })).content[0].text);
  assert.equal(en.data.matched, true); assert.equal(en.data.record.user.email, 'jo@x.test');
  assert.equal(seen.filter(r => r.path === '/pub/visitors/enrichment').pop().auth, 'Bearer key1');
  let none = JSON.parse((await client.callTool({ name : 'enrich_contact', arguments : { email : 'none@x.test' } })).content[0].text);
  assert.deepEqual(none.data, { matched : false, credit_used : false, record : null }, '200 false is no match');
  let broke = await client.callTool({ name : 'enrich_contact', arguments : { email : 'broke@x.test' } });
  assert.equal(broke.isError, true); let be = JSON.parse(broke.content[0].text).error; assert.equal(be.code, 'no_credits'); assert.match(be.message, /Not enough credits/);
  let rl = JSON.parse((await client.callTool({ name : 'enrich_contact', arguments : { email : 'rl@x.test' } })).content[0].text);
  assert.equal(rl.error.code, 'rate_limited'); assert.match(rl.error.message, /Rate limit exceeded/);
  let odd = JSON.parse((await client.callTool({ name : 'enrich_contact', arguments : { email : 'odd@x.test' } })).content[0].text);
  assert.equal(odd.error.message, 'Invalid email format', 'an unknown plain-text reason is passed through');

  billingAccount = { plan : 'oem', credits : { available : 640, unlimited : false, cents_per_credit : 25, plan : { name : 'Sqid OEM Launch', kind : 'oem', included_per_month : 500 }, used_this_month : 120, packs : [{ credits : 1000, cents : 20000 }], plan_state : { plan : 'oem', period_end : '2026-12-01T00:00:00Z', downgrade_at : null }, welcome : { credits : 0, granted : false }, auto_reload : { enabled : false } } };
  let bs = JSON.parse((await client.callTool({ name : 'get_billing_status', arguments : {} })).content[0].text);
  assert.equal(bs.data.plan.kind, 'oem'); assert.equal(bs.data.credits.available, 640); assert.ok(!('value_usd' in bs.data.credits), 'OEM credits are not valued at 25 cents');
  assert.equal(bs.data.plan_state.period_end, '2026-12-01T00:00:00Z'); assert.equal(bs.data.credits.used_this_month, 120);
  billingAccount = null;

  // add_card: one call to the console's card-link route, no arguments sent, the Stripe link back
  let ac = JSON.parse((await client.callTool({ name : 'add_card', arguments : {} })).content[0].text);
  assert.ok(ac.data.url.startsWith('https://app.sqid.dev/add-card/'), 'a console link bound to the person, not the Stripe page');
  let call = seen.filter(x => x.path === '/api/sqid/billing/card-link').at(-1);
  assert.equal(call.method, 'POST'); assert.deepEqual(call.body, {}, 'nothing from the chat picks the account or customer');
  await client.callTool({ name : 'get_billing_status', arguments : { after_card : true } });
  assert.ok(seen.some(x => x.path === '/api/sqid/billing/refresh' && x.method === 'POST'), 'after_card reads fresh');
  let amb = await client.callTool({ name : 'add_card', arguments : { account : 'nope@x.test' } });
  assert.equal(amb.isError, true); assert.match(amb.content[0].text, /account_required/);

  let nf = await client.callTool({ name : 'test_webhook', arguments : { webhook_id : 'nope' } });
  assert.equal(nf.isError, true); assert.equal(JSON.parse(nf.content[0].text).error.code, 'webhook_not_found');
  assert.deepEqual(app.minted, ['user_1'], 'one machine token per person, cached');
  await client.close();
});

test('INSTRUCTIONS: a short router under the 4,096-character limit, identification first', async () => {
  const { INSTRUCTIONS } = await import('../src/app.js');
  assert.ok(INSTRUCTIONS.length < 4096, `INSTRUCTIONS is ${INSTRUCTIONS.length} characters`);
  assert.match(INSTRUCTIONS.slice(0, 600), /get_started/, 'the setup routing comes first');
  assert.match(INSTRUCTIONS, /50 made-up people/); assert.match(INSTRUCTIONS, /never the default/);
});

test('shapes: test result, enrichment, origins, billing view and plan line', async () => {
  const { testResult, enrichResult, originsOf, billingView, planLine } = await import('../src/tools.js');
  assert.deepEqual([testResult({ success : true, status : 200, data : 'ok' }).delivered, testResult({ success : true, status : 200 }).status], [true, 200]);
  assert.deepEqual([testResult({ response : { success : false, status : 500 } }).delivered, testResult({ response : { success : false, status : 500 } }).status], [false, 500], 'the older wrapped shape still reads');
  assert.equal(testResult({ success : false, status : 0 }).status, 0);
  assert.equal(enrichResult(false).matched, false); assert.equal(enrichResult({ a : 1 }).matched, true);
  assert.deepEqual(originsOf('h.' + Buffer.from(JSON.stringify({ site : 'https://a.test,https://www.a.test' })).toString('base64url') + '.s'), ['https://a.test', 'https://www.a.test']);
  assert.deepEqual(originsOf(undefined), []); assert.deepEqual(originsOf('garbage'), []);

  let dev = billingView({ cards : [] }, { plan : 'developer', credits : { available : 25, cents_per_credit : 25, plan : { name : 'Sqid Developer', kind : 'developer', included_per_month : 0 }, used_this_month : 3, welcome : { credits : 25, granted : true }, plan_state : null, auto_reload : { enabled : false } } }, null);
  assert.equal(dev.credits.value_usd, 6.25); assert.equal(dev.welcome.granted, true); assert.equal(dev.add_card_url, 'https://app.sqid.dev/billing?add=card');
  assert.match(planLine(dev, false), /free Developer plan with 25 credits left.*\(\$0\.25\); nothing is charged/);
  let fresh = billingView(null, { plan : 'developer', credits : { available : 0, cents_per_credit : 25, plan : { kind : 'developer' }, welcome : { credits : 25, granted : false } } }, null);
  assert.match(planLine(fresh, true), /no card needed to try it.*first 25 real identified visitors are free/);
  let oem = billingView(null, { plan : 'oem', oem : { period_end : '2026-12-01', cancel_at : '2026-12-01' }, credits : { available : 10, cents_per_credit : 25, plan : { kind : 'oem' }, used_this_month : 7, plan_state : { period_end : '2026-12-01', downgrade_at : '2026-12-01' } } }, null);
  assert.equal(oem.credits.value_usd, undefined); assert.equal(oem.welcome, undefined);
  assert.match(planLine(oem), /OEM Launch: \$675\/month, 500 identifications a month included, 7 used this month; switching to Developer on 2026-12-01/);
  let ent = billingView(null, { plan : 'enterprise', plan_label : 'Acme custom', balance : { units : 5 } }, null);
  assert.equal(ent.plan.kind, 'enterprise'); assert.equal(ent.credits, null);
});
