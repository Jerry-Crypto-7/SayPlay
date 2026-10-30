'use client';

/**
 * Létající skóre háčků (P66 T4): „+30“ nad tělem, za které body padly, ve vzácnosti sebrané věci (běžná inkoust,
 * vzácná modrozelená, epická slunečná – `play-hooks.css`, nic fialového). Jen DOM nad plátnem ze zpráv `score_pop`
 * jádra; stav ani hash nevidí. Naráz nejvýš `POP_MAX`, blízký mladý pop se přičte ke staršímu, ať se čísla
 * nevrší přes sebe.
 *
 * Poloha: pop nese temeno těla v metrech scény (`data-x/y/z`, x už zrcadlené jako částice v `particles.ts`),
 * na obrazovku ho promítá `PopAnchor` uvnitř plátna každý snímek – stejně jako `NameAnchor` popisek jména.
 */

import { useFrame } from '@react-three/fiber';
import { type RefObject, useMemo } from 'react';
import { Vector3 } from 'three';

import { type HookEffect, RARITY, type Rarity } from '@/play/arcade/hooks/contract';

import { bodyTopOf } from '../effects/bus';

/** Kolik popů visí naráz; nad tím odpadnou nejstarší. */
export const POP_MAX = 6;
/** Jak dlouho pop letí (ms, CSS `play-hook-pop`). */
export const POP_MS = 700;
/** Pop do tolika metrů od živého popu, který vznikl před méně než `POP_MERGE_MS`, se k němu přičte. */
export const POP_MERGE_M = 1.5;
export const POP_MERGE_MS = 300;
/** O kolik nad temenem těla pop vzlétne (m). */
const POP_LIFT_M = 0.3;

/** Co z tiku na pop přijde: body, vzácnost a temeno těla v metrech scény. */
export interface PopSeed {
  readonly amount: number;
  readonly rarity: Rarity;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Pop extends PopSeed {
  readonly id: number;
  /** Čas kresby (ms), kdy pop vznikl nebo se k němu naposled přičetlo. */
  readonly at: number;
}

const rank = (rarity: Rarity): number => RARITY.indexOf(rarity);

/**
 * Popy jednoho tiku ze zpráv `score_pop`; vzácnost dá `rare_found` téhož těla v témže tiku. Polohu čte ze stavu po
 * tiku hned (relace pole stavu přepisuje), `bend` je zakřivení trati běžce jako u částic (`Effects.tsx`).
 */
export function popSeedsOf(effects: readonly HookEffect[], state: Int32Array, bend?: (z: number) => { readonly x: number; readonly y: number } | undefined): PopSeed[] {
  const rarities = new Map<number, Rarity>();
  for (const effect of effects) if (effect.kind === 'rare_found') rarities.set(effect.body, effect.rarity);
  const seeds: PopSeed[] = [];
  for (const effect of effects) {
    if (effect.kind !== 'score_pop' || effect.amount <= 0) continue;
    const top = bodyTopOf(state, effect.body);
    const at = bend?.(top.z);
    seeds.push({ amount: effect.amount, rarity: rarities.get(effect.body) ?? 'common', x: -(top.x - (at?.x ?? 0)), y: top.y + (at?.y ?? 0) + POP_LIFT_M, z: top.z });
  }
  return seeds;
}

/** Nové popy do živých v čase `now`: dohořelé odpadnou, blízký mladý pop přičte, nad `POP_MAX` odpadnou nejstarší. */
export function addPops(live: readonly Pop[], fresh: readonly PopSeed[], now: number, nextId: () => number): Pop[] {
  const pops = live.filter((pop) => now - pop.at < POP_MS);
  for (const seed of fresh) {
    const near = pops.findIndex((pop) => now - pop.at < POP_MERGE_MS && Math.hypot(pop.x - seed.x, pop.y - seed.y, pop.z - seed.z) <= POP_MERGE_M);
    if (near >= 0) {
      const pop = pops[near]!;
      // Sloučený pop dostane nové id: React ho postaví znovu a let začne odznova i s novým součtem.
      pops[near] = { ...pop, id: nextId(), amount: pop.amount + seed.amount, rarity: rank(seed.rarity) > rank(pop.rarity) ? seed.rarity : pop.rarity, at: now };
    } else pops.push({ ...seed, id: nextId(), at: now });
  }
  return pops.slice(-POP_MAX);
}

export function ScorePops({ pops }: { readonly pops: readonly Pop[] }) {
  if (pops.length === 0) return null;
  return (
    <div className="play-hook-pops" aria-hidden="true">
      {pops.map((pop) => (
        <span key={pop.id} className="play-hook-pop" data-testid="hook-score-pop" data-rarity={pop.rarity} data-x={pop.x.toFixed(2)} data-y={pop.y.toFixed(2)} data-z={pop.z.toFixed(2)}>
          {`+${pop.amount.toLocaleString('en-US')}`}
        </span>
      ))}
    </div>
  );
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Promítne popy vrstvy háčků kamerou scény (dítě plátna, P66 T4). Pop za kamerou zhasne; jinak zůstane uvnitř
 * plátna a pod horním pásem HUD. Bez popů jen jeden dotaz do DOM za snímek.
 */
export function PopAnchor({ surface }: { readonly surface: RefObject<HTMLDivElement | null> }) {
  const at = useMemo(() => new Vector3(), []);
  useFrame(({ camera }) => {
    const layer = surface.current?.querySelector<HTMLElement>('.play-hook-pops');
    if (layer == null) return;
    for (const pop of layer.children) {
      if (!(pop instanceof HTMLElement)) continue;
      at.set(Number(pop.dataset.x), Number(pop.dataset.y), Number(pop.dataset.z)).project(camera);
      if (at.z > 1) {
        pop.style.visibility = 'hidden';
        continue;
      }
      pop.style.left = `${(clamp((at.x + 1) / 2, 0.06, 0.94) * 100).toFixed(1)}%`;
      pop.style.top = `${(clamp((1 - at.y) / 2, 0.14, 0.9) * 100).toFixed(1)}%`;
      pop.style.visibility = 'visible';
    }
  });
  return null;
}
