// Cloudflare Worker entry. Secrets (CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY,
// MCP_MACHINE_SECRET_KEY) come from `wrangler secret put`; the rest from wrangler.jsonc vars.
import { createApp } from './app.js';
const app = createApp();
export default { fetch : (request, env, ctx) => app.fetch(request, env, ctx) };
