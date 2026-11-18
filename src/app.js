// The Hono app, runnable as a Cloudflare Worker (src/worker.js) or on Node (src/server.js).
// Clerk (clerk.sqid.dev) is the OAuth authorization server; this is a resource server at
// MCP_RESOURCE_URL. Clients discover that through /.well-known/oauth-protected-resource,
// obtain a token with aud = MCP_RESOURCE_URL, and call POST /mcp (Streamable HTTP). The
// token is verified here and goes no further: tools act upstream with the server's own
// machine credential (see upstream.js).

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env as runtimeEnv } from 'hono/adapter';

// Bindings on Workers (c.env), process.env on Node; tests pass bindings through app.request's third argument.
const env = (c) => ({ ...(typeof process !== 'undefined' && process.env ? process.env : {}), ...(runtimeEnv(c) || {}), ...(c.env || {}) });
// Bindings are read straight off c.env: spreading the env object can lose non-plain bindings.
const binding = (c, name) => c.env?.[name] ?? runtimeEnv(c)?.[name];
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { protectedResourceHandlerClerk, authServerMetadataHandlerClerk, streamableHttpHandler } from '@clerk/mcp-tools/hono';
import { registerTools } from './tools.js';
import { setMinter, configure } from './upstream.js';

const SCOPES = ['profile', 'email'];

// The server instructions: a short router (clients cap them at 4,096 characters; the critical part first).
// The step-by-step setup script lives in the `setup` prompt; facts the model acts on come back from get_started.
export const INSTRUCTIONS = `Sqid identifies the people visiting a website and tells you who they are.

Setup: when someone wants to set up, try or install Sqid (or anything like it), call get_started first, then follow the flow of the setup prompt (/sqid:setup): ask what they want Sqid to do before anything else ((a) see who visits their website, (b) add identification to a product they sell to other businesses, (c) just see it work; default (c)). Ask one multiple-choice question at a time, never ask what you can detect (sign-in, plan, sites, the site URL and framework of an open project), say what will change before any write, and match explanations to how technical the person seems. If Sqid is already on the site or in the project, check it with get_site_status instead of creating another. Never change a plan without an explicit yes, and never ask for a card, password or key in chat.

Identification first: knowing who is on the site is the main outcome. list_visitors reads identified visitors on demand; add_webhook with event "identification" (the default) delivers each one's full record, preview_webhook shows the exact payload and test_webhook sends a sample. Moments (set_signals, add_webhook event "moment") are optional, for agents that react to intent, and never the default path.

Sandbox: a test site where every new visitor becomes one of 50 made-up people. It never spends credits, never produces moments, and enrichment is refused there. A new test person: the console's Forget identity on a Test profile, or \`await squid.anonymouse()\` in the browser console and reload (a private window usually lands on the same person). get_started returns the Playground (a demo site on the Sandbox) and what it shows.

Install: the snippet comes from create_site or get_snippet, never hand-written, and goes before </head> on every page. get_site_status confirms the stream is live. Page-side personalisation: new squid.engine() in the browser, https://docs.sqid.dev/sdk/engine.`;

