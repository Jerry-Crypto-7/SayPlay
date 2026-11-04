import { type ArcadeWorld, BODY, FLAG, HEADER, ROLE, bodyBase } from '@/play/arcade/contract';
import type { VisualEvent } from './bus';

/**
 * Váha událostí (P36C T7): kolik trvá hit-stop, blikání po zásahu, zpomalení
 * a přiblížení výhry a ztmavnutí prohry. Čisté funkce času kresby (ms) – scény
 * je čtou ve `useFrame`, do stavu hry ani hashe nepíšou nic.
 *
 * „Méně pohybu“ (`prefers-reduced-motion`) vypne zpomalení, přiblížení i otřes
 * a od P46C T4 i hit-stop (zaškubnutí kresby je pohyb); blikání a ztmavnutí zůstávají.
 */

/** Hit-stop: kresba stojí tolik ms po zásahu – v aréně (`FightFx.tsx`) i mimo ni. */
export const HIT_STOP_MS = 60;

/** Délka hit-stopu (ms); s „méně pohybu“ žádný. */
export const hitStopMs = (reduced: boolean): number => (reduced ? 0 : HIT_STOP_MS);

/** Zpomalení po pádu bosse a v poslední vteřině finále (P46C T4): rychlost efektů na `SLOW_MO_MS`. */
export const SLOW_MO_MS = 400;
export const SLOW_MO_SCALE = 0.4;

/** Rychlost času efektů `ms` po pádu bosse nebo konci finále; s „méně pohybu“ vždy 1. */
export const slowMoScale = (ms: number, reduced: boolean): number => (reduced || ms < 0 || ms >= SLOW_MO_MS ? 1 : SLOW_MO_SCALE);

/**
 * Blikání hrdiny po zásahu (ms) a perioda (ms). Jádro této větve nezranitelnost
 * nevystavuje; po sloučení P36A (`graceOf`) délku určí milost hráče.
 */
export const BLINK_MS = 600;
const BLINK_PERIOD_MS = 120;

/** Výhra: zpomalení efektů (podíl rychlosti) na `WIN_SLOW_MS` a přiblížení kamery. */
export const WIN_SLOW_MS = 500;
export const WIN_SLOW_SCALE = 0.3;
export const WIN_ZOOM = 1.18;

/** Prohra: scéna se odbarví a ztmaví za tolik ms (CSS `data-fx="lose"` v `play.css`). */
export const LOSE_FADE_MS = 600;

/** Největší posun kamery při otřesu po zásahu hráče (m). */
export const SHAKE_M = 0.14;

/** Stojí kresba `ms` po zásahu? S „méně pohybu“ nikdy. */
export const hitStopHeld = (ms: number, reduced = false): boolean => ms >= 0 && ms < hitStopMs(reduced);

/** Je hrdina `ms` po zásahu zrovna zhasnutý? Bliká až po hit-stopu, ve stoje by zmizel celý. */
export function blinkHidden(ms: number): boolean {
  const since = ms - HIT_STOP_MS;
  return since >= 0 && since < BLINK_MS && Math.floor(since / (BLINK_PERIOD_MS / 2)) % 2 === 0;
}

/** Rychlost času efektů `ms` po výhře: první půl sekundy zpomaleně, s „méně pohybu“ vždy 1. */
export const winTimeScale = (ms: number, reduced: boolean): number => (reduced || ms < 0 || ms >= WIN_SLOW_MS ? 1 : WIN_SLOW_SCALE);

/** Přiblížení kamery `ms` po výhře: náběh za `WIN_SLOW_MS` (ease-out), pak drží do restartu. Bez výhry je `ms` +∞. */
export function winZoom(ms: number, reduced: boolean): number {
  if (reduced || ms < 0 || ms === Infinity) return 1;
  const t = Math.min(1, ms / WIN_SLOW_MS);
  return 1 + (WIN_ZOOM - 1) * (1 - (1 - t) ** 3);
}

/** Výchylka otřesu (m) z doznívání 0..1; s „méně pohybu“ nula. */
export const shakeAmount = (shake: number, reduced: boolean): number => (reduced ? 0 : shake * shake * SHAKE_M);

/**
 * Násobič komba z efektů tiku. Jádro P36A vydá `{ kind: 'combo', multiplier }`
 * (P36A T5); tahle větev ho ještě nemá, odezva „×N“ na něj čeká.
 */
export function comboOf(effects: readonly { readonly kind: string }[]): number | null {
  let best: number | null = null;
  for (const effect of effects) {
    const multiplier = (effect as { readonly multiplier?: unknown }).multiplier;
    if (effect.kind === 'combo' && typeof multiplier === 'number' && multiplier > 1) best = Math.max(best ?? 0, multiplier);
  }
  return best;
}

let motionQuery: { readonly source: Window['matchMedia']; readonly list: MediaQueryList } | null = null;

/**
 * Prostředí bez `matchMedia` (server, testy v node) je bez přání „méně pohybu“. Dotaz se staví
 * jednou na `matchMedia` a jeho `matches` sleduje nastavení živě: hračkový pohyb se ptá každý
 * snímek za každé tělo a nový dotaz pokaždé stál telefon (Pixel 7, CPU 4×) ~0,6 ms snímku (P54B T15c).
 */
export const reducedMotion = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  if (motionQuery?.source !== window.matchMedia) motionQuery = { source: window.matchMedia, list: window.matchMedia('(prefers-reduced-motion: reduce)') };
  return motionQuery.list.matches;
};

/** Červený okraj obrazovky po ztrátě života (P70D T4, `data-hurt` v `play.css`), ms. */
export const HURT_EDGE_MS = 450;
/** Nejvýš tolik „+1“ nad sebranými věcmi naráz (P70D T4). */
export const POP_CAP = 4;

