// The Express app. Clerk (clerk.sqid.dev) is the OAuth authorization server; this is a
// resource server at MCP_RESOURCE_URL. Clients discover that through
// /.well-known/oauth-protected-resource, obtain a token with aud = MCP_RESOURCE_URL,
// and call POST /mcp (Streamable HTTP). The token is verified here and goes no further:
// tools act upstream with the server's own machine credential (see upstream.js).

import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mcpAuth, protectedResourceHandlerClerk, authServerMetadataHandlerClerk, streamableHttpHandler } from '@clerk/mcp-tools/express';
import { registerTools } from './tools.js';
import { setMinter } from './upstream.js';

export const RESOURCE_URL = process.env.MCP_RESOURCE_URL || `http://localhost:${process.env.PORT || 8787}/mcp`;
const SCOPES = ['profile', 'email'];

function createServer(){
  let server = new McpServer({ name : 'sqid', version : '0.1.0' }, { instructions : 'Sqid identifies the people visiting a website. Start with sites_list (or site_create for a new app). The first-class outcome is knowing who is on the site: webhook_add with event "identification" (the default) or visitors_list on demand. Moments (event "moment") are for agents that react to intent. Use webhook_preview to see exact payloads before writing a handler, and site_status to confirm the stream is live. Never hand-write the install snippet; snippet_get returns it.' });
  registerTools(server);
  return server;
}

// Verify with Clerk: OAuth token issued by our instance, aud = this server.
export async function clerkVerify(token, req){
  const { createClerkClient } = await import('@clerk/backend');
  const { verifyClerkToken } = await import('@clerk/mcp-tools/server');
  let clerk = createClerkClient({ secretKey : process.env.CLERK_SECRET_KEY, publishableKey : process.env.CLERK_PUBLISHABLE_KEY });
  let url = new URL(req.originalUrl || req.url, `${req.protocol}://${req.get('host')}`);
  let request = new Request(url, { method : req.method, headers : { authorization : `Bearer ${token}` } });
  let state = await clerk.authenticateRequest(request, { acceptsToken : 'oauth_token', audience : RESOURCE_URL });
  let auth = state.toAuth();
  if(!auth?.isAuthenticated){ return undefined; }
  return verifyClerkToken(auth, token);
}

export async function createApp({ verify = clerkVerify, mint } = {}){
  if(mint){ setMinter(mint); }
  let app = express();
  app.set('trust proxy', true);
  app.use(cors({ exposedHeaders : ['WWW-Authenticate'] }));
  app.use(express.json({ limit : '1mb' }));

  app.get('/', (req, res) => res.json({ name : 'sqid-mcp', mcp : RESOURCE_URL, docs : 'https://docs.sqid.dev' }));
  app.get('/alive', (req, res) => res.json({ ok : true }));
  app.get('/.well-known/oauth-protected-resource', protectedResourceHandlerClerk({ resource : RESOURCE_URL, scopes_supported : SCOPES }));
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceHandlerClerk({ resource : RESOURCE_URL, scopes_supported : SCOPES }));
  app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk);

  let auth = await mcpAuth(verify);
  app.post('/mcp', auth, streamableHttpHandler(createServer));
  app.all('/mcp', (req, res) => res.status(405).json({ error : 'method_not_allowed' }));
  return app;
}