const SETUP_SCRIPT = `Set up Sqid for me as a short guided walkthrough. Follow this flow.

Rules for the whole walkthrough:
- One question at a time, multiple choice, always with a default ("say 'not sure' and I'll pick ..."). Phrase it so the client can show it as a multiple-choice question. At most 3 questions before the first real step.
- Never ask what you can detect. get_started gives sign-in, plan and sites. If a project is open, look before asking: the site URL (package.json "homepage", env vars like SITE_URL or NEXT_PUBLIC_SITE_URL, vercel.json, CNAME, wrangler config), the framework, and the layout file where </head> lives.
- Already set up? If get_started shows a site for this address, or the open project already has Sqid (a .sqid.json file, or "app.asksquid.ai/tfs/" in a layout), do not create another site or paste a second snippet: say what you found, check it with get_site_status, and continue from whatever is missing.
- Before any write (creating a site, editing a file, adding a webhook, changing origins), say in one line what will change, naming the file for a code edit. After each step, one line saying what happened.
- Never ask for a card number, password or key in chat. Cards go in the console; sign-in happens in the browser. If someone pastes a key, do not use it and tell them to delete it in the console.
- Match my level. A framework project open and technical wording: terse and code-first. No project or plain wording ("my website"): plain language, explain a term once the first time (for example "a webhook, meaning Sqid sends each identified visitor to a web address you own"), make the code edits yourself, and show visitors in chat with list_visitors before suggesting a webhook. Ask "Will you be writing code, or should I handle it?" only if the signals conflict.
- Never hand-write the snippet. Never upgrade a plan or add a card for me; those need my explicit yes and happen in the console.

1. Call get_started. Then open with exactly this shape, filling the lines from its result (account.plan_line, account.sites_line; never invent credits or prices):
"You're signed in to Sqid. {plan line} {sites line} One question to pick the right path: what do you want Sqid to do?
 (a) Show me who's visiting my website
 (b) Add visitor identification to a product I sell to other businesses
 (c) Just let me see it work first
Say 'not sure' and I'll start with (c)."

2. (a) My own website (path own_site)
 - Which site: if you found a URL in the project, ask "I found {host} in this project. Set that up?" (yes / another site). If not, ask "Which website should we start with? You can add more later."
 - If a website project is open, go straight to the real site. If not, ask "What is your website built with?" (WordPress / Shopify / Squarespace / Wix / Webflow / something else or not sure / I'd rather try a test version first). The test version is the Playground, as in (c).
 - Real site: create_site with the name and URL (it adds the www. or bare twin of the address itself). Put the snippet before </head>: edit the layout file yourself if the project is open; on a website builder, give that builder's steps from https://docs.sqid.dev/sdk/installation#on-a-website-builder, one step per line, and wait while they paste and publish. Add any other address the site runs on (staging, a second domain) with set_site_origins (it adds by default).
 - Credits: a real site identifies visitors only with credits. If get_started shows no card on file, say: "One more step: Sqid needs a card on file to identify visitors on a real site. Adding one gives you 25 free credits; nothing is charged unless you buy credits or turn on auto-reload." Give billing.add_card_url (it opens the card form; Stripe takes the card, never this chat) and wait for me. Then get_billing_status confirms the card and the 25 credits. If I'd rather not yet, carry on and list it as the next thing to do.
 - Outcome by level: for a developer, add_webhook (event identification) to their endpoint, then preview_webhook so they see the payload, test_webhook to send one. For a non-developer, list_visitors first to show who has visited; a webhook only if they have somewhere to receive it.
 - Finish with get_site_status after the site is deployed and opened once.
 - Plan: recommend, don't ask. Developer fits: pay as you go, $0.25 per identified visitor, 25 free welcome credits once a card is added (get_billing_status shows whether they were granted).

3. (b) Embed in a product I sell (path embed_oem)
 - Ask "Roughly how many customer sites will use it?" (1 to 10 / 10 to 100 / more than 100 or custom terms).
 - Recommend: 1 to 100: OEM Launch, $675/month with 500 identifications a month included, then credit packs (1,000 for $200, 5,000 for $900, 10,000 for $1,700, 25,000 for $4,000). More than 100 or custom terms: Enterprise, a custom plan; talk to us at help@asksquid.ai. Suggest seeing it work in the Sandbox first.
 - The upgrade happens in the console's Billing page (or \`sqid plan set oem --accept-terms\`, which accepts the OEM Launch addendum), account owner only, card required. Never upgrade without my explicit yes; give me the link instead.
 - Then the same site steps as (a) for my first customer site or the Sandbox, and point me at https://docs.sqid.dev for the API and embedding.

4. (c) Just let me see it work (path just_try)
 - Before it opens, tell me what I'll see (get_started's playground.what_youll_see): I appear as an anonymous visitor, then as a person within a couple of seconds.
 - Run the Playground in the background: npx -y @sqid-dev/playground. Tell me to open http://localhost:3000 and watch the panel on the right: it shows "Anonymous", then a name, title and company. It uses my sign-in and the Sandbox and spends no credits.
 - Sandbox facts if they come up: every new visitor becomes one of 50 made-up people; no credits, no moments, no enrichment. A new test person: the console's Forget identity, or \`await squid.anonymouse()\` and reload (a private window usually lands on the same person).
 - After: offer "Put Sqid on my site", which goes to (a). (The panel's own "Put Sqid on my site" button does the same in the browser.)

5. End with this checklist, ticking only what actually happened (get_site_status decides the last line):
 Signed in to Sqid
 Site set up
 Snippet added
 Card added (25 free credits)   (real site only; the Sandbox needs none)
 Visitors showing, or webhook wired
 Stream is live
Then at most two next things to do, if anything is pending (usually: publish the site and open it once). Close with how to come back: "Ask me 'is Sqid working?' any time, or run /sqid:setup again." `;

// MCP prompts: user-invocable starting points (Claude Code shows them as /sqid:setup etc.).
function registerPrompts(server){
  server.registerPrompt('setup', {
    title : 'Set up Sqid',
    description : 'Guided setup: asks what you want Sqid to do (see who visits your site, embed it in a product, or just see it work), then walks through one path one step at a time.',
    argsSchema : {}
  }, () => ({ messages : [{ role : 'user', content : { type : 'text', text : SETUP_SCRIPT } }] }));
}
const resourceUrl = (e) => e.MCP_RESOURCE_URL || `http://localhost:${e.PORT || 8787}/mcp`;

