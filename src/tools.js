// The tools. Same actions as the sqid CLI, same defaults: identification (who is on the
// site) is the first-class path; moments are one option. Every tool takes the verified
// user id from authInfo (set by the Clerk token check) and the upstream layer calls
// app.sqid.dev as that person with the server's own machine token. Results are JSON text
// plus `next` hints.

import { z } from 'zod';
import { api, publicApi, UpstreamError } from './upstream.js';

export const EVENTS = {
  identification : { namespace : 'visitor.identification.created.v2', v2 : true },
  moment         : { namespace : 'visitor.moment.created.v2',         v2 : true },
  page           : { namespace : 'visitor.connection.event',          v2 : false },
  click          : { namespace : 'visitor.click.event',               v2 : false }
};
const SECTIONS = {
  'visitor.connection.event' : { context : true, location : true, device : true, traits : false, social : false },
  'visitor.click.event'      : { context : true, details : true, element : true, traits : false, social : false }
};
const WITH_EXTRA = ['traits', 'social', 'company'];
const settingsFor = (ns) => Object.fromEntries(Object.entries(SECTIONS[ns] || {}).map(([k, on]) => [k, WITH_EXTRA.includes(k) ? { enabled : on, extra : {} } : { enabled : on }]));
const base = (siteId, ev) => `${ev.v2 ? '/api/v2' : '/api'}/projects/${siteId}`;

export const snippetFor = (sdkId) => `<script>
;(function(squid){
  (window.$quid) || (window.$quid = {});
  document.head.appendChild((function(s){
    s.src='https://app.asksquid.ai/tfs/'+squid+'/sdk';
    s.async=1; return s;
  })(document.createElement('script')));
})('${sdkId}');
</script>`;

// A site's allowed origins live in its signed config: the `site` claim of the SDK's jwt, comma-separated
// (platform2 managers/projects/update.js signs it; the console reads it the same way). GET /api/sqid/projects
// returns that jwt but no origins field.
export function originsOf(jwt){
  try{
    let part = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    let site = JSON.parse(atob(part + '='.repeat((4 - part.length % 4) % 4))).site;
    return site ? String(site).split(',').map(x => x.trim()).filter(Boolean) : [];
  }catch(e){ return []; }
}
const siteRow = (p) => ({ id : String(p._id), name : p.name, origins : Array.isArray(p.site_origins) ? p.site_origins : originsOf(p.jwt), enabled : p.enabled !== false, deployed : !!p.state?.deployed, connected : !!p.state?.connected, sandbox : !!p.sandbox, owner : p.owner?.email || null });

async function sites(token){ return ((await api(token, 'GET', '/api/sqid/projects')) || []).map(siteRow); }
async function site(token, id){
  let all = await sites(token);
  if(id){ let hit = all.find(s => s.id === id) || all.find(s => s.name?.toLowerCase() === String(id).toLowerCase()); if(!hit){ throw new UpstreamError(404, 'site_not_found', `No site "${id}" on this account. Call list_sites.`); } return hit; }
  let real = all.filter(s => !s.sandbox);
  if(real.length === 1){ return real[0]; }
  if(!real.length){ throw new UpstreamError(404, 'no_site', 'This account has no site yet. Call create_site.'); }
  throw new UpstreamError(409, 'site_ambiguous', `This account has ${real.length} sites; pass site_id. ${real.map(s => `${s.name}=${s.id}`).join(', ')}`);
}

const ok = (data, next = []) => ({ content : [{ type : 'text', text : JSON.stringify({ ok : true, data, ...(next.length ? { next } : {}) }, null, 2) }] });
const fail = (error) => ({ isError : true, content : [{ type : 'text', text : JSON.stringify({ ok : false, error : { code : error.code || 'error', message : error.message } }) }] });
const userOf = (extra) => extra?.authInfo?.extra?.userId || extra?.authInfo?.userId;
const siteArg = { site_id : z.string().optional().describe('Site id or name. Omit when the account has one site.') };

// MCP tool annotations: readOnlyHint lets clients run reads without a write confirmation;
// destructiveHint marks changes that are hard to undo. None of these tools delete anything.
const READ  = { readOnlyHint : true,  destructiveHint : false, idempotentHint : true,  openWorldHint : false };
const WRITE = { readOnlyHint : false, destructiveHint : false, idempotentHint : false, openWorldHint : false };

