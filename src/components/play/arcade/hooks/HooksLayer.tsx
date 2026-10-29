'use client';

/**
 * Vrstva háčků nad plátnem (P66 T4), jediné místo, kde `ArcadeStage` háčky připojí: létající skóre (`ScorePop`),
 * hláška (`Callout`), banner kola (`RoundBanner`), karty vylepšení (`UpgradePick`) a pilulka nálezu
 * (`RarityToast`). Všechno ze zpráv háčků tiku (`onHookEffects` v `effects/bus.ts`) – jen DOM a čas kresby,
 * do stavu, záznamu ani hashe nic nepíše; vstup volby jde přes relaci jako každý jiný stisk. Hra bez háčků
 * (`genre.v5`) zprávy nemá a vrstva nevykreslí nic. Restart relace (tik zpět) ji vyprázdní.
 *
 * Výjimka mimo zprávy jádra (T11): přebitý rekord nebo výzvu kamaráda za běhu pošle `ArcadePlay` jako `cheer`
 * a vrstva ji ohlásí hláškou jednou za běh – i ve hře bez háčků (vrstva visí nad každou arkádou, která běží).
 */

import { useEffect, useRef, useState } from 'react';

import { ARCADE_LIMITS } from '@/play/arcade/contract';
import type { HookEffect, UpgradeId } from '@/play/arcade/hooks/contract';

import type { BestCheer } from '../../best';
import { onHookEffects } from '../effects/bus';
import { runnerPathOf } from '../runner/path';
import type { ArcadeSession } from '../session';
import { CALLOUT_MS, Callout, type ShownCallout, calloutOf, showCallout } from './Callout';
import { type FoundRarity, RARITY_TOAST_MS, RarityToast, type ShownFind } from './RarityToast';
import { ROUND_BANNER_MS, RoundBanner, type ShownRound, roundStartOf } from './RoundBanner';
import { POP_MS, type Pop, type PopSeed, ScorePops, addPops, popSeedsOf } from './ScorePop';
import { UpgradePick } from './UpgradePick';

declare global {
  interface Window {
    /** Sonda e2e vrstvy háčků (`e2e/p66-hooks.spec.ts`). */
    __playHooks?: HooksProbe;
  }
}

export interface HooksProbe {
  /** Kolik zpráv háčků vrstva od připojení dostala, po druzích. */
  seen(): Partial<Record<HookEffect['kind'], number>>;
  /** Poslední zpráva druhu `kind`, nebo `null`. */
  last(kind: HookEffect['kind']): HookEffect | null;
  /**
   * Od tiku 0 dohraje záznam robota ověřovače „rukou“ (lidský běh jako `handPlay` sondy `__playShell`), dokud
   * nepřijde zpráva `kind`; vrací tik po ní, nebo `null`, když běh skončil dřív. Dál hraje hráč.
   */
  playUntil(kind: HookEffect['kind']): number | null;
}

export interface HooksView {
  readonly pops: readonly Pop[];
  readonly callout: ShownCallout | null;
  readonly round: ShownRound | null;
  /** Nabídka do `upgrade_pick`; `key` postaví karty znovu u další nabídky. */
  readonly offer: { readonly cards: readonly UpgradeId[]; readonly key: number } | null;
  readonly toast: ShownFind | null;
  /** Vzácné a epické nálezy běhu pro pilulku (jen obraz; počty pro výsledek drží stav jádra). */
  readonly found: Readonly<Record<FoundRarity, number>>;
  /** Přebitý cíl HUD (rekord, výzva) už v tomhle běhu hlášku dostal (T11); restart ho vrátí s celým obrazem. */
  readonly cheered: boolean;
}

export const NO_HOOKS: HooksView = { pops: [], callout: null, round: null, offer: null, toast: null, found: { rare: 0, epic: 0 }, cheered: false };

/** Hláška přebitého cíle (P66 T11) jednou za běh: další přebití téhož běhu (body klesly a znovu stouply) nic neohlásí. */
export function cheerView(view: HooksView, cheer: BestCheer, now: number, key: number): HooksView {
  return view.cheered ? view : { ...view, cheered: true, callout: showCallout(view.callout, cheer, now, key) };
}

/** Co z tiku vrstva potřebuje: zprávy a popy s polohou přečtenou hned (relace pole stavu přepisuje). */
export interface HookTick {
  readonly effects: readonly HookEffect[];
  readonly pops: readonly PopSeed[];
}

export const hookTickOf = (effects: readonly HookEffect[], state: Int32Array, bend?: Parameters<typeof popSeedsOf>[2]): HookTick => ({ effects, pops: popSeedsOf(effects, state, bend) });

/** Obraz po tiku se zprávami v čase kresby `now`; zprávy v pořadí, jak je jádro vydalo. */
export function nextView(view: HooksView, tick: HookTick, now: number, nextKey: () => number): HooksView {
  let { callout, round, offer, toast, found } = view;
  const id = calloutOf(tick.effects);
  if (id !== null) callout = showCallout(callout, id, now, nextKey());
  const start = roundStartOf(tick.effects);
  if (start !== null) round = { ...start, at: now, key: nextKey() };
  for (const effect of tick.effects) {
    if (effect.kind === 'upgrade_offer') offer = { cards: effect.offer, key: nextKey() };
    else if (effect.kind === 'upgrade_pick') offer = null;
    else if (effect.kind === 'rare_found') {
      found = { ...found, [effect.rarity]: found[effect.rarity] + 1 };
      toast = { rarity: effect.rarity, count: found[effect.rarity], at: now, key: nextKey() };
    }
  }
  const pops = tick.pops.length > 0 ? addPops(view.pops, tick.pops, now, nextKey) : view.pops;
  return { ...view, pops, callout, round, offer, toast, found };
}

