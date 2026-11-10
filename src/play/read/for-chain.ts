/**
 * Co řetěz mikroher (P56C) dostane z věty (P56A T8): hrdina, protivník, věc, svět, slovesa a název. Jeden zdroj
 * pravdy – všechno kromě sloves je z návrhu téže věty (se čtením i bez něj), takže řetěz ukáže totéž, co hra.
 * Slovesa jsou ze čtení, bez něj hlavní sloveso klasifikátoru. Věta se tu nikdy nečte modelem podruhé.
 */

import { type LookId, lookOf } from '../arcade/look';
import { draftGameSpecWithMeta } from '../draft';
import { classifyGenre } from '../genre/classify';
import { castFor } from '../genre/contract';
import type { ControlId, GameSpecV1 } from '../spec';
import type { Reading, VerbClass } from './schema';

export interface SentenceRead {
  readonly hero: string;
  readonly foe: string | null;
  readonly item: string | null;
  readonly look: LookId;
  /** První je hlavní, nejvýš 4. */
  readonly verbs: readonly { readonly word: string; readonly class: VerbClass }[];
  readonly title: string;
  readonly source: 'llm' | 'lexicon';
}

/** Třída slovesa podle ovládání, které návrh zvolil (bez čtení); jako `CONTROL_OF` v `evals/play/read/measure.ts`, obráceně. */
const CLASS_OF_CONTROL: Readonly<Record<ControlId, VerbClass>> = {
  tap_go: 'tap_go', runner: 'runner', platform: 'platform', flap: 'flap', steer: 'steer', move_free: 'move_free',
  shooter: 'aim_shoot', throw: 'throw', timing: 'timing', rhythm: 'rhythm', duel: 'melee', glide: 'flap',
  walker: 'move_free', ball: 'throw', lanes: 'steer', hop: 'tap_go', crowd: 'steer', merge: 'manipulate', push: 'move_free',
  // P66 T2: kostry nových žánrů – pohyb po ploše, třídění a šipky jsou ruční práce s věcmi.
  survivor: 'move_free', hole: 'move_free', steal: 'move_free', sort: 'manipulate', arrows: 'manipulate',
  // P68 T1: kostry pěti her P68 – jízda náklonem, odpal jako hod, míření a střelba, stavba a kreslení rukou.
  stunt: 'steer', minigolf: 'throw', railfps: 'aim_shoot', buildshift: 'manipulate', drawsave: 'manipulate',
  // P83E: obchod – nést věci rukou na pult.
  shop: 'manipulate',
};

const roleOf = (spec: GameSpecV1, ...kinds: readonly GameSpecV1['roles'][number]['kind'][]): string | null =>
  spec.roles.find((role) => kinds.includes(role.kind))?.label ?? null;

/** simplified: staví celý návrh věty znovu (desítky ms); až ho řetěz bude mít po ruce, ať ho předá místo věty. */
export function readForChain(sentence: string, reading: Reading | null): SentenceRead {
  const { spec, genre } = draftGameSpecWithMeta(sentence, 1, { reading });
  const verb = reading === null ? classifyGenre(sentence, null).verb : null;
  return {
    hero: roleOf(spec, 'player') ?? genre?.hero ?? '',
    foe: (genre === null ? null : castFor(genre, 'chase_me', 'fight', 'avoid', 'shoot_at')?.label) ?? roleOf(spec, 'chaser', 'patrol', 'hazard'),
    item: (genre === null ? null : castFor(genre, 'collect')?.label) ?? roleOf(spec, 'collectible', 'item'),
    look: lookOf(spec.theme),
    verbs: reading !== null ? reading.verbs.slice(0, 4) : verb === null ? [] : [{ word: verb, class: CLASS_OF_CONTROL[spec.control ?? 'tap_go'] }],
    title: spec.title,
    source: reading === null ? 'lexicon' : 'llm',
  };
}
