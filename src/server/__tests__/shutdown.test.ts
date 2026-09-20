import {afterEach,describe,it,expect,vi} from 'vitest';
import {beginServerDrain,resetServerDrainForTests,activeDrainStreamsForTests,registerStreamDrain} from '../shutdown';
import {openSession,clearSessions} from '@/worldstream/sessions';
import {sessionEventStream,streamedSessionCount,resetStreamSubscribers} from '@/app/api/worldstream/sessions/[sessionId]/events/route';
afterEach(()=>{resetServerDrainForTests();resetStreamSubscribers();clearSessions();vi.restoreAllMocks();});
describe('graceful session SSE drain',()=>{
 it('closes active controllers, releases slots and rejects admission without changing accepted state',async()=>{
  const stored=openSession('drain-fixture',1)!;const before=stored.session.snapshot();
  const responses=Array.from({length:4},()=>sessionEventStream('drain-fixture',stored,0,new AbortController().signal));
  expect(activeDrainStreamsForTests()).toBe(4);expect(streamedSessionCount()).toBe(1);
  const reads=responses.map(response=>response.text());beginServerDrain();beginServerDrain();
  await Promise.all(reads);expect(activeDrainStreamsForTests()).toBe(0);expect(streamedSessionCount()).toBe(0);
  expect(stored.session.snapshot()).toEqual(before);
  const rejected=sessionEventStream('drain-fixture',stored,0,new AbortController().signal);
  expect(rejected.status).toBe(503);expect((await rejected.json()).error.code).toBe('SERVER_DRAINING');
 });
 it('removes cancelled streams and installs at most one pair of process listeners',async()=>{
  const beforeTerm=process.listenerCount('SIGTERM'),beforeInt=process.listenerCount('SIGINT');
  const stored=openSession('cancel-fixture',2)!;const response=sessionEventStream('cancel-fixture',stored,0,new AbortController().signal);
  await response.body!.cancel();expect(activeDrainStreamsForTests()).toBe(0);expect(streamedSessionCount()).toBe(0);
  const a=registerStreamDrain(()=>{}),b=registerStreamDrain(()=>{});a();b();
  expect(process.listenerCount('SIGTERM')).toBeLessThanOrEqual(beforeTerm+1);expect(process.listenerCount('SIGINT')).toBeLessThanOrEqual(beforeInt+1);
  expect(activeDrainStreamsForTests()).toBe(0);
 });
});
