// Calls to the Sqid console API, as the person who authorized the MCP client: the
// request's own access token is forwarded. Nothing is stored server-side.

export const SQID_API    = process.env.SQID_API || 'https://app.sqid.dev';
export const PUBLIC_API  = process.env.SQID_PUBLIC_API || 'https://app.asksquid.ai/api/v1';

export class UpstreamError extends Error {
  constructor(status, code, message){ super(message || code); this.status = status; this.code = code; }
}

export async function api(token, method, path, body){
  let res = await fetch(SQID_API + path, {
    method,
    headers : { authorization : `Bearer ${token}`, accept : 'application/json', 'user-agent' : 'sqid-mcp', ...(body ? { 'content-type' : 'application/json' } : {}) },
    body    : body ? JSON.stringify(body) : undefined
  });
  let data = null; try{ data = await res.json(); }catch(e){ /* not json */ }
  if(res.status === 401){ throw new UpstreamError(401, 'unauthorized', 'Sqid did not accept the token. Reconnect the MCP server.'); }
  if(res.status === 403 && data?.clerk_error?.reason === 'reverification-error'){ throw new UpstreamError(403, 'console_only', 'This action needs a fresh second factor and is only available in the console.'); }
  if(!res.ok){ throw new UpstreamError(res.status, data?.error || `http_${res.status}`, data?.message || data?.error || `${method} ${path} failed (${res.status})`); }
  return data;
}

export async function publicApi(key, method, path, body){
  let res = await fetch(PUBLIC_API + path, {
    method,
    headers : { authorization : `Bearer ${key}`, accept : 'application/json', 'user-agent' : 'sqid-mcp', ...(body ? { 'content-type' : 'application/json' } : {}) },
    body    : body ? JSON.stringify(body) : undefined
  });
  let data = null; try{ data = await res.json(); }catch(e){ /* not json */ }
  if(!res.ok){ throw new UpstreamError(res.status, data?.error || `http_${res.status}`, data?.message || data?.error || `${method} ${path} failed (${res.status})`); }
  return data;
}
