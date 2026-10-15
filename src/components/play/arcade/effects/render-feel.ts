import type { ArcadeSession } from '../session';
import { createEffectsBus, type EffectsSource } from './bus';
import { createImpactClock, reducedMotion } from './feel';
import { HEADER, nativeRule } from '@/play/arcade/contract';
/**
 * Read-only: cannot advance, pause, inject input or mutate the simulation.
 * „Méně pohybu“ (`reduced`, P46C T4): hit-stop 0 a zpomalení 1× – kresba ani efekty se nezaškubnou.
 */
export function createRenderFeel(source:EffectsSource, now:()=>number=()=>performance.now(), reduced:()=>boolean=reducedMotion) {
  const clock=createImpactClock(), bus=createEffectsBus(source);
  // Výhra hry s finále průběhu (`pacing` s `finale`) je poslední vteřina finále.
  const finale=nativeRule(source.world?.rules ?? [],'pacing')?.params.finale !== undefined;
  let seen=source.state()[HEADER.tick]!;
  const off=bus.subscribe(events=>clock.observe(events,now(),finale));
  const offState=source.subscribe(()=>{const tick=source.state()[HEADER.tick]!;if(tick<seen) clock.reset();seen=tick;});
  return { held:()=>clock.held(now(),reduced()), flash:()=>clock.flash(now()), timeScale:()=>clock.timeScale(now(),reduced()), dispose:()=>{off();offState();bus.dispose();} };
}
const sessions=new WeakMap<ArcadeSession,ReturnType<typeof createRenderFeel>>();
/** Installed once by Effects, read by all scene draw callbacks. */
export function installRenderFeel(session:ArcadeSession):()=>void {
  const previous=sessions.get(session);previous?.dispose();
  const feel=createRenderFeel(session);sessions.set(session,feel);
  return ()=>{if(sessions.get(session)===feel){sessions.delete(session);feel.dispose();}};
}
export const renderHeld=(session:ArcadeSession):boolean=>sessions.get(session)?.held() ?? false;
/** Rychlost času efektů (zpomalení po pádu bosse a na konci finále); bez instalace 1. */
export const renderTimeScale=(session:ArcadeSession):number=>sessions.get(session)?.timeScale() ?? 1;
