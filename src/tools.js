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

const siteRow = (p) => ({ id : String(p._id), name : p.name, origins : p.site_origins || p.origins || undefined, enabled : p.enabled !== false, deployed : !!p.state?.deployed, connected : !!p.state?.connected, sandbox : !!p.sandbox, owner : p.owner?.email || null });

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

const TITLES = {"get_started": "Get started", "set_site_origins": "Set site origins", "list_sites": "List sites", "create_site": "Create site", "get_site_status": "Site status", "get_snippet": "Get snippet", "add_webhook": "Add webhook", "list_webhooks": "List webhooks", "preview_webhook": "Preview webhook payload", "test_webhook": "Test webhook", "list_visitors": "List visitors", "get_visitor": "Get visitor", "enrich_contact": "Enrich contact", "get_signals_status": "Signals status", "set_signals": "Set Signals", "list_moments": "List moments", "get_billing_status": "Billing status", "whoami": "Who am I"};

function tool(server, name, description, schema, fn, annotations = READ){
  server.registerTool(name, { title : TITLES[name] || name, description, inputSchema : schema, annotations : { title : TITLES[name] || name, ...annotations } }, async (args, extra) => {
    try{ return await fn(args || {}, userOf(extra), extra); }
    catch(error){ return fail(error); }
  });
}

