/**
 * Seznam těl, která scéna kreslí (P28B T2). `spawn()` v jádře za běhu
 * zvyšuje `bodyCount` (střely, hody, doplňky) a mrtvý slot od `spawnBase`
 * přepíše jinou předlohou – seznam postavený jednou ze startu by nové tělo
 * nikdy nenakreslil. Scéna proto každý snímek zkontroluje `bodiesStale`
 * a při změně seznam postaví znovu.
 */

import { BODY, HEADER, ROLE, UNIT, bodyBase, isLogicBody } from '@/play/arcade/contract';
import { BEHAVIOURS } from '@/play/arcade/pieces/behaviours';

import type { ArcadeSession } from './session';

/**
 * Druhy těl průběhu P45C (chování a boss, i terč střelnice). Katalog pro ně model nemá – scéna je kreslí
 * modelem nepřítele ze specu (`cast.chaser`: pronásledovatel z věty, jinak nepřítel), vepsaným do kvádru těla,
 * takže boss je větší podle svého AABB.
 */
export const PACING_KINDS: ReadonlySet<string> = new Set(Object.values(BEHAVIOURS).map((behaviour) => behaviour.body.kind));

/**
 * Jiskra tepu sběru a útěku s věcmi (`HEARTBEAT_SPARK`, P47A T9): bonus, který věci hry nepočítají. Katalog model
 * nemá a model věci z věty by lhal, že se počítá – scéna arény ji kreslí vlastním tvarem (P47A T10).
 */
export const SPARK_KIND = 'spark';

/** Výstřely chování P45C (ostřelovač, salva bosse, terč střelnice) – katalog je nemá, scéna je kreslí jako střelu. */
export const PACING_SHOT_KINDS: ReadonlySet<string> = new Set(Object.values(BEHAVIOURS).flatMap((behaviour) => (behaviour.shot === undefined ? [] : [behaviour.shot.kind])));

export interface BodyView {
  readonly index: number;
  readonly kind: string;
  readonly role: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  /** Počítadlo dílu (`keeper` v parametrech ovládání, robota nebo pravidel): drží stav, ne věc scény. */
  readonly keeper?: boolean;
}

/**
 * Tělo, které scéna nekreslí: neviditelná branka poletování a holá role `thing` –
 * počítadlo komba (P36A T5, `withScoring` v `compile.ts`) nese druh hrdiny, takže
 * by scéna stahovala neexistující `player-lod1.glb`. Věci pravidel mají vlastní kód role od 32.
 * Logické tělo (P45B, `isLogicBody`) nese jen stav logiky, taky se nekreslí.
 * Počítadlo průběhu (`pacingKeeper`, P45C) nese druh hrdiny s rolí překážky: pozná se
 * podle velikosti 1 × 1 × 1 jednotka, jakou žádná věc scény nemá. Počítadla, která nesou
 * stav ve velikosti (P56B T3: 0,06 × 0 × 0 m u běžce), pozná `keeper` z parametrů dílů.
 */
export const drawsNothing = (view: Pick<BodyView, 'kind' | 'role' | 'w' | 'h' | 'd' | 'keeper'>): boolean =>
  view.keeper === true || view.kind === 'gate' || view.role === ROLE.thing || isLogicBody(view.role) || Math.max(view.w, view.h, view.d) * UNIT <= 1;

const kindOf = (session: Pick<ArcadeSession, 'world'>, code: number): string => session.world.kinds[code] ?? 'crate';

const keepersByWorld = new WeakMap<object, ReadonlySet<number>>();

/** Indexy těl, na která ukazuje parametr `keeper` kdekoli v ovládání, robotovi a pravidlech světa. */
function keepersOf(world: ArcadeSession['world']): ReadonlySet<number> {
  const known = keepersByWorld.get(world);
  if (known !== undefined) return known;
  const keepers = new Set<number>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'keeper' && typeof inner === 'number') keepers.add(inner);
        else walk(inner);
      }
    }
  };
  walk([world.control, world.bot, world.rules]);
  keepersByWorld.set(world, keepers);
  return keepers;
}

export function bodiesOf(session: Pick<ArcadeSession, 'world' | 'state'>): readonly BodyView[] {
  const state = session.state();
  const count = state[HEADER.bodyCount] as number;
  const keepers = keepersOf(session.world);
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
      ...(keepers.has(index) ? { keeper: true } : {}),
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
