import type { ArcadeSession } from '../session';
import { createEffectsBus, type EffectsSource } from './bus';
import { createImpactClock } from './feel';
import { HEADER } from '@/play/arcade/contract';
/** Read-only: cannot advance, pause, inject input or mutate the simulation. */
export function createRenderFeel(source:EffectsSource, now:()=>number=()=>performance.now()) {
  const clock=createImpactClock(), bus=createEffectsBus(source);
  let seen=source.state()[HEADER.tick]!;
  const off=bus.subscribe(events=>clock.observe(events,now()));
  const offState=source.subscribe(()=>{const tick=source.state()[HEADER.tick]!;if(tick<seen) clock.reset();seen=tick;});
  return { held:()=>clock.held(now()), flash:()=>clock.flash(now()), dispose:()=>{off();offState();bus.dispose();} };
}
const sessions=new WeakMap<ArcadeSession,ReturnType<typeof createRenderFeel>>();
/** Installed once by Effects, read by all scene draw callbacks. */
export function installRenderFeel(session:ArcadeSession):()=>void {
  const previous=sessions.get(session);previous?.dispose();
  const feel=createRenderFeel(session);sessions.set(session,feel);
  return ()=>{if(sessions.get(session)===feel){sessions.delete(session);feel.dispose();}};
}
export const renderHeld=(session:ArcadeSession):boolean=>sessions.get(session)?.held() ?? false;
