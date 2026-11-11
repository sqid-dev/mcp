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

const INSTRUCTIONS = `Sqid identifies the people visiting a website and tells you who they are.
When someone says "set up Sqid" (or anything like it), call get_started first: it makes sure the account has a plan, creates a Sandbox site if needed, and returns two paths. Then ask the person one question: try it in the Sandbox first, or set up their real website? Walk that path step by step, one tool at a time, saying what each step did.
The first-class outcome is knowing who is on the site: add_webhook with event "identification" (the default) delivers each identified visitor's full record; list_visitors reads them on demand. Moments (set_signals, add_webhook event "moment") are for agents that react to intent. preview_webhook shows the exact payload before a handler is written; get_site_status confirms the stream is live. The install snippet comes from get_snippet or create_site; it goes before </head> on every page.`;

// MCP prompts: user-invocable starting points (Claude Code shows them as /sqid:setup etc.).
function registerPrompts(server){
  server.registerPrompt('setup', {
    title : 'Set up Sqid',
    description : 'Guided setup: starts the free plan if needed, offers the Sandbox or a real website, and walks through snippet, webhook and the live check.',
    argsSchema : {}
  }, () => ({ messages : [{ role : 'user', content : { type : 'text', text : `Set up Sqid for me. Do it as a short guided walkthrough:
1. Call get_started. Tell me in one line what the account state is (plan started now or already there, Sandbox present, real sites).
2. Ask me one question: do I want to try it in the Sandbox first, or set up my real website now? If I say website, ask for its public URL and a name if the project does not make it obvious.
3. Sandbox path: ask me for the local or staging URL where I will try it (e.g. http://localhost:3000), call set_site_origins on the Sandbox with it, then get_snippet for the Sandbox, show me the snippet and where it goes (before </head> on that page), then offer to wire a webhook to a catcher URL I give you, preview_webhook so I see the payload, test_webhook to send one, and get_site_status.
   Website path: create_site, show the snippet and tell me exactly where to paste it in my project (or paste it yourself if you can edit the code), then ask which outcome I want first: know who is visiting (add_webhook, identification is the default), see visitors on demand (list_visitors), send intent moments to an agent (set_signals then add_webhook with event moment), or personalise the page in the browser. Do that one step. Finish with get_site_status.
4. End with the checklist: Signed in to Sqid / Site provisioned / Script added to layout / Webhook wired -> <path> / Stream is live, marking only what actually happened, and tell me the one next thing to do if anything is still pending (usually: deploy and open the site once).
Keep each message short. One question at a time. Never hand-write the snippet.` } }] }));
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