const TITLES = {"get_started": "Get started", "set_site_origins": "Set site origins", "list_sites": "List sites", "create_site": "Create site", "get_site_status": "Site status", "get_snippet": "Get snippet", "add_webhook": "Add webhook", "list_webhooks": "List webhooks", "preview_webhook": "Preview webhook payload", "test_webhook": "Test webhook", "list_visitors": "List visitors", "get_visitor": "Get visitor", "enrich_contact": "Enrich contact", "get_signals_status": "Signals status", "set_signals": "Set Signals", "list_moments": "List moments", "get_billing_status": "Billing status", "add_card": "Add a card (link)", "whoami": "Who am I"};

function tool(server, name, description, schema, fn, annotations = READ){
  server.registerTool(name, { title : TITLES[name] || name, description, inputSchema : schema, annotations : { title : TITLES[name] || name, ...annotations } }, async (args, extra) => {
    try{ return await fn(args || {}, userOf(extra), extra); }
    catch(error){ return fail(error); }
  });
}

// A public site is usually reached both with and without "www.": add the other one, so a visitor on
// www.example.com is not refused because the site was created for example.com. Only for https
// hosts: "www.x.y" adds "x.y", a bare two-label "x.y" adds "www.x.y". Local hosts, IPs and other
// subdomains are left as given.
export function withTwins(origins){
  let out = [...origins];
  for(let o of origins){
    try{
      let u = new URL(o);
      if(u.protocol !== 'https:' || /^[\d.]+$/.test(u.hostname) || u.hostname === 'localhost'){ continue; }
      let h = u.hostname, twin = null;
      if(h.startsWith('www.')){ twin = h.slice(4); }
      else if(h.split('.').length === 2){ twin = `www.${h}`; }
      if(twin && twin.includes('.')){ let t = `https://${twin}${u.port ? ':' + u.port : ''}`; if(!out.includes(t)){ out.push(t); } }
    }catch(error){ /* skip */ }
  }
  return out;
}

// Prices and plan facts the setup flow states (sqid.dev/pricing; platform2 managers/sqid/billing/pricing.js).
export const PLANS = [
  { id : 'developer', name : 'Developer', price : 'free to start: the Sandbox needs no card, and adding a card gives 25 free real identifications; after that $0.25 per identified visitor (one credit), only when you choose to buy credits; no monthly fee',
    includes : '25 free welcome credits once a card is added (once per person and per card); credits expire after 12 months, oldest first; purchases $5 to $10,000; optional auto-reload refills to a target',
    fits : 'Your own website or a few sites; you only pay for identified visitors. Starting it is not a commitment.' },
  { id : 'oem_launch', name : 'OEM Launch', price : '$675/month, 500 identifications a month included',
    includes : 'credit packs after that: 1,000 for $200, 5,000 for $900, 10,000 for $1,700, 25,000 for $4,000',
    fits : 'Identification inside a product you sell to other businesses, roughly 1 to 100 customer sites.',
    upgrade : 'From Developer in the console (Billing) or `sqid plan set oem --accept-terms`; account owner only, card required, terms accepted there.' },
  { id : 'enterprise', name : 'Enterprise', price : 'custom',
    fits : 'More than 100 customer sites, or custom terms or volume.', contact : 'help@asksquid.ai' }
];

export const SANDBOX_FACTS = 'The Sandbox is a test site: every new visitor becomes one of 50 made-up people, it never spends a credit, never produces moments, and enrichment is refused there. For a new test person: the console\'s Forget identity on a Test profile, or run `await squid.anonymouse()` in the page\'s console and reload (a private window usually lands on the same person, because matching is by device). It starts with no allowed origins: set_site_origins with the local or staging address (e.g. http://localhost:3000) lets the snippet load there.';

export const PLAYGROUND = {
  command : 'npx -y @sqid-dev/playground',
  url : 'http://localhost:3000, or the next free port when 3000 is busy; the Playground prints the address ("Open http://localhost:<port>")',
  what : 'A demo shop (Driftwood) with a Sqid panel, using this sign-in and the Sandbox. No credits, nothing to install in a project.',
  what_youll_see : 'You appear as an anonymous visitor, then as a person within a couple of seconds. The panel on the right shows it happen.',
  after : 'The panel\'s "Put Sqid on my site" button creates a real site (path own_site); "Send this to my app" adds a webhook.'
};