/** Zhasne, co dohořelo; beze změny vrátí týž obraz (React nepřekreslí). */
export function pruneView(view: HooksView, now: number): HooksView {
  const pops = view.pops.filter((pop) => now - pop.at < POP_MS);
  const callout = view.callout !== null && now - view.callout.at >= CALLOUT_MS ? null : view.callout;
  const round = view.round !== null && now - view.round.at >= ROUND_BANNER_MS ? null : view.round;
  const toast = view.toast !== null && now - view.toast.at >= RARITY_TOAST_MS ? null : view.toast;
  if (pops.length === view.pops.length && callout === view.callout && round === view.round && toast === view.toast) return view;
  return { ...view, pops, callout, round, toast };
}

/** Kdy obraz tiku zhasíná (ms): pro každý kus, který tik přinesl. */
function fadesOf(tick: HookTick): number[] {
  const kinds = new Set(tick.effects.map((effect) => effect.kind));
  const fades: number[] = [];
  if (tick.pops.length > 0) fades.push(POP_MS);
  if (kinds.has('callout') || kinds.has('boss_enter')) fades.push(CALLOUT_MS);
  if (kinds.has('round_start')) fades.push(ROUND_BANNER_MS);
  if (kinds.has('rare_found')) fades.push(RARITY_TOAST_MS);
  return fades;
}

/** Obraz vrstvy; hra bez zpráv háčků nemá ani jeden prvek. */
export function HookScreen({ view, session }: { readonly view: HooksView; readonly session: Pick<ArcadeSession, 'press'> }) {
  return (
    <>
      <ScorePops pops={view.pops} />
      <Callout callout={view.callout} />
      <RoundBanner banner={view.round} />
      <RarityToast toast={view.toast} />
      {view.offer !== null && <UpgradePick key={view.offer.key} session={session} offer={view.offer.cards} />}
    </>
  );
}

export function HooksLayer({ session, cheer = null }: { readonly session: ArcadeSession; readonly cheer?: BestCheer | null }) {
  const [view, setView] = useState<HooksView>(NO_HOOKS);
  // Klíče nástupů jedna řada pro zprávy háčků i hlášku rekordu: táž hodnota by u nové hlášky nepřehrála nástup.
  const keys = useRef(0);
  // Rekord nebo výzva přebité za běhu (T11, `cheerOf` v `ArcadePlay`): hláška jednou za běh, pak zhasne jako ostatní.
  useEffect(() => {
    if (cheer === null) return;
    const key = (keys.current += 1);
    setView((current) => cheerView(current, cheer, performance.now(), key));
    // Bez úklidu: časovač jen zhasne hlášku, i když body mezitím klesly pod cíl (`cheer` zpět na `null`).
    window.setTimeout(() => setView((current) => pruneView(current, performance.now())), CALLOUT_MS + 20);
  }, [cheer]);
  useEffect(() => {
    const nextKey = (): number => (keys.current += 1);
    const timers = new Set<number>();
    const bend = runnerPathOf(session.world) ?? undefined;
    const seen: Partial<Record<HookEffect['kind'], number>> = {};
    const last: Partial<Record<HookEffect['kind'], HookEffect>> = {};
    const prune = (): void => setView((current) => pruneView(current, performance.now()));
    const off = onHookEffects(
      session,
      (effects) => {
        for (const effect of effects) {
          seen[effect.kind] = (seen[effect.kind] ?? 0) + 1;
          last[effect.kind] = effect;
        }
        const tick = hookTickOf(effects, session.state(), bend);
        const now = performance.now();
        setView((current) => nextView(current, tick, now, nextKey));
        for (const ms of fadesOf(tick)) {
          const timer = window.setTimeout(() => {
            timers.delete(timer);
            prune();
          }, ms + 20);
          timers.add(timer);
        }
      },
      () => setView(NO_HOOKS),
    );
    const probe: HooksProbe = {
      seen: () => ({ ...seen }),
      last: (kind) => last[kind] ?? null,
      playUntil: (kind) => {
        const inputs = session.botInputs();
        const before = seen[kind] ?? 0;
        session.restart();
        let next = 0;
        while ((seen[kind] ?? 0) === before) {
          const now = session.snapshot();
          if (now.runState !== 'running' || now.tick >= ARCADE_LIMITS.maxTicks) return null;
          while (next < inputs.length && inputs[next]!.tick < now.tick) next += 1;
          const event = inputs[next]?.tick === now.tick ? inputs[next] : undefined;
          session.hold(event?.axis ?? 0);
          session.press(event?.buttons ?? 0);
          session.stepOnce();
        }
        session.hold(0);
        return session.snapshot().tick;
      },
    };
    window.__playHooks = probe;
    return () => {
      if (window.__playHooks === probe) delete window.__playHooks;
      off();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [session]);
  return <HookScreen view={view} session={session} />;
}
