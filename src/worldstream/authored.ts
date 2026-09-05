/**
 * Světy uvařené dopředu, vydávané toutéž cestou jako živá emise.
 *
 * ## Proč emitor, a ne zkratka kolem něj
 *
 * Uvařený svět vypadá jako hotová věc, kterou stačí ukázat. Kdyby se ale vlil
 * do relace mimo `compileWithRepair()`, přeskočil by validaci geometrie,
 * snížení do IR i hledání svědka — a demo by porotci ukazovalo něco, co brány
 * nikdy neviděly. Proto sklad nevydává svět, ale **odpověď modelu**: prochází
 * pak vším, čím prochází živá emise, včetně odmítnutí, kdyby se pokazila.
 *
 * ## Jedna věta jsou DVĚ různá volání, ne jedno
 *
 * `runGeneration()` se ptá dvakrát: nejdřív `buildIntentRequest()` (odpověď
 * nese `intent, objects`) a pak `buildCompilerRequest()` (odpověď nese
 * `geometry, shapes, placements, world`). Sklad proto na jednu větu drží obě
 * emise a **rozlišuje je podle žádaných polí, ne podle pořadí** — opravné kolo
 * pošle compiler požadavek znovu, takže „první volání je planner" se rozbije
 * při prvním odmítnutí. Rozhodovací funkce je `requestStage()` a bydlí u obou
 * builderů, aby existovala jednou.
 *
 * ⚠ **Sklad je staticky importovaný JSON, ne čtení z disku za běhu.** Na
 * Vercelu je bundle jediná jistota; `readFileSync` nad `src/` tam nemá co číst.
 */

import { requestStage } from '@/model/worldstream-prompt';
import type { UpstreamRequest } from '@/model/prompt';
import type { BlueprintEmitter } from '@/model/worldstream-repair';

import store from './authored-worlds.json';

/** Jedna věta a obě emise, které na ni model napsal. */
export interface AuthoredWorld {
  readonly id: string;
  readonly prompt: string;
  readonly heroObjects: readonly string[];
  readonly synonyms: readonly string[];
  readonly planner: unknown;
  readonly compiler: unknown;
}

export interface AuthoredStore {
  readonly version: string;
  readonly worlds: readonly AuthoredWorld[];
}

export const AUTHORED_STORE = store as AuthoredStore;

/** Věta zbavená všeho, co o ní nic neříká. */
function normalize(prompt: string): string {
  return prompt.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Který uvařený svět tahle věta dostane.
 *
 * Zatím jen doslovná shoda. Nejbližší svět pro větu, která ve skladu není,
 * dodává `T43` — a do té doby je poctivější nevydat nic než vydat cizí svět
 * bez popisku, že je cizí.
 */
export function chooseAuthored(
  prompt: string,
  worlds: readonly AuthoredWorld[] = AUTHORED_STORE.worlds,
): AuthoredWorld | null {
  const wanted = normalize(prompt);
  return worlds.find((world) => normalize(world.prompt) === wanted) ?? null;
}

/**
 * Emitor nad uvařeným světem, nebo `null`, když pro tuhle větu žádný není.
 *
 * `null` je součást kontraktu, ne opomenutí: volající musí umět poznat „není
 * z čeho" a říct to. Prázdná emise by se tvářila jako odpověď modelu a relace
 * by skončila odmítnutím, které nikoho nikam nedovede.
 */
export function authoredEmitter(
  prompt: string,
  worlds: readonly AuthoredWorld[] = AUTHORED_STORE.worlds,
): BlueprintEmitter | null {
  const world = chooseAuthored(prompt, worlds);
  if (world === null) return null;

  return (request: UpstreamRequest): Promise<unknown> => {
    const stage = requestStage(request);
    if (stage === null)
      return Promise.reject(
        new Error('the authored store was asked for a stage it does not recognise'),
      );
    return Promise.resolve(stage === 'planner' ? world.planner : world.compiler);
  };
}
