# sqid MCP server

Sqid for AI editors and agents over the Model Context Protocol: the same actions as
the [`sqid` CLI](https://github.com/sqid-dev/cli), served as tools. Hosted, Streamable
HTTP, OAuth through Sqid's own sign-in. No API keys to paste.

```
claude mcp add --transport http sqid https://mcp.sqid.dev/mcp
```

The first call opens a browser to sign in to Sqid and approve the connection. After
that the agent can create a site, get the snippet, wire webhooks, list identified
visitors, enrich a contact, read moments and billing, as the person who approved it.

## Tools

| Tool | Does |
|---|---|
| `whoami` | Who approved the connection, role, plan present |
| `sites_list`, `site_create`, `snippet_get`, `site_status` | Sites, the install snippet, the "stream is live" check |
| `webhook_add` (default event `identification`), `webhook_list`, `webhook_preview`, `webhook_test` | Where identified visitors (or moments, pages, clicks) are delivered |
| `visitors_list`, `visitor_get` | Identified visitors on demand |
| `enrich` | Email, phone or LinkedIn URL to a full record |
| `signals_set`, `moments_list` | Signals on or off, recent moments |
| `billing_status` | Plan, card, balance, this month |

Card entry and plan changes are not tools. They happen in the console or the CLI.

## How auth works

Clerk (the instance behind app.sqid.dev) is the OAuth authorization server. This server is
a resource server at `MCP_RESOURCE_URL`. Clients discover that through
`/.well-known/oauth-protected-resource`, obtain a token whose audience is that URL, and
send it on every `POST /mcp`. The server verifies the token with Clerk and forwards it to
app.sqid.dev; nothing is stored here.

## Run

```sh
cp .env.example .env     # Clerk keys, MCP_RESOURCE_URL, SQID_API
npm install
npm start                 # or: npm run dev
npm test                  # offline: fake Sqid API, real MCP client
```

Docker: `docker build -t sqid-mcp . && docker run --env-file .env -p 8787:8787 sqid-mcp`.
Health: `GET /alive`.

## Registering with Clerk

In the Clerk dashboard, Agents, MCP servers, add `MCP_RESOURCE_URL` and allow public
clients to connect. Clerk then issues tokens with that audience and shows the consent
screen for this server.

MIT
