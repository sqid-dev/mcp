import { createApp, RESOURCE_URL } from './app.js';

for(let k of ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'MCP_MACHINE_SECRET_KEY']){ if(!process.env[k]){ console.error(`Missing ${k}`); process.exit(1); } }
let app = await createApp();
let port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(JSON.stringify({ message : 'sqid-mcp listening', port, resource : RESOURCE_URL })));