export function registerTools(server){
  tool(server, 'whoami', 'The account that authorized this connection: email, role, whether it has a plan.', {}, async (_, t) => ok(await api(t, 'GET', '/api/sqid/me')));

  tool(server, 'get_started', 'The first call when someone says "set up Sqid": makes sure the account has a plan (starts the free Developer plan if not, which also creates a Sandbox site), then returns the account state, the Sandbox site with its snippet, any real sites, and the two paths to offer: try the Sandbox first, or set up a real website.', {}, async (_, t) => {
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
    return ok({
      account : { email : me.email, plan_started_now : !!started, plan : started?.plan || (me.account?.hasSubscription ? 'existing' : null) },
      sandbox : sandbox ? { ...sandbox, snippet : snippetFor(sandbox.id), origins_set : (sandbox.origins || []).length > 0, note : 'The Sandbox is a test site: events flow, each visitor gets a made-up identity, nothing is charged, nothing reaches a real data source. It starts with no allowed origins: call set_site_origins with the local or staging URL (e.g. http://localhost:3000) before the snippet will load there.' } : null,
      sites : real,
      paths : [
        { id : 'sandbox', title : 'Try it in the Sandbox first', steps : ['no page to paste into, or they just want to see it: run "npx -y @sqid-dev/playground" (demo site + Sqid panel on localhost:3000, uses the Sandbox, no credits) and point them at the panel', 'otherwise ask for the local or staging URL and call set_site_origins on the Sandbox with it', 'get_snippet for the Sandbox site, paste it in that page, open the page', 'add_webhook to a public https endpoint (any catcher works), preview_webhook to see the payload, test_webhook to send one', 'get_site_status to confirm the Sandbox connected'] },
        { id : 'website', title : 'Set up a real website', steps : ['create_site with the site name and public URL', 'paste the snippet before </head> in the layout and deploy', 'ask which outcome they want: identified visitors (add_webhook, default), on-demand visitors (list_visitors), moments to an agent (set_signals + add_webhook event moment), or browser personalisation', 'get_site_status after the first visit: the stream is live'] }
      ]
    }, [
      { tool : 'get_snippet', when : 'to try the Sandbox', args : sandbox ? { site_id : sandbox.id } : undefined },
      { tool : 'create_site', when : 'to set up a real website' }
    ]);
  }, WRITE);

  tool(server, 'list_sites', 'Sites on the account (id, name, deployed, connected, sandbox).', {}, async (_, t) => ok(await sites(t), [{ tool : 'get_snippet', when : 'to get a site’s install snippet' }]));

  tool(server, 'create_site', 'Create a site for a web app and return its install snippet. Starts the free Developer plan first if the account has none.', {
    name : z.string().min(1).max(50).describe('Site name, e.g. the app name'),
    origins : z.array(z.string().url()).min(1).describe('Public origins the snippet will run on, e.g. ["https://example.com"]')
  }, async ({ name, origins }, t) => {
    let me = await api(t, 'GET', '/api/sqid/me');
    let started = null;
    if(!me.account?.hasSubscription){ started = await api(t, 'POST', '/api/sqid/billing/start', {}); }
    let o = origins.map(u => new URL(u).origin);
    let existing = (await sites(t)).find(s => !s.sandbox && s.name?.toLowerCase() === name.toLowerCase());
    let id = existing?.id;
    if(!id){ let created = await api(t, 'POST', '/api/projects', { name, site_origins : o, product_origins : o, avatar_index : 1 }); id = String(created?._id || created?.id); }
    return ok({ site : { id, name, origins : o }, reused_existing : !!existing, plan_started : started?.plan || undefined, snippet : snippetFor(id), paste : 'The snippet goes before </head> on every page of the site.' }, [
      { tool : 'add_webhook', when : 'to be told who each identified visitor is (event identification, the default)' },
      { tool : 'add_webhook', when : 'to send visitor intent moments to an agent (event moment)' },
      { tool : 'get_site_status', when : 'after the snippet is deployed and the site opened once' }
    ]);
  }, WRITE);

  tool(server, 'set_site_origins', 'Set the allowed origins of a site: the URLs the snippet may load on, e.g. ["https://example.com"] or, for the Sandbox, ["http://localhost:3000"]. Replaces the list.', { ...siteArg, origins : z.array(z.string().url()).min(1) }, async ({ site_id, origins }, t) => {
    let s = await site(t, site_id);
    let o = origins.map(u => new URL(u).origin);
    let r = await api(t, 'PATCH', `/api/projects/${s.id}`, { name : s.name, site_origins : o, product_origins : o });
    return ok({ site : { id : s.id, name : s.name }, origins : o, result : r?.site_origins ? undefined : r }, [{ tool : 'get_snippet', when : 'to get the snippet for this site', args : { site_id : s.id } }]);
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

  tool(server, 'add_webhook', 'Create a webhook endpoint on a site. Events: "identification" (default; the full record of each identified visitor), "moment" (Signals intent moments), "page" (page views), "click" (tracked clicks). The endpoint must be a public https URL. Payload shapes: https://docs.sqid.dev/console/webhooks', {
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

  tool(server, 'test_webhook', 'Send a sample delivery to an endpoint now and return what it answered.', { ...siteArg, webhook_id : z.string() }, async ({ site_id, webhook_id }, t) => {
    let s = await site(t, site_id);
    let hooks = await api(t, 'GET', `/api/sqid/sdks/${s.id}/webhooks`); let w = (Array.isArray(hooks) ? hooks : hooks?.webhooks || []).find(h => h.id === webhook_id);
    if(!w){ throw new UpstreamError(404, 'webhook_not_found', 'No such webhook on this site.'); }
    let ev = { v2 : /\.v2$/.test(w.namespace) };
    let r = await api(t, 'POST', `${base(s.id, ev)}/webhook/test`, { webhook_id });
    return ok({ delivered : !!r?.response?.success, status : r?.response?.status ?? null, request : r?.request?.payload, response : r?.response?.data });
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

  tool(server, 'enrich_contact', 'Look a person up by email, phone or LinkedIn URL (exactly one) and return the enriched record. Uses an SDK key for the site, created on first use ("MCP").', { ...siteArg, email : z.string().email().optional(), phone : z.string().optional(), linkedin_url : z.string().url().optional(), force : z.boolean().optional() }, async ({ site_id, email, phone, linkedin_url, force }, t) => {
    if([email, phone, linkedin_url].filter(Boolean).length !== 1){ throw new UpstreamError(400, 'usage', 'Pass exactly one of email, phone, linkedin_url.'); }
    let s = await site(t, site_id);
    let keys = await api(t, 'GET', `/api/sdks/${s.id}/tokens`); let list = Array.isArray(keys) ? keys : keys?.tokens || [];
    let key = list.find(k => k.name === 'MCP' && k.jwt)?.jwt || (await api(t, 'POST', `/api/sdks/${s.id}/tokens`, { name : 'MCP' }))?.jwt;
    return ok(await publicApi(key, 'POST', '/visitors/enrichment', { ...(email ? { email } : phone ? { phone } : { linkedin_url }), ...(force ? { forceUpdate : true } : {}) }));
  }, WRITE);

  tool(server, 'get_signals_status', 'Whether Signals (intent moments) is on for a site, with the account-level state and allowance. Read only.', siteArg, async ({ site_id }, t) => {
    let s = await site(t, site_id);
    let st = await api(t, 'GET', '/api/sqid/signals/settings');
    let mine = (st?.sdks || []).find(x => String(x.id || x.sdk_id) === s.id) || null;
    return ok({ site : s, enabled : !!mine?.enabled, effective : mine?.effective || mine?.state || (mine?.enabled ? 'on' : 'off'), setting : mine, account : st?.account || null, allowance : st?.allowance || null }, mine?.enabled ? [] : [{ tool : 'set_signals', when : 'with enabled true to start producing moments' }]);
  });

  tool(server, 'set_signals', 'Turn Signals (intent moments) on or off for a site. On also starts variant-picker tracking in the SDK (sizes, colors, plans; feeds the choosing_options moment). get_signals_status reads the current state.', { ...siteArg, enabled : z.boolean() }, async ({ site_id, enabled }, t) => {
    let s = await site(t, site_id);
    return ok({ site : s, enabled, result : await api(t, 'PATCH', `/api/sqid/sdks/${s.id}/signals`, { enabled }) }, enabled ? [{ tool : 'add_webhook', when : 'with event "moment" to receive them' }] : []);
  }, WRITE);

  tool(server, 'list_moments', 'Recent Signals moments (what the engine decided about visitors). Filter by decision (engage|wait|quiet) and kind or group.', { ...siteArg, decision : z.enum(['engage', 'wait', 'quiet']).optional(), kind : z.string().optional(), all_sites : z.boolean().optional(), limit : z.number().int().min(1).max(50).optional() }, async ({ site_id, decision, kind, all_sites, limit }, t) => {
    let q = new URLSearchParams(); if(!all_sites){ q.set('sdk', (await site(t, site_id)).id); } if(decision){ q.set('decision', decision); } if(kind){ q.set('kind', kind); } if(limit){ q.set('limit', String(limit)); }
    let r = await api(t, 'GET', `/api/sqid/moments?${q}`);
    return ok({ moments : r?.events || [], next_cursor : r?.next || null, kinds : r?.kinds });
  });

  tool(server, 'get_billing_status', 'Plan, card on file, balance, auto-reload and this month’s identifications. Read only; card entry and plan changes are done in the Sqid console.', {}, async (_, t) => {
    let [overview, account, usage] = await Promise.all([api(t, 'GET', '/api/sqid/billing'), api(t, 'GET', '/api/sqid/billing/account').catch(() => null), api(t, 'GET', '/api/sqid/billing/usage').catch(() => null)]);
    let card = (overview?.cards || []).find(c => c.default) || overview?.cards?.[0] || null;
    return ok({ plan : overview?.plan ?? null, card : card ? { brand : card.brand, last4 : card.last4 } : null, balance : account?.balance ?? null, auto_reload : account?.auto_reload ?? null, usage : usage?.identifications?.totals ? { month : usage.month, ...usage.identifications.totals } : null, add_card_url : card ? undefined : 'https://app.sqid.dev/billing' });
  });
}
