// Calls to the Sqid console API on behalf of the person who authorized the MCP client.
// MCP forbids forwarding the client's token upstream, so this server never does: it is
// a Clerk machine ("sqid-mcp") and calls app.sqid.dev with its own short-lived M2M token
// whose claims name the verified person ({ acting_user: userId }). The console admits
// that machine (clerk.mcpMachineIds) and acts as that person. One token per person,
// cached until shortly before it expires. Nothing else is stored server-side.

// On Workers these arrive as bindings per request (configure(env)); on Node from process.env.
const cfg = { SQID_API : 'https://app.sqid.dev', SQID_PUBLIC_API : 'https://app.asksquid.ai/api/v1', CLERK_SECRET_KEY : undefined, MCP_MACHINE_SECRET_KEY : undefined };
export function configure(e = {}){ for(let k of Object.keys(cfg)){ if(e[k]){ cfg[k] = e[k]; } } }
if(typeof process !== 'undefined' && process.env){ configure(process.env); }
const TOKEN_TTL_S = 3600;

let _mint = null;                                     // (userId) => Promise<string>; injectable for tests
export function setMinter(fn){ _mint = fn; }

async function clerkMint(userId){
  const { createClerkClient } = await import('@clerk/backend');
  let clerk = createClerkClient({ secretKey : cfg.CLERK_SECRET_KEY });
  // JWT format: the console verifies it against Clerk's JWKS locally, no Clerk round trip per call.
  let t = await clerk.m2m.createToken({ machineSecretKey : cfg.MCP_MACHINE_SECRET_KEY, secondsUntilExpiration : TOKEN_TTL_S, tokenFormat : 'jwt', claims : { acting_user : userId } });
  return t.token;
}

const cache = new Map();                              // userId -> { token, exp }
export async function machineToken(userId){
  if(!userId){ throw new UpstreamError(401, 'unauthorized', 'No verified user on this request.'); }
  let hit = cache.get(userId);
  if(hit && hit.exp > Date.now() + 60_000){ return hit.token; }
  let token = await (_mint || clerkMint)(userId);
  cache.set(userId, { token, exp : Date.now() + TOKEN_TTL_S * 1000 });
  if(cache.size > 10_000){ cache.clear(); }
  return token;
}

export class UpstreamError extends Error {
  constructor(status, code, message){ super(message || code); this.status = status; this.code = code; }
}

export async function api(userId, method, path, body){
  let token = await machineToken(userId);
  let res = await fetch(cfg.SQID_API + path, {
    method,
    headers : { authorization : `Bearer ${token}`, accept : 'application/json', 'user-agent' : 'sqid-mcp', ...(body ? { 'content-type' : 'application/json' } : {}) },
    body    : body ? JSON.stringify(body) : undefined
  });
  let data = null; try{ data = await res.json(); }catch(e){ /* not json */ }
  if(res.status === 401){ cache.delete(userId); throw new UpstreamError(401, 'unauthorized', 'Sqid did not accept the MCP server’s machine token for this person.'); }
  if(res.status === 403 && data?.clerk_error?.reason === 'reverification-error'){ throw new UpstreamError(403, 'console_only', 'This action needs a fresh second factor and is only available in the console.'); }
  if(!res.ok){ throw new UpstreamError(res.status, data?.error || `http_${res.status}`, data?.message || data?.error || `${method} ${path} failed (${res.status})`); }
  return data;
}

export async function publicApi(key, method, path, body){
  let res = await fetch(cfg.SQID_PUBLIC_API + path, {
    method,
    headers : { authorization : `Bearer ${key}`, accept : 'application/json', 'user-agent' : 'sqid-mcp', ...(body ? { 'content-type' : 'application/json' } : {}) },
    body    : body ? JSON.stringify(body) : undefined
  });
  let data = null; try{ data = await res.json(); }catch(e){ /* not json */ }
  if(!res.ok){ throw new UpstreamError(res.status, data?.error || `http_${res.status}`, data?.message || data?.error || `${method} ${path} failed (${res.status})`); }
  return data;
}
