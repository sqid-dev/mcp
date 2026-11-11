# sqid MCP server

Sqid for AI editors and agents over the Model Context Protocol: the same actions as
the [`sqid` CLI](https://github.com/sqid-dev/cli), served as tools. Hosted, Streamable
HTTP, OAuth through Sqid's own sign-in. No API keys to paste.

```
claude mcp add --transport http sqid https://mcp.sqid.dev/mcp
```

The first call opens a browser to sign in to Sqid and approve the connection. After
that the agent can create a site, get the snippet, wire webhooks, list identified
visitors, enrich_contact a contact, read moments and billing, as the person who approved it.

## Tools

| Tool | Does |
|---|---|
| `get_started` | The guided entry point: starts the free plan if needed, returns the Sandbox site with its snippet, real sites, and the two paths (Sandbox first, or a real website) |
| `whoami` | Who approved the connection, role, plan present |
| `list_sites`, `create_site`, `set_site_origins`, `get_snippet`, `get_site_status` | Sites, their allowed origins, the install snippet, the "stream is live" check |
| `add_webhook` (default event `identification`), `list_webhooks`, `preview_webhook`, `test_webhook` | Where identified visitors (or moments, pages, clicks) are delivered |
| `list_visitors`, `get_visitor` | Identified visitors on demand |
| `enrich_contact` | Email, phone or LinkedIn URL to a full record |
| `get_signals_status`, `set_signals`, `list_moments` | Signals state, on or off, recent moments |
| `get_billing_status` | Plan, card, balance, this month |

Card entry and plan changes are not tools. They happen in the console or the CLI.

Every tool carries MCP annotations: reads are `readOnlyHint: true`, the five that change
things (`get_started`, `create_site`, `set_site_origins`, `add_webhook`, `test_webhook`, `enrich_contact`, `set_signals`) are not, and
nothing is marked destructive because no tool deletes. Clients such as Claude Code use
these to decide what needs a confirmation.

## Guided setup

The server ships one MCP prompt, `setup` (`/sqid:setup` in Claude Code). It calls
`get_started`, asks one question (try the Sandbox first, or set up the real website),
walks that path one tool at a time, and ends with the five-line checklist: signed in,
site provisioned, script added, webhook wired, stream live. Saying "set up Sqid" without
the prompt gets the same flow, because the server instructions tell Claude to start with
`get_started`.

## How auth works

Clerk (the instance behind app.sqid.dev) is the OAuth authorization server. This server is
a resource server at `MCP_RESOURCE_URL`, per the MCP authorization spec: clients discover it
through `/.well-known/oauth-protected-resource`, register as public clients (Client ID
Metadata Documents, with dynamic registration as fallback), obtain a token whose audience
is that URL with PKCE, and send it on every `POST /mcp`. A missing or bad token gets a 401
with a `WWW-Authenticate` challenge pointing at the metadata.

The client's token is verified here and goes no further. MCP forbids passing it upstream,
so for calls to app.sqid.dev the server is a Clerk machine (`sqid-mcp`) and mints its own
short-lived machine token whose claims name the verified person. The console admits that
machine and acts as that person, logged as such. Nothing is stored on this server beyond
those tokens in memory.

## Run

It is a Cloudflare Worker (`src/worker.js`, `wrangler.jsonc`), served at `mcp.sqid.dev`.
The same app also runs on Node (`src/server.js`) for local runs and tests.

```sh
npm install
npm test                       # offline: fake Sqid API, real MCP client
cp .env.example .dev.vars      # local secrets for wrangler dev (never committed)
npm run dev                    # wrangler dev on http://localhost:8787
npm run check                  # wrangler deploy --dry-run
npm run deploy                 # wrangler deploy
```

Secrets are set once per Worker and never live in the repo:

```sh
wrangler secret put CLERK_PUBLISHABLE_KEY
wrangler secret put CLERK_SECRET_KEY
wrangler secret put MCP_MACHINE_SECRET_KEY
```

Health: `GET /alive`. Logs: `wrangler tail`.

## Registering with Clerk

1. Clerk dashboard, Agents, MCP servers: add `MCP_RESOURCE_URL` and allow public clients to
   connect. Clerk then issues tokens with that audience and shows the consent screen.
2. Clerk dashboard, Configure, Machines: create a machine `sqid-mcp`; its secret key is
   `MCP_MACHINE_SECRET_KEY`; its id goes into the console's `clerk.mcpMachineIds`.

MIT
