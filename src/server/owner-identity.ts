import {createHash,timingSafeEqual} from 'node:crypto';

type OwnerIdentity={kind:'disabled'}|{kind:'verified';key:string}|{kind:'untrusted'}|{kind:'misconfigured'};
/** Explicit opt-in for an authenticated reverse proxy. Never trust forwarded IPs.
 * Proxy must overwrite both headers and keep the application port private. */
export function proxyOwnerIdentity(request:Request,env:Record<string,string|undefined>=process.env):OwnerIdentity {
  const mode=env.WORLDSMITH_OWNER_IDENTITY;
  if(mode===undefined)return {kind:'disabled'};
  const secret=env.WORLDSMITH_OWNER_PROXY_SECRET;
  if(mode!=='trusted-proxy'||!secret||!/^[A-Za-z0-9_-]{32,256}$/.test(secret))return {kind:'misconfigured'};
  const supplied=request.headers.get('x-worldsmith-proxy-key'),owner=request.headers.get('x-worldsmith-owner');
  if(!supplied||supplied.length>256||!owner||!/^[A-Za-z0-9_.:@-]{1,128}$/.test(owner))return {kind:'untrusted'};
  const digest=(value:string)=>createHash('sha256').update(value).digest();
  if(!timingSafeEqual(digest(supplied),digest(secret)))return {kind:'untrusted'};
  return {kind:'verified',key:`proxy-owner:${digest(owner).toString('hex')}`};
}

/** Call before request body/provider work on every caller-authenticated mutation door. */
export function ownerIdentityRejection(request:Request,env:Record<string,string|undefined>=process.env):Response|null {
  const identity=proxyOwnerIdentity(request,env);
  if(identity.kind==='disabled'||identity.kind==='verified')return null;
  const status=identity.kind==='misconfigured'?503:403;
  return Response.json({error:{code:status===503?'OWNER_IDENTITY_UNAVAILABLE':'OWNER_IDENTITY_REQUIRED',message:status===503?'Owner identity is unavailable.':'A verified owner identity is required.'}},
    {status,headers:{'cache-control':'no-store'}});
}
