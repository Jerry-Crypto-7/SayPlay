import {describe,it,expect} from 'vitest';
import {proxyOwnerIdentity,ownerIdentityRejection} from '../owner-identity';
import {trustedCallerKey} from '../rate-limit';
const secret='FIXTURE_ONLY_NOT_A_REAL_SECRET_000000000000';
const env={WORLDSMITH_OWNER_IDENTITY:'trusted-proxy',WORLDSMITH_OWNER_PROXY_SECRET:secret};
const request=(owner='user-1',key=secret)=>new Request('http://fixture.invalid',{headers:{'x-worldsmith-owner':owner,'x-worldsmith-proxy-key':key,'x-forwarded-for':'victim','x-vercel-forwarded-for':'victim'}});
describe('explicit authenticated proxy owner identity',()=>{
  it('keeps three authenticated principals separate and ignores caller forwarding chains',()=>{
    const keys=['user-1','user-2','user-3'].map(owner=>trustedCallerKey(request(owner),env));
    expect(new Set(keys).size).toBe(3);expect(keys.every(key=>key?.startsWith('proxy-owner:'))).toBe(true);
    expect(keys.join()).not.toContain(secret);expect(keys.join()).not.toContain('user-1');
    expect(ownerIdentityRejection(request(),env)).toBeNull();
  });
  it.each(['wrong-key','',secret+',other'])('rejects spoofed or ambiguous proxy authorization: %s',key=>{
    expect(proxyOwnerIdentity(request('victim',key),env).kind).toBe('untrusted');
    expect(ownerIdentityRejection(request('victim',key),env)?.status).toBe(403);
    expect(trustedCallerKey(request('victim',key),{...env,VERCEL:'1'})).toBe('proxy-owner:unverified');
  });
  it.each(['','one,two','a'.repeat(129),'user/../../other'])('rejects invalid principal %s',owner=>{
    expect(ownerIdentityRejection(request(owner),env)?.status).toBe(403);
  });
  it('fails closed on incomplete/unknown mode without leaking configuration values',async()=>{
    for(const override of [{WORLDSMITH_OWNER_IDENTITY:'typo'},{WORLDSMITH_OWNER_PROXY_SECRET:''}]) {
      const response=ownerIdentityRejection(request(),{...env,...override})!;
      expect(response.status).toBe(503);expect(await response.text()).not.toContain(secret);
    }
    expect(proxyOwnerIdentity(request(),{}).kind).toBe('disabled');
    expect(trustedCallerKey(request(),{})).toBeNull();
  });
});
