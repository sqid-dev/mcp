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
  let { data, text } = await readBody(res);
  if(res.status === 401){ cache.delete(userId); throw new UpstreamError(401, 'unauthorized', 'Sqid did not accept the MCP server’s machine token for this person.'); }
  if(res.status === 403 && data?.clerk_error?.reason === 'reverification-error'){ throw new UpstreamError(403, 'console_only', 'This action needs a fresh second factor and is only available in the console.'); }
  if(!res.ok){ throw new UpstreamError(res.status, data?.error || `http_${res.status}`, data?.message || data?.error || text || `${method} ${path} failed (${res.status})`); }
  return data;
}

// Bodies are read as text first: some routes answer errors in plain text (e.g. the public API's
// enrichment: 400 "Not enough credits"), and a valid JSON body may be the literal `false`.
export async function readBody(res){
  let text = ''; try{ text = await res.text(); }catch(e){ /* no body */ }
  let data = null; try{ data = text ? JSON.parse(text) : null; }catch(e){ data = null; }
  return { data, text : (text || '').trim().slice(0, 300) };
}

// The public API's plain-text refusals, as stable codes and a reason a person can act on.
const PUBLIC_REASONS = {
  'Not enough credits'            : ['no_credits', 'Not enough credits. Add credits or turn on auto-reload in the Sqid console (https://app.sqid.dev/billing).'],
  'Not available on sandbox SDKs' : ['sandbox_not_supported', 'Enrichment is not available on the Sandbox (it only has made-up people). Use a real site.'],
  'VID off'                       : ['identification_off', 'Identification is turned off for this site on Sqid’s side. Contact Sqid support.'],
  'Inactive subscription'         : ['subscription_inactive', 'The account’s plan is not active. Check billing in the Sqid console.'],
  'Reached custom limit'          : ['limit_reached', 'This site has reached its identification limit.']
};

export async function publicApi(key, method, path, body){
  let res = await fetch(cfg.SQID_PUBLIC_API + path, {
    method,
    headers : { authorization : `Bearer ${key}`, accept : 'application/json', 'user-agent' : 'sqid-mcp', ...(body ? { 'content-type' : 'application/json' } : {}) },
    body    : body ? JSON.stringify(body) : undefined
  });
  let { data, text } = await readBody(res);
  if(res.status === 429){ throw new UpstreamError(429, 'rate_limited', data?.message || 'Rate limit exceeded. Wait a moment and retry.'); }
  if(!res.ok){
    let reason = data?.message || data?.error || text;
    let known = PUBLIC_REASONS[reason];
    if(known){ throw new UpstreamError(res.status, known[0], known[1]); }
    throw new UpstreamError(res.status, `http_${res.status}`, reason || `${method} ${path} failed (${res.status})`);
  }
  return data;
}