function createServer(){
  let server = new McpServer({ name : 'sqid', version : '0.1.0' }, { instructions : INSTRUCTIONS });
  registerTools(server);
  registerPrompts(server);
  return server;
}

// Verify with Clerk: an OAuth token issued by our instance, aud = this server.
export async function clerkVerify(token, c){
  const { createClerkClient } = await import('@clerk/backend');
  const { verifyClerkToken } = await import('@clerk/mcp-tools/server');
  let e = env(c);
  let clerk = createClerkClient({ secretKey : e.CLERK_SECRET_KEY, publishableKey : e.CLERK_PUBLISHABLE_KEY });
  let request = new Request(c.req.url, { method : c.req.method, headers : { authorization : `Bearer ${token}` } });
  let state = await clerk.authenticateRequest(request, { acceptsToken : 'oauth_token', audience : resourceUrl(e) });
  let auth = state.toAuth();
  if(!auth?.isAuthenticated){ return undefined; }
  return verifyClerkToken(auth, token);
}

// Rate limits (Workers Rate Limiting bindings; absent on Node, where this is a no-op).
// Unauthenticated hits are limited per IP before any work; authenticated calls per person.
async function limited(rl, key){
  if(!rl || !key){ return false; }
  try{ let { success } = await rl.limit({ key }); return !success; }
  catch(error){ console.log('rate limit binding failed', String(error?.message || error)); return false; }
}
const tooMany = (c) => c.json({ error : 'rate_limited', error_description : 'Too many requests. Slow down and retry.' }, 429, { 'Retry-After' : '10' });

// Bearer auth for every method on /mcp. A missing or bad token gets 401 with the challenge
// the MCP spec asks for: where the resource metadata is, and which scopes to request.
function requireAuth(verify){
  return async (c, next) => {
    let e = env(c);
    let prm = `${new URL(resourceUrl(e)).origin}/.well-known/oauth-protected-resource/mcp`;
    let challenge = `Bearer resource_metadata="${prm}", scope="${SCOPES.join(' ')}"`;
    let ip = c.req.header('cf-connecting-ip') || 'unknown';
    if(await limited(binding(c, 'RL_IP'), ip)){ return tooMany(c); }
    let m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') || '');
    if(!m){ return c.json({ error : 'unauthorized', error_description : 'Bearer token required' }, 401, { 'WWW-Authenticate' : challenge }); }
    let info;
    try{ info = await verify(m[1], c); }catch(error){ info = undefined; }
    if(!info){ return c.json({ error : 'invalid_token' }, 401, { 'WWW-Authenticate' : `${challenge}, error="invalid_token"` }); }
    let missing = SCOPES.filter(sc => Array.isArray(info.scopes) && info.scopes.length && !info.scopes.includes(sc));
    if(missing.length){ return c.json({ error : 'insufficient_scope' }, 403, { 'WWW-Authenticate' : `${challenge}, error="insufficient_scope"` }); }
    if(await limited(binding(c, 'RL_USER'), info.extra?.userId || info.userId || ip)){ return tooMany(c); }
    c.set('mcpAuth', info);
    await next();
  };
}

export function createApp({ verify = clerkVerify, mint } = {}){
  if(mint){ setMinter(mint); }
  let app = new Hono();
  // Upstream config comes from bindings on Workers, from process.env on Node.
  app.use('*', async (c, next) => { configure(env(c)); await next(); });
  app.use('*', cors({ origin : '*', exposeHeaders : ['WWW-Authenticate'], allowHeaders : ['Authorization', 'Content-Type', 'Mcp-Session-Id', 'Mcp-Protocol-Version'] }));

  app.get('/', (c) => c.json({ name : 'sqid-mcp', mcp : resourceUrl(env(c)), docs : 'https://docs.sqid.dev' }));
  app.get('/alive', (c) => c.json({ ok : true }));
  app.get('/.well-known/oauth-protected-resource', (c) => protectedResourceHandlerClerk({ resource : resourceUrl(env(c)), scopes_supported : SCOPES })(c));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => protectedResourceHandlerClerk({ resource : resourceUrl(env(c)), scopes_supported : SCOPES })(c));
  app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);

  // Auth on every method: an unauthenticated GET gets the same 401 challenge as a POST.
  // After auth the transport answers GET/DELETE itself (405 in stateless mode).
  app.on(['POST', 'GET', 'DELETE'], '/mcp', requireAuth(verify), streamableHttpHandler(createServer));
  return app;
}
