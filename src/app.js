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
import { mcpAuth, protectedResourceHandlerClerk, authServerMetadataHandlerClerk, streamableHttpHandler } from '@clerk/mcp-tools/hono';
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

  app.post('/mcp', mcpAuth(verify), streamableHttpHandler(createServer));
  app.all('/mcp', (c) => c.json({ error : 'method_not_allowed' }, 405));
  return app;
}
