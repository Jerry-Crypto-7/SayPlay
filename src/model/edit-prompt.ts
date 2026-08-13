/**
 * Sestavení upstream požadavku pro **editaci** — patch, ne celý svět.
 *
 * Stejně jako `./prompt` je soubor **čistý**: žádné čtení disku, žádná síť,
 * slovník zvenčí. Gramatika je zmrazená (`evals/frozen/protocol.v1.json`)
 * a opsat si ji sem znamená rozejít se s ní tiše.
 *
 * ## Proč patch a ne přeemitovaný svět
 *
 * `DESIGN-BOOK.md` §15 a zmrazený `editContract`: živá editace je **transakční
 * patch běžícího grafu bez resetu**. Kdyby model vydal celý svět znovu, hráč by
 * přišel o stav, dosah změny by nešlo ohraničit a `allowedPaths` by neměl proti
 * čemu platit — dosah celého světa je celý svět.
 *
 * ## Co se modelu říká o dráze a co ne
 *
 * `editContract.router.decidesFromLabel` je `false`, a systémová zpráva to říká
 * modelu **nahlas**: štítek se zaznamená, ale dráhu rozhodnou cesty. Není to
 * zdvořilost — model, který věří, že si štítkem vybere, jestli jeho změna půjde
 * přes verifikátor, bude to zkoušet; model, kterému se rovnou řekne, že si
 * nevybere, nemá co obcházet. Autoritou zůstává router (`src/patch/router.ts`),
 * ne tahle věta.
 *
 * ## Proč dokument v promptu
 *
 * Patch adresuje cestami, takže model musí vidět, **co v dokumentu je**. Posílá
 * se `sim` i `look` — obojí je patchovatelné. `simHash` a obě revize jdou
 * zvlášť a jen pro informaci: revizi si model nevybírá, tu drží požadavek.
 */

import { canonical } from '../ir/worlddoc';
import type { WorldDoc } from '../ir/worlddoc';
import { EMISSION_MODEL, type Grammar, type UpstreamRequest } from './prompt';

/**
 * Model, proti kterému se měří editační větev.
 *
 * Je to **týž** model jako u tvorby, a schválně: P1 měří jednu tezi dvěma
 * větvemi jednoho kontraktu, takže rozdíl mezi větvemi nesmí být rozdíl modelu.
 */
export const EDIT_MODEL = EMISSION_MODEL;

export function buildEditRequest(prompt: string, grammar: Grammar, doc: WorldDoc): UpstreamRequest {
  const system = [
    'You edit a declarative world graph that is already running. You never write code, control flow,',
    'or expressions to be evaluated.',
    '',
    'Answer with a single JSON array and nothing else: an RFC 6902 patch against the document below.',
    'Never answer with a whole world — the world is live and a replacement would reset it.',
    '',
    'Every path is anchored in /sim or /look. Those are the two patchable parts; the document root,',
    'simHash, simRevision and lookRevision are not patch targets — the system owns them.',
    '',
    'One patch carries ONE semantic intent. Say what you changed and nothing else changed with it:',
    'the system expands your patch into the set of leaf paths it actually moved, and judges that set.',
    'Replacing a parent to reach one child moves every other child with it, and that counts against you.',
    '',
    'You may add a "label" field naming the part you think you edited. It is recorded, not obeyed:',
    'the lane is decided by your paths. A write under /sim goes through the rules lane and its',
    'verifier no matter what the label says.',
    '',
    `sim carries: ${grammar.simFields.join(', ')}. It is inside the state hash.`,
    `look carries: ${grammar.lookFields.join(', ')}. It is outside the state hash, and its only`,
    'permitted link into sim is an entity stableId.',
    '',
    `Rules fire on these events: ${grammar.surfaceEvents.join(', ')}.`,
    `Guards use these conditions: ${grammar.conditions.join(', ')}.`,
    `Effects use these actions: ${grammar.actions.join(', ')}.`,
    'Nothing outside those three lists exists. Every counter, timer and inventory slot is bounded.',
    '',
    'sim.witness must still reach win() after your edit. If the edit breaks the winning trace, repair',
    'the trace in the same patch — an uncertified sim patch is not applied.',
    '',
    'If the request cannot be expressed in this vocabulary, answer with an empty array rather than',
    'inventing one.',
    '',
    `Current document (simRevision ${doc.simRevision}, lookRevision ${doc.lookRevision}, simHash ${doc.simHash}):`,
    canonical({ sim: doc.sim, look: doc.look }),
  ].join('\n');

  // Text promptu jde do zprávy **doslova**, ze stejného důvodu jako u tvorby:
  // bez toho se nedá prokázat, že odpověď patří k tomuhle promptu.
  const user = `Change the running world for this request:\n\n${prompt}`;

  return { model: EDIT_MODEL, system, user };
}
