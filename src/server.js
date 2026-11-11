// Node entry (local runs, containers). The Worker entry is src/worker.js.
import { serve } from '@hono/node-server';
import { createApp } from './app.js';

for(let k of ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'MCP_MACHINE_SECRET_KEY']){ if(!process.env[k]){ console.error(`Missing ${k}`); process.exit(1); } }
let port = Number(process.env.PORT || 8787);
serve({ fetch : createApp().fetch, port }, () => console.log(JSON.stringify({ message : 'sqid-mcp listening', port, resource : process.env.MCP_RESOURCE_URL || `http://localhost:${port}/mcp` })));