/**
 * Šťáva z dávky událostí sběrnice (P70D T4): zásah hráče (ubraný život) rozsvítí červený okraj, sebrané věci
 * vyskočí „+1“ (nejvýš `POP_CAP`). Otřes, částice, konfety a zvuk dávají sběrnice a `Effects` už samy.
 */
export function juiceOf(events: readonly VisualEvent[]): { readonly hurt: boolean; readonly pops: readonly VisualEvent[] } {
  return { hurt: events.some((event) => event.kind === 'hit' && event.role === ROLE.player), pops: events.filter((event) => event.kind === 'pickup').slice(0, POP_CAP) };
}

/** Strop částic: s „méně pohybu“ polovina (P70D T4). */
export const particleCap = (cap: number, reduced: boolean): number => (reduced ? Math.floor(cap / 2) : cap);

/**
 * Visual-only impact clock; accepts the bus's validated hit, never score/spawn.
 * Hit-stop po zásahu (i akcí), zpomalení po pádu bosse a s `finale` i po výhře –
 * výhra hry s finále je jeho poslední vteřina (P46C T4).
 */
export function createImpactClock() {
  let at = -Infinity;
  let slowAt = -Infinity;
  return {
    observe(events: readonly Pick<VisualEvent, 'kind'>[], now: number, finale = false): void {
      if (events.some(event => event.kind === 'hit' || event.kind === 'ability')) at = now;
      if (events.some(event => event.kind === 'bossDefeat' || (finale && event.kind === 'win'))) slowAt = now;
    },
    held: (now: number, reduced = false): boolean => hitStopHeld(now - at, reduced),
    flash: (now: number): number => Math.max(0, 1 - Math.max(0, now - at) / 120),
    timeScale: (now: number, reduced = false): number => slowMoScale(now - slowAt, reduced),
    reset: (): void => { at = -Infinity; slowAt = -Infinity; },
  };
}

/** Actual lateral slip, not a steering-button animation. */
export const skidStrength = (vx: number, vz: number, grounded: boolean): number =>
  grounded && Math.abs(vz) >= 40 ? Math.min(1, Math.max(0, (Math.abs(vx) - 24) / 100)) : 0;

export interface ThreatCue { readonly body: number; readonly x: number; readonly y: number; readonly z: number; readonly radius: number; readonly urgency: number }
/** Closest approach within 0.8 s, in actual XYZ. Works for every movement/control. */
export function threatTelegraphs(state: Int32Array, world: Pick<ArcadeWorld, 'rules'>): readonly ThreatCue[] {
  let player = state[HEADER.player]!;
  const ball = world.rules.some(rule => rule.id === 'ball_score');
  if (ball) {
    player = -1;
    for(let i=0;i<state[HEADER.bodyCount]!;i++) if((state[bodyBase(i)+BODY.flags]! & (FLAG.alive|FLAG.physics|FLAG.ball)) === (FLAG.alive|FLAG.physics|FLAG.ball)) { player=i;break; }
    if(player<0) return [];
  }
  const roles = new Set<number>();
  for(const rule of world.rules) {
    if(rule.id === 'hit' && (rule.params.effect === 'damage' || rule.params.effect === 'lose')) {
      const code = ROLE[rule.params.role as keyof typeof ROLE];
      if(code !== undefined) roles.add(code);
    }
  }
  const arena = world.rules.some(rule => rule.id === 'arena_eat');
  const p = bodyBase(player);
  const result: ThreatCue[] = [];
  for (let body = 0; body < state[HEADER.bodyCount]!; body += 1) {
    if (body === player) continue;
    const b = bodyBase(body), role = state[b + BODY.role]!;
    if (!(state[b + BODY.flags]! & FLAG.alive)) continue;
    const arenaThreat = arena && (role === ROLE.chaser || role === ROLE.enemy && state[b+BODY.w]! > state[p+BODY.w]!);
    const keeper = ball && role === ROLE.enemy && (state[b+BODY.flags]! & (FLAG.kinematic|FLAG.solid)) === (FLAG.kinematic|FLAG.solid);
    if(!roles.has(role) && !arenaThreat && !keeper) continue;
    const dx = state[b + BODY.x]! - state[p + BODY.x]!;
    const dy = state[b + BODY.y]! - state[p + BODY.y]!;
    const dz = state[b + BODY.z]! - state[p + BODY.z]!;
    const vx = state[b + BODY.vx]! - state[p + BODY.vx]!;
    const vy = state[b + BODY.vy]! - state[p + BODY.vy]!;
    const vz = state[b + BODY.vz]! - state[p + BODY.vz]!;
    const speed2 = vx*vx + vy*vy + vz*vz;
    const time = speed2 === 0 ? 0 : Math.max(0, Math.min(48, -(dx*vx + dy*vy + dz*vz) / speed2));
    const radius = Math.max(state[b + BODY.w]!, state[b + BODY.d]!) / 2 + Math.max(state[p + BODY.w]!, state[p + BODY.d]!) / 2;
    const miss = Math.hypot(dx + vx*time, dz + vz*time);
    if (Math.abs(dy + vy*time) > (state[b + BODY.h]! + state[p + BODY.h]!) || miss > radius + 800 || Math.hypot(dx,dy,dz) > 18000) continue;
    // Receding threats outside overlap need no warning.
    if (dx*vx + dy*vy + dz*vz >= 0 && Math.hypot(dx,dz) > radius + 800) continue;
    result.push({body, x:state[b+BODY.x]!, y:state[b+BODY.y]!, z:state[b+BODY.z]!, radius, urgency:1-time/60});
  }
  return result.sort((a,b) => b.urgency-a.urgency || a.body-b.body).slice(0,16);
}
