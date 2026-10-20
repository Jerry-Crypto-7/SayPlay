/**
 * Manifest modelů hrdinů (P32-0 T6): jeden popis každého modelu, který smí
 * hrát hrdinu – soubor, identita z věty, třída, rozměry, osa, klipy animací,
 * záložní barva, licence a žánry, které ho načítají dopředu.
 *
 * `heroFor` hledá **nejdřív identitu** („penguin“ → tučňák), až pak třídu
 * („eagle“ → nějaký pták). Třída je poslední záchrana: jiný pták místo tučňáka
 * vypadá jako hra, jen ne ta z věty (astra, kolo 3).
 */

import { z } from 'zod';

import { GENRES, type GenreId, MODEL_CLASSES, type ModelClass } from '../genre/contract';
import { GENRE_MODULES } from '../genre/index';

import { BASE_ENTRIES } from './entries/base';

/**
 * Stavy hrdiny, které renderer přehrává; `procedural` = pohyb dopočítá kód, model klip nemá.
 * Chůze a výhra jsou nepovinné (P54B T5): bez nich `RiggedModel` hraje běh, resp. klid.
 */
export const CLIP_STATES = ['idle', 'walk', 'run', 'jump', 'hit', 'die', 'win'] as const;

const clip = z.string().min(1).max(64);

export const assetEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    /** Cesta v `public/`, jak ji načítá prohlížeč. */
    file: z.string().regex(/^\/assets\/[\w/.-]+\.glb$/),
    /** Slova věty, která jmenují právě tenhle model (tagy, jednotné číslo). */
    identity: z.array(z.string().regex(/^[a-z][a-z-]*$/)).min(1),
    class: z.enum(MODEL_CLASSES),
    /** Rozměr v jednotkách GLB (x, y, z) v klidové póze; renderer ho vepisuje do těla jádra. */
    dims: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
    /** `base` = počátek uprostřed podstavy, `center` = uprostřed objemu. */
    pivot: z.enum(['base', 'center']),
    /** Osa, kam model míří. */
    forward: z.enum(['+z', '-z', '+x', '-x']),
    clips: z.object({ idle: clip, walk: clip.optional(), run: clip, jump: clip, hit: clip, die: clip, win: clip.optional() }).strict(),
    /** Barva náhradního tvaru, dokud se model nenačte. */
    fallback: z.string().regex(/^#[0-9a-f]{6}$/),
    license: z.string().min(1),
    /** Žánry, které model načítají dopředu (kit žánru). */
    preload: z.array(z.enum(GENRES)),
  })
  .strict();
export type AssetEntry = z.infer<typeof assetEntrySchema>;

/** Slova, podle kterých se pozná třída, když žádný model nemá identitu z věty. */
const CLASS_WORDS: Readonly<Record<ModelClass, readonly string[]>> = {
  bird: ['bird', 'penguin', 'eagle', 'parrot', 'duck', 'owl', 'chicken', 'hen', 'crow', 'pigeon', 'seagull', 'hawk', 'flamingo', 'swan', 'goose'],
  animal: ['animal', 'cat', 'kitten', 'dog', 'puppy', 'fox', 'bear', 'rabbit', 'bunny', 'pig', 'cow', 'horse', 'mouse', 'monkey', 'lion', 'tiger', 'wolf', 'deer', 'frog', 'fish', 'turtle', 'snake', 'hamster'],
  robot: ['robot', 'android', 'droid', 'mech', 'cyborg', 'bot'],
  vehicle: ['car', 'truck', 'bus', 'bike', 'bicycle', 'motorcycle', 'kart', 'tank', 'train', 'tractor', 'taxi', 'van'],
  boat: ['boat', 'ship', 'sailboat', 'yacht', 'submarine', 'canoe', 'raft', 'ferry'],
  aircraft: ['plane', 'airplane', 'jet', 'helicopter', 'rocket', 'spaceship', 'ufo', 'drone', 'balloon'],
  humanoid: ['man', 'woman', 'boy', 'girl', 'kid', 'child', 'person', 'hero', 'chef', 'firefighter', 'pirate', 'knight', 'wizard', 'princess', 'prince', 'ninja', 'astronaut'],
  monster: ['monster', 'ghost', 'zombie', 'dragon', 'alien', 'skeleton', 'goblin', 'troll', 'ogre', 'vampire'],
  prop: [],
};

const CLASS_OF_WORD: ReadonlyMap<string, ModelClass> = new Map(MODEL_CLASSES.flatMap((kind) => CLASS_WORDS[kind].map((word) => [word, kind] as const)));

/** „penguins“ → „penguins“, „penguin“; „puppies“ → „puppy“. */
const forms = (word: string): string[] => [...new Set([word, word.replace(/ies$/, 'y'), word.replace(/es$/, ''), word.replace(/s$/, '')])];

/**
 * Model hrdiny pro popisek role hráče. Slova se čtou od konce (anglické
 * podstatné jméno nese konec: „tiny wizard“). Identita kteréhokoli slova má
 * přednost; slovo, které jmenuje třídu a model nemá („pirate ship“), hledání
 * zastaví, ať přídavné jméno („pirate“) nepřebije podstatné. Třída se bere,
 * jen když ji žánr za hrdinu připouští; `null` = kód nakreslí náhradu.
 */
export function heroFor(label: string, genre: GenreId, entries: readonly AssetEntry[] = BASE_ENTRIES): AssetEntry | null {
  const words = label.toLowerCase().match(/[a-z][a-z-]*/g) ?? [];
  let named: ModelClass | undefined;
  for (const word of [...words].reverse()) {
    const own = forms(word);
    const hit = entries.find((entry) => own.some((form) => entry.identity.includes(form)));
    if (hit !== undefined) return hit;
    named = own.map((form) => CLASS_OF_WORD.get(form)).find((kind) => kind !== undefined);
    if (named !== undefined) break;
  }
  if (named === undefined || !GENRE_MODULES[genre].heroClasses.includes(named)) return null;
  const pool = entries.filter((entry) => entry.class === named);
  return pool.find((entry) => entry.preload.includes(genre)) ?? pool[0] ?? null;
}