const kindOf = (cr, account) => {
  let k = cr?.plan?.kind && cr.plan.kind !== 'other' ? cr.plan.kind : account?.plan;
  return k === 'oem' ? 'oem' : k === 'developer' ? 'developer' : k === 'enterprise' ? 'enterprise' : (cr?.plan?.kind === 'other' ? 'other' : null);
};
const NAMES = { developer : 'Developer', oem : 'OEM Launch', enterprise : 'Enterprise' };

// One read of the console's billing routes, shaped for get_billing_status and get_started.
// Developer credits have a dollar value ($0.25 each); OEM Launch credits come from the plan and packs, so
// they are counted, never valued.
export function billingView(overview, account, usage){
  let cr = account?.credits || null;
  let kind = kindOf(cr, account);
  let card = (overview?.cards || []).find(c => c.default) || overview?.cards?.[0] || account?.card || null;
  let st = cr?.plan_state || account?.oem || null;
  let welcome = cr?.welcome || (account?.welcome ? { credits : null, granted : !!account.welcome.claimed } : null);
  return {
    plan : { kind, name : NAMES[kind] || cr?.plan?.name || account?.plan_label || (typeof overview?.plan === 'string' ? overview.plan : overview?.plan?.name) || null, label : account?.plan_label || cr?.plan?.name || null },
    card : card ? { brand : card.brand, last4 : card.last4 } : null,
    credits : cr ? {
      available : cr.available, unlimited : !!cr.unlimited,
      ...(kind === 'developer' ? { cents_per_credit : cr.cents_per_credit, value_usd : cr.available == null ? null : (cr.available * cr.cents_per_credit) / 100 } : {}),
      included_per_month : cr.plan?.included_per_month ?? null,
      used_this_month : cr.used_this_month ?? null,
      next_expiry : cr.next_expiry || null,
      ...(kind === 'oem' && cr.packs?.length ? { packs : cr.packs.map(p => ({ credits : p.credits, usd : p.cents / 100 })) } : {})
    } : null,
    welcome : kind === 'developer' && welcome ? { credits : welcome.credits || 25, granted : !!welcome.granted } : undefined,
    plan_state : st ? { period_end : st.period_end || null, downgrade_at : st.downgrade_at || st.cancel_at || null } : null,
    balance : cr ? undefined : account?.balance ?? null,
    auto_reload : cr ? cr.auto_reload : account?.auto_reload ?? null,
    usage : usage?.identifications?.totals ? { month : usage.month, ...usage.identifications.totals } : null,
    upgrade_available : account?.upgrade ? !!account.upgrade.available : undefined,
    add_card_url : card ? undefined : 'https://app.sqid.dev/billing?add=card',
    console_url : 'https://app.sqid.dev/billing'
  };
}

// The one-line plan summary get_started returns (from real billing state; nothing invented).
// Free first, in the order a person can use it: the Sandbox (free, no card), 25 free real identifications once a
// card is added, then $0.25 each only after they choose to buy credits. Never lead with the price.
const FREE_LINE = (n) => `You're on the free Developer plan: no monthly fee, and no card needed to try it. The Sandbox is free with made-up visitors; add a card and your first ${n} real identified visitors are free. After that it's $0.25 each, and nothing is charged until you choose to buy credits.`;

export function planLine(b, startedNow){
  let k = b?.plan?.kind;
  if(k === 'developer'){
    let w = b.welcome;
    if(w?.granted){ return `You're on the free Developer plan with ${b.credits?.available ?? 0} credits left. Each identified visitor uses one credit ($0.25); nothing is charged until you buy more credits or turn on auto-reload.`; }
    return FREE_LINE(w?.credits || 25);
  }
  if(k === 'oem'){
    let used = b.credits?.used_this_month;
    return `You're on OEM Launch: $675/month, 500 identifications a month included${used != null ? `, ${used} used this month` : ''}${b.plan_state?.downgrade_at ? `; switching to Developer on ${String(b.plan_state.downgrade_at).slice(0, 10)}` : ''}.`;
  }
  if(k === 'enterprise'){ return 'You\'re on an Enterprise plan.'; }
  if(b?.plan?.name){ return `You're on ${b.plan.name}.`; }
  return startedNow ? FREE_LINE(25) : 'Plan details: get_billing_status.';
}

