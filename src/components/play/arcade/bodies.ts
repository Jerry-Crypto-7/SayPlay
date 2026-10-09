/**
 * Seznam těl, která scéna kreslí (P28B T2). `spawn()` v jádře za běhu
 * zvyšuje `bodyCount` (střely, hody, doplňky) a mrtvý slot od `spawnBase`
 * přepíše jinou předlohou – seznam postavený jednou ze startu by nové tělo
 * nikdy nenakreslil. Scéna proto každý snímek zkontroluje `bodiesStale`
 * a při změně seznam postaví znovu.
 */

import { BODY, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { BEHAVIOURS } from '@/play/arcade/pieces/behaviours';

import type { ArcadeSession } from './session';

/**
 * Druhy těl průběhu P45C (chování a boss, i terč střelnice). Katalog pro ně model nemá – scéna je kreslí
 * modelem nepřítele ze specu (`cast.chaser`: pronásledovatel z věty, jinak nepřítel), vepsaným do kvádru těla,
 * takže boss je větší podle svého AABB.
 */
export const PACING_KINDS: ReadonlySet<string> = new Set(Object.values(BEHAVIOURS).map((behaviour) => behaviour.body.kind));

export interface BodyView {
  readonly index: number;
  readonly kind: string;
  readonly role: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

/**
 * Tělo, které scéna nekreslí: neviditelná branka poletování a holá role `thing` –
 * počítadlo komba (P36A T5, `withScoring` v `compile.ts`) nese druh hrdiny, takže
 * by scéna stahovala neexistující `player-lod1.glb`. Věci pravidel mají vlastní kód role od 32.
 * Počítadlo průběhu (`pacingKeeper`, P45C) nese druh hrdiny s rolí překážky: pozná se
 * podle velikosti 1 × 1 × 1 jednotka, jakou žádná věc scény nemá.
 */
export const drawsNothing = (view: Pick<BodyView, 'kind' | 'role' | 'w' | 'h' | 'd'>): boolean =>
  view.kind === 'gate' || view.role === ROLE.thing || Math.max(view.w, view.h, view.d) * UNIT <= 1;

const kindOf = (session: Pick<ArcadeSession, 'world'>, code: number): string => session.world.kinds[code] ?? 'crate';

export function bodiesOf(session: Pick<ArcadeSession, 'world' | 'state'>): readonly BodyView[] {
  const state = session.state();
  const count = state[HEADER.bodyCount] as number;
  const views: BodyView[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = bodyBase(index);
    views.push({
      index,
      kind: kindOf(session, state[base + BODY.kind] as number),
      role: state[base + BODY.role] as number,
      w: (state[base + BODY.w] as number) / UNIT,
      h: (state[base + BODY.h] as number) / UNIT,
      d: (state[base + BODY.d] as number) / UNIT,
    });
  }
  return views;
}

/** Stav má jiný počet těl, nebo spawn obsadil slot jiným druhem či rolí, než seznam kreslí. */
export function bodiesStale(views: readonly BodyView[], session: Pick<ArcadeSession, 'world' | 'state'>): boolean {
  const state = session.state();
  const count = state[HEADER.bodyCount] as number;
  if (count !== views.length) return true;
  for (let index = state[HEADER.spawnBase] as number; index < count; index += 1) {
    const base = bodyBase(index);
    const view = views[index] as BodyView;
    if (view.role !== state[base + BODY.role] || view.kind !== kindOf(session, state[base + BODY.kind] as number)) return true;
  }
  return false;
}
