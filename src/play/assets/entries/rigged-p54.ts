/**
 * Animované CC0 postavy Quaternius (P54B T3): kostra a klipy z `src/assets/rigged-p54.json`,
 * které staví `scripts/assets/rigged/import-cc0.mjs`. Generátor zapisuje i třídu, rozměr
 * (v první póze idle, výška 1,8 m) a záložní barvu, takže tady se jen překládá do tvaru
 * manifestu. Manifest zná stavy `CLIP_STATES`: postava bez běhu běží svou chůzí, chybějící
 * skok, zásah nebo smrt je `procedural`; chůze, vítězství a útok zůstávají v JSON pro T5.
 *
 * Identita: slovo, které už jmenuje dřívější záznam manifestu (identita nebo holé id), si
 * postava nevezme – model s klipy by v `identityEntry` přebil dnešní statický model
 * („zombie“ → `cc0-zombie`). Kdy má vyhrát riggovaná postava, rozhoduje směrování v T4;
 * celé tagy zůstávají v JSON. Postava bez volného slova má za identitu své id.
 */

import rigged from '@/assets/rigged-p54.json';

import type { ModelClass } from '../../genre/contract';
import type { AssetEntry } from '../manifest';

import { BASE_ENTRIES } from './base';
import { CATALOG_ENTRIES } from './catalog';
import { RIGGED_P32_ENTRIES } from './rigged-p32';

const PROCEDURAL = 'procedural';

/** Slova dřívějších záznamů: identita a holé id jako `bareId` v `src/play/arcade/models.ts`. */
const CLAIMED: ReadonlySet<string> = new Set([...BASE_ENTRIES, ...RIGGED_P32_ENTRIES, ...CATALOG_ENTRIES].flatMap((entry) => [...entry.identity, entry.id.replace(/^(cc0|gen3d)-/, '')]));

export const RIGGED_P54_ENTRIES: readonly AssetEntry[] = rigged.characters.map((character) => {
  const clips: Partial<Record<string, string>> = character.clips;
  const free = character.tags.filter((tag) => !CLAIMED.has(tag));
  return {
    id: character.id,
    file: character.path,
    identity: free.length > 0 ? free : [character.id],
    class: character.class as ModelClass,
    dims: character.dims as [number, number, number],
    pivot: 'base',
    forward: '+z',
    clips: {
      idle: clips.idle ?? PROCEDURAL,
      run: clips.run ?? clips.walk ?? PROCEDURAL,
      jump: clips.jump ?? PROCEDURAL,
      hit: clips.hit ?? PROCEDURAL,
      die: clips.die ?? PROCEDURAL,
    },
    fallback: character.fallback,
    license: character.license,
    preload: [],
  };
});
