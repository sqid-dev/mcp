// The Hono app, runnable as a Cloudflare Worker (src/worker.js) or on Node (src/server.js).
// Clerk (clerk.sqid.dev) is the OAuth authorization server; this is a resource server at
// MCP_RESOURCE_URL. Clients discover that through /.well-known/oauth-protected-resource,
// obtain a token with aud = MCP_RESOURCE_URL, and call POST /mcp (Streamable HTTP). The
// token is verified here and goes no further: tools act upstream with the server's own
// machine credential (see upstream.js).

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from 'hono/adapter';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { protectedResourceHandlerClerk, authServerMetadataHandlerClerk, streamableHttpHandler } from '@clerk/mcp-tools/hono';
import { registerTools } from './tools.js';
import { setMinter, configure } from './upstream.js';

const SCOPES = ['profile', 'email'];
const resourceUrl = (e) => e.MCP_RESOURCE_URL || `http://localhost:${e.PORT || 8787}/mcp`;

function createServer(){
  let server = new McpServer({ name : 'sqid', version : '0.1.0' }, { instructions : 'Sqid identifies the people visiting a website. Start with sites_list (or site_create for a new app). The first-class outcome is knowing who is on the site: webhook_add with event "identification" (the default) or visitors_list on demand. Moments (event "moment") are for agents that react to intent. Use webhook_preview to see exact payloads before writing a handler, and site_status to confirm the stream is live. Never hand-write the install snippet; snippet_get returns it.' });
  registerTools(server);
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
async function limited(binding, key){
  if(!binding || !key){ return false; }
  try{ let { success } = await binding.limit({ key }); return !success; }catch(error){ return false; }
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
    if(await limited(e.RL_IP, ip)){ return tooMany(c); }
    let m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') || '');
    if(!m){ return c.json({ error : 'unauthorized', error_description : 'Bearer token required' }, 401, { 'WWW-Authenticate' : challenge }); }
    let info;
    try{ info = await verify(m[1], c); }catch(error){ info = undefined; }
    if(!info){ return c.json({ error : 'invalid_token' }, 401, { 'WWW-Authenticate' : `${challenge}, error="invalid_token"` }); }
    let missing = SCOPES.filter(sc => Array.isArray(info.scopes) && info.scopes.length && !info.scopes.includes(sc));
    if(missing.length){ return c.json({ error : 'insufficient_scope' }, 403, { 'WWW-Authenticate' : `${challenge}, error="insufficient_scope"` }); }
    if(await limited(e.RL_USER, info.extra?.userId || info.userId || ip)){ return tooMany(c); }
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