// The public enrichment route answers 200 `false` when it has no record: no match, no credit used.
export const enrichResult = (r) => r === false || r == null ? { matched : false, credit_used : false, record : null } : { matched : true, record : r };

// The test route answers with the delivery itself, { success, status, data } (platform2 e1f62e6b);
// older answers wrapped it as { request, response }. Both are read.
export const testResult = (r) => ({
  delivered : !!(r?.success ?? r?.response?.success),
  status    : r?.status ?? r?.response?.status ?? null,
  response  : r?.data ?? r?.response?.data ?? null,
  ...(r?.request?.payload ? { request : r.request.payload } : {}),
  note      : 'Test sends are not recorded under the webhook\'s deliveries.'
});

export function registerTools(server){
  tool(server, 'whoami', 'The account that authorized this connection: email, role, whether it has a plan.', {}, async (_, t) => ok(await api(t, 'GET', '/api/sqid/me')));

  tool(server, 'get_started', 'Account state and the setup choices, in one call. Makes sure the account has a plan (starts the free, pay-as-you-go Developer plan if it has none: no monthly fee, 25 welcome credits once a card is added) and a Sandbox site. Returns the account, a one-line plan summary from real billing state, whether welcome credits were granted, real sites with their allowed origins, the Sandbox with its snippet, the Playground, the three paths (own_site, embed_oem, just_try) each with what it fits and its next tools, and the three plans (developer, oem_launch, enterprise) with price and fit. The /sqid:setup prompt holds the guided flow.', {}, async (_, t) => {
    let me = await api(t, 'GET', '/api/sqid/me');
    let started = null;
    if(!me.account?.hasSubscription){ started = await api(t, 'POST', '/api/sqid/billing/start', {}); }
    let all = await sites(t);
    let sandbox = all.find(s => s.sandbox) || null;
    if(!sandbox){
      // Accounts invited before self-serve have no Sandbox; the console route makes one (idempotent).
      try{ let made = await api(t, 'POST', '/api/sqid/sandbox', {}); if(made?.sdk_id){ all = await sites(t); sandbox = all.find(s => s.id === String(made.sdk_id)) || all.find(s => s.sandbox) || null; } }catch(error){ /* no sandbox for this account; the website path still works */ }
    }
    let real = all.filter(s => !s.sandbox);
    let [overview, account] = await Promise.all([api(t, 'GET', '/api/sqid/billing').catch(() => null), api(t, 'GET', '/api/sqid/billing/account').catch(() => null)]);
    let b = billingView(overview, account, null);
    if(!b.plan.kind && started?.plan === 'developer'){ b.plan = { kind : 'developer', name : 'Developer', label : null }; }
    let sitesLine = real.length ? `${real.length} site${real.length === 1 ? '' : 's'}: ${real.map(s => s.name).join(', ')}` : 'No real sites yet';
    return ok({
      account : { email : me.email, role : me.role || null, plan_started_now : !!started, plan : b.plan, plan_line : planLine(b, !!started), sites_line : `${sitesLine}${sandbox ? ', plus the Sandbox' : ''}.` },
      billing : { card_on_file : !!b.card, welcome_credits : b.welcome || null, credits_available : b.credits?.available ?? null, used_this_month : b.credits?.used_this_month ?? null, add_card_url : b.add_card_url, developer_is : 'Pay as you go with free welcome credits; no monthly fee and not a commitment.' },
      sites : real,
      sandbox : sandbox ? { ...sandbox, snippet : snippetFor(sandbox.id), origins_set : (sandbox.origins || []).length > 0, facts : SANDBOX_FACTS } : null,
      playground : PLAYGROUND,
      paths : [
        { id : 'own_site', choice : 'a', label : 'Show me who\'s visiting my website', fits : 'A website you run; Developer fits, you pay only for identified visitors.',
          next_tools : ['create_site', 'set_site_origins', 'get_snippet', 'list_visitors', 'add_webhook', 'preview_webhook', 'get_site_status'] },
        { id : 'embed_oem', choice : 'b', label : 'Add visitor identification to a product I sell to other businesses', fits : 'A product used by other businesses\' sites; OEM Launch for about 1 to 100 customer sites, Enterprise beyond that or for custom terms.',
          next_tools : ['get_billing_status', 'create_site', 'get_snippet', 'add_webhook', 'preview_webhook', 'get_site_status'], docs : 'https://docs.sqid.dev' },
        { id : 'just_try', choice : 'c', default : true, label : 'Just let me see it work first', fits : 'No site or project at hand, or a look before deciding; uses the Sandbox, no credits.',
          next_tools : ['run the Playground command', 'list_visitors (Sandbox)'], playground : PLAYGROUND.command }
      ],
      plans : PLANS,
      identification_first : 'Identified visitors (list_visitors, add_webhook event identification) are the main outcome; moments (set_signals) are optional and need a real site.'
    }, [
      { tool : 'create_site', when : 'path own_site or embed_oem, for a real site' },
      { tool : 'get_snippet', when : 'to use the Sandbox on a local or staging page', args : sandbox ? { site_id : sandbox.id } : undefined }
    ]);
  }, WRITE);

  tool(server, 'list_sites', 'Sites on the account (id, name, allowed origins, deployed, connected, sandbox).', {}, async (_, t) => ok(await sites(t), [{ tool : 'get_snippet', when : 'to get a site’s install snippet' }]));

  tool(server, 'create_site', 'Create a site for a web app and return its install snippet. Starts the free Developer plan first if the account has none. A bare domain also gets its www. address (and www. its bare one), since visitors arrive on both.', {
    name : z.string().min(1).max(50).describe('Site name, e.g. the app name'),
    origins : z.array(z.string().url()).min(1).describe('Public origins the snippet will run on, e.g. ["https://example.com"]')
  }, async ({ name, origins }, t) => {
    let me = await api(t, 'GET', '/api/sqid/me');
    let started = null;
    if(!me.account?.hasSubscription){ started = await api(t, 'POST', '/api/sqid/billing/start', {}); }
    let o = withTwins([...new Set(origins.map(u => new URL(u).origin))]);
    let existing = (await sites(t)).find(s => !s.sandbox && s.name?.toLowerCase() === name.toLowerCase());
    let id = existing?.id;
    if(!id){ let created = await api(t, 'POST', '/api/projects', { name, site_origins : o, product_origins : o, avatar_index : 1 }); id = String(created?._id || created?.id); }
    return ok({ site : { id, name, origins : o }, reused_existing : !!existing, plan_started : started?.plan || undefined, snippet : snippetFor(id), paste : 'The snippet goes before </head> on every page of the site.' }, [
      { tool : 'add_webhook', when : 'to be told who each identified visitor is (event identification, the default)' },
      { tool : 'add_webhook', when : 'to send visitor intent moments to an agent (event moment)' },
      { tool : 'get_site_status', when : 'after the snippet is deployed and the site opened once' }
    ]);
  }, WRITE);

  tool(server, 'set_site_origins', 'Allowed origins of a site: the addresses the snippet may load on, e.g. "https://example.com" or, for the Sandbox, "http://localhost:3000". mode "add" (default) keeps the existing origins and adds these; mode "replace" sets exactly this list. Paths are dropped (origin only). The result lists the origins before and after, and any that were removed.', {
    ...siteArg,
    origins : z.array(z.string().url()).min(1),
    mode    : z.enum(['add', 'replace']).default('add').describe('"add" merges with the existing origins (default); "replace" sets exactly this list')
  }, async ({ site_id, origins, mode = 'add' }, t) => {
    let s = await site(t, site_id);
    let before = s.origins || [];
    let given = origins.map(u => new URL(u).origin);
    let o = [...new Set(mode === 'replace' ? given : [...before, ...given])];
    let r = await api(t, 'PATCH', `/api/projects/${s.id}`, { name : s.name, site_origins : o, product_origins : o });
    let removed = before.filter(x => !o.includes(x));
    return ok({ site : { id : s.id, name : s.name }, mode, before, origins : o, added : o.filter(x => !before.includes(x)), removed, result : r?.site_origins || r?._id ? undefined : r }, [{ tool : 'get_snippet', when : 'to get the snippet for this site', args : { site_id : s.id } }]);
  }, WRITE);

  tool(server, 'get_snippet', 'The install snippet for a site: the one script tag that goes before </head> on every page of the site.', siteArg, async ({ site_id }, t) => { let s = await site(t, site_id); return ok({ site : s, snippet : snippetFor(s.id) }); });

  tool(server, 'get_site_status', 'Health of a site: deployed (page views seen), connected, webhooks and their health. The "stream is live" check.', siteArg, async ({ site_id }, t) => {
    let s = await site(t, site_id);
    let hooks = await api(t, 'GET', `/api/sqid/sdks/${s.id}/webhooks`).catch(() => []);
    let list = Array.isArray(hooks) ? hooks : hooks?.webhooks || [];
    let failing = list.filter(h => h.enabled === false || h.health?.status === 'failing');
    let live = s.deployed && s.connected && list.length > 0 && failing.length === 0;
    return ok({ site : s, webhooks : list.map(h => ({ id : h.id, name : h.name, event : h.namespace, url : h.url, enabled : h.enabled, health : h.health?.status })), stream_is_live : live, checks : [
      { name : 'deployed',  ok : s.deployed,  message : s.deployed ? 'Sqid has seen page views.' : 'No page view yet: deploy the snippet and open the site once.' },
      { name : 'connected', ok : s.connected, message : s.connected ? 'Connected.' : 'Not connected yet (follows the first page view).' },
      { name : 'webhooks',  ok : list.length > 0 && !failing.length, message : !list.length ? 'No webhooks: identified visitors are not being sent anywhere.' : failing.length ? `${failing.length} webhook(s) disabled or failing.` : `${list.length} webhook(s) healthy.` }
    ] });
  });

  tool(server, 'add_webhook', 'Create a webhook endpoint on a site. Events: "identification" (default; the full record of each identified visitor), "moment" (every Signals moment with its verdict; act on decision.action "engage"), "page" (an identified visitor opens the site), "click" (an identified visitor clicks an element labelled as a key event or conversion). The endpoint must be a public https URL. Payload shapes: https://docs.sqid.dev/console/webhooks', {
    ...siteArg,
    url   : z.string().url().describe('Public https URL of the handler'),
    event : z.enum(['identification', 'moment', 'page', 'click']).default('identification'),
    name  : z.string().max(60).optional(),
    auth  : z.object({ username : z.string(), password : z.string() }).optional().describe('HTTP basic auth sent on every delivery')
  }, async ({ site_id, url, event = 'identification', name, auth }, t) => {
    if(!/^https:\/\//i.test(url)){ throw new UpstreamError(400, 'invalid_webhook_url', 'Endpoints must be public https URLs.'); }
    let s = await site(t, site_id); let ev = EVENTS[event];
    let nm = name || (() => { let u = new URL(url); return `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 60); })();
    let body = { name : nm, namespace : ev.namespace, frequency : 'all_time', enabled : true, source : ev.v2 ? { webhook_url : url, auth : auth || null } : { webhook_url : url, settings : settingsFor(ev.namespace), auth : auth || null } };
    let created = await api(t, 'POST', `${base(s.id, ev)}/webhook`, body);
    let id = String(created?._id || created?.id || '');
    return ok({ id, name : nm, event, namespace : ev.namespace, url, site : s }, [{ tool : 'preview_webhook', when : 'to get the exact payload shape while writing the handler' }, { tool : 'test_webhook', when : 'to send a sample delivery to the handler now' }]);
  }, WRITE);

  tool(server, 'list_webhooks', 'Webhook endpoints on a site with health.', siteArg, async ({ site_id }, t) => {
    let s = await site(t, site_id); let hooks = await api(t, 'GET', `/api/sqid/sdks/${s.id}/webhooks`);
    return ok((Array.isArray(hooks) ? hooks : hooks?.webhooks || []).map(h => ({ id : h.id, name : h.name, event : Object.entries(EVENTS).find(([, e]) => e.namespace === h.namespace)?.[0] || h.namespace, url : h.url, enabled : h.enabled, health : h.health?.status, totals : h.totals })));
  });

  tool(server, 'preview_webhook', 'A sample payload for an event, exactly as this site would deliver it to a webhook endpoint. Nothing is sent.', { ...siteArg, event : z.enum(['identification', 'moment', 'page', 'click']).default('identification') }, async ({ site_id, event = 'identification' }, t) => {
    let s = await site(t, site_id); let ev = EVENTS[event];
    return ok({ event, namespace : ev.namespace, payload : await api(t, 'POST', `${base(s.id, ev)}/webhook/preview`, ev.v2 ? { namespace : ev.namespace } : { namespace : ev.namespace, source : { settings : settingsFor(ev.namespace) } }) });
  });

  tool(server, 'test_webhook', 'Send a sample delivery to an endpoint now and return what it answered (HTTP status and body). Test sends are not recorded in the webhook\'s deliveries log.', { ...siteArg, webhook_id : z.string() }, async ({ site_id, webhook_id }, t) => {
    let s = await site(t, site_id);
    let hooks = await api(t, 'GET', `/api/sqid/sdks/${s.id}/webhooks`); let w = (Array.isArray(hooks) ? hooks : hooks?.webhooks || []).find(h => h.id === webhook_id);
    if(!w){ throw new UpstreamError(404, 'webhook_not_found', 'No such webhook on this site.'); }
    let ev = { v2 : /\.v2$/.test(w.namespace) };
    let r = await api(t, 'POST', `${base(s.id, ev)}/webhook/test`, { webhook_id });
    return ok(testResult(r));
  }, WRITE);

  tool(server, 'list_visitors', 'Identified visitors on a site, newest first (25 per page). search matches the start of a name, company or email (3+ chars).', { ...siteArg, search : z.string().min(3).optional(), all_sites : z.boolean().optional(), before : z.number().optional(), seen : z.array(z.string()).optional() }, async ({ site_id, search, all_sites, before, seen }, t) => {
    let q = new URLSearchParams(); if(!all_sites){ q.set('sdk', (await site(t, site_id)).id); } if(search){ q.set('q', search); } if(before){ q.set('before', String(before)); if(seen?.length){ q.set('seen', seen.join(',')); } }
    let r = await api(t, 'GET', `/api/sqid/identities?${q}`);
    return ok({ visitors : (r?.identities || []).map(p => ({ id : String(p._id), name : p.user?.name || [p.user?.firstName, p.user?.lastName].filter(Boolean).join(' ') || null, email : p.user?.email || null, company : p.user?.company || null, title : p.user?.company_role || null, linkedin : p.user?.linkedin_url || null, site_id : String(p.sdk_id), last_seen : p.last_seen_at })), next_cursor : r?.next || null });
  });

  tool(server, 'get_visitor', 'Full profile of one visitor, plus journey (pages in order) when include_journey is true.', { ...siteArg, visitor_id : z.string(), include_journey : z.boolean().optional() }, async ({ site_id, visitor_id, include_journey }, t) => {
    let s = await site(t, site_id);
    let profile = await api(t, 'GET', `/api/projects/${s.id}/profiles/${visitor_id}`);
    let journey = include_journey ? await api(t, 'GET', `/api/projects/${s.id}/profiles/${visitor_id}/journey?limit=50&skip=0`).catch(() => null) : undefined;
    return ok({ profile, journey });
  });

  tool(server, 'enrich_contact', 'Look a person up by email, phone or LinkedIn URL (exactly one) and return the enriched record, or matched: false when there is no record (no credit used). Uses the account\'s identification credits; not available on the Sandbox. Refusals come back with a reason (not enough credits, Sandbox, identification off, rate limited). Uses an SDK key for the site, created on first use ("MCP").', { ...siteArg, email : z.string().email().optional(), phone : z.string().optional(), linkedin_url : z.string().url().optional(), force : z.boolean().optional() }, async ({ site_id, email, phone, linkedin_url, force }, t) => {
    if([email, phone, linkedin_url].filter(Boolean).length !== 1){ throw new UpstreamError(400, 'usage', 'Pass exactly one of email, phone, linkedin_url.'); }
    let s = await site(t, site_id);
    if(s.sandbox){ throw new UpstreamError(400, 'sandbox_not_supported', 'Enrichment is not available on the Sandbox (it only has made-up people). Use a real site.'); }
    let keys = await api(t, 'GET', `/api/sdks/${s.id}/tokens`); let list = Array.isArray(keys) ? keys : keys?.tokens || [];
    let key = list.find(k => k.name === 'MCP' && k.jwt)?.jwt || (await api(t, 'POST', `/api/sdks/${s.id}/tokens`, { name : 'MCP' }))?.jwt;
    let r = await publicApi(key, 'POST', '/visitors/enrichment', { ...(email ? { email } : phone ? { phone } : { linkedin_url }), ...(force ? { forceUpdate : true } : {}) });
    return ok(enrichResult(r));
  }, WRITE);

  tool(server, 'get_signals_status', 'Whether Signals (intent moments) is on for a site, with the account-level state and allowance. Read only.', siteArg, async ({ site_id }, t) => {
    let s = await site(t, site_id);
    let st = await api(t, 'GET', '/api/sqid/signals/settings');
    let mine = (st?.sdks || []).find(x => String(x.id || x.sdk_id) === s.id) || null;
    return ok({ site : s, enabled : !!mine?.enabled, effective : mine?.effective || mine?.state || (mine?.enabled ? 'on' : 'off'), setting : mine, account : st?.account || null, allowance : st?.allowance || null }, mine?.enabled ? [] : [{ tool : 'set_signals', when : 'with enabled true to start producing moments' }]);
  });

  tool(server, 'set_signals', 'Turn Signals (intent moments) on or off for a site. On also starts variant-picker tracking in the SDK (sizes, colors, plans; feeds the choosing_options moment). The Sandbox never produces moments. get_signals_status reads the current state.', { ...siteArg, enabled : z.boolean() }, async ({ site_id, enabled }, t) => {
    let s = await site(t, site_id);
    return ok({ site : s, enabled, result : await api(t, 'PATCH', `/api/sqid/sdks/${s.id}/signals`, { enabled }) }, enabled ? [{ tool : 'add_webhook', when : 'with event "moment" to receive them' }] : []);
  }, WRITE);

  tool(server, 'list_moments', 'Recent Signals moments (what the engine decided about visitors). Filter by decision (engage|wait|quiet) and kind or group.', { ...siteArg, decision : z.enum(['engage', 'wait', 'quiet']).optional(), kind : z.string().optional(), all_sites : z.boolean().optional(), limit : z.number().int().min(1).max(50).optional() }, async ({ site_id, decision, kind, all_sites, limit }, t) => {
    let q = new URLSearchParams(); if(!all_sites){ q.set('sdk', (await site(t, site_id)).id); } if(decision){ q.set('decision', decision); } if(kind){ q.set('kind', kind); } if(limit){ q.set('limit', String(limit)); }
    let r = await api(t, 'GET', `/api/sqid/moments?${q}`);
    return ok({ moments : r?.events || [], next_cursor : r?.next || null, kinds : r?.kinds });
  });

  tool(server, 'get_billing_status', 'Plan and billing state, read only. Developer: pay as you go, credits at $0.25 each with their dollar value, 25 welcome credits (granted or not), next expiry. OEM Launch: $675/month with 500 identifications a month included, credits from packs (no per-credit dollar value), period end and any pending downgrade. Both: card on file, auto-reload, identifications used this month. Card entry and plan changes happen in the Sqid console (link included).', { after_card : z.boolean().optional().describe('true right after the person saved a card on the add_card link: reads fresh from Stripe') }, async ({ after_card } = {}, t) => {
    // A card saved on the card link lands through Stripe's webhook; refresh drops the console's cached view first
    if(after_card){ await api(t, 'POST', '/api/sqid/billing/refresh', {}).catch(() => null); }
    let [overview, account, usage] = await Promise.all([api(t, 'GET', '/api/sqid/billing').catch(() => null), api(t, 'GET', '/api/sqid/billing/account').catch(() => null), api(t, 'GET', '/api/sqid/billing/usage').catch(() => null)]);
    return ok(billingView(overview, account, usage));
  });

  tool(server, 'add_card', 'A one-time, Stripe-hosted page where the person saves a card for their Sqid account, with no sign-in to the console. Returns the link (valid 30 minutes, works once). The card is entered only on Stripe\'s page, never in chat; the link can only save a card (no charge). On the Developer plan the first card brings 25 free welcome credits (once per person and per card). Account owner or billing admin only. After the person says the card is saved, get_billing_status with after_card: true confirms the card and credits.', {}, async (_, t) => {
    let r = await api(t, 'POST', '/api/sqid/billing/card-link', {});
    return ok({ url : r.url, expires_at : r.expires_at, account : r.account, note : 'Give the person this link. They enter the card on Stripe\'s page; nothing is charged. It works once and expires in 30 minutes.' },
      [{ tool : 'get_billing_status', when : 'after the person says the card is saved', args : { after_card : true } }]);
  }, WRITE);
}
