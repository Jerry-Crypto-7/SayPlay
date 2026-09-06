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

/* ------------------------------------------------------------------ *
 * Shoda věty se skladem.
 * ------------------------------------------------------------------ */

/**
 * Slova, která o větě neříkají nic, a proto se do shody nepočítají.
 *
 * Seznam je krátký schválně. Každé odebrané slovo je slovo, které nemůže
 * rozhodnout — a čím delší seznam, tím víc vět splyne v jednu.
 */
const NOISE = new Set([
  'a', 'an', 'and', 'around', 'as', 'at', 'by', 'for', 'from', 'in', 'into',
  'of', 'on', 'or', 'over', 'that', 'the', 'to', 'under', 'up', 'with',
]);

/**
 * Věta na porovnatelná slova.
 *
 * ⚠ **Rozpad `camelCase` je součást metody, ne úklid.** `heroObjects` drží
 * `stableId` jako `centralLightWell`; bez rozpadu by se ta tři slova nikdy
 * netrefila s ničím, co člověk napíše, a bonus za hrdinský objekt by byl mrtvý
 * kód, který nikdy nic nepřidá.
 */
export function significantWords(text: string): readonly string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !NOISE.has(word));
}

/** Kolikrát víc váží slovo, které pojmenovává hrdinský objekt záznamu. */
export const HERO_WEIGHT = 3;

/**
 * Práh, pod kterým se shoda smí jmenovat `exact`.
 *
 * **Je součástí kontraktu, ne laděná konstanta.** Bez něj by `exact` šlo
 * potrefit náhodou a poctivý popisek z `T45` by lhal: porotce by četl „tuhle
 * větu jsem uměl" nad světem, který patří jiné větě. Vlastní věta ze skladu
 * dává vzdálenost přesně 0, takže prostor nad nulou je čistě rezerva na překlep
 * a jinou interpunkci — deset procent slov, ne polovina.
 */
export const EXACT_MAX_DISTANCE = 0.1;

/**
 * Vzdálenost věty od záznamu: 0 je táž věta, 1 je nic společného.
 *
 * **Je to vážený Jaccard, ne kosinus embeddingu.** Embedding je další model
 * a další latence na cestě, kterou má demo stihnout do tří sekund; tady stačí
 * průnik podstatných slov. Dělí se **sjednocením**, ne délkou dotazu — jinak by
 * dvouslovná věta byla blízko všemu a „nejbližší svět" by ztratil význam.
 *
 * ⚠ **Jmenovatel bere z hrdinských jmen jen ta, na která se dotaz doopravdy
 * zeptal — a je to oprava naměřená mutací, ne estetika.** První podoba je do
 * sjednocení nepočítala vůbec, takže shoda mohla jmenovatel přerůst a musela se
 * řezat u nuly; cizí věta, která trefila dvě hrdinská jména, tak dostala
 * vzdálenost 0 a s ní nálepku `exact`. Takhle přidá trefené hrdinské jméno
 * stejnou váhu do čitatele i do jmenovatele: pomůže, ale přerůst nemůže.
 *
 * Vlastní věta záznamu dává přesně 0, protože nad ní jsou obě strany totéž.
 */
export function distanceTo(prompt: string, world: AuthoredWorld): number {
  const base = new Set(significantWords(world.prompt));
  const heroic = new Set(
    [...world.heroObjects, ...world.synonyms].flatMap((source) => significantWords(source)),
  );
  const asked = new Set(significantWords(prompt));
  const weigh = (word: string): number => (heroic.has(word) ? HERO_WEIGHT : 1);

  let shared = 0;
  for (const word of asked) if (base.has(word) || heroic.has(word)) shared += weigh(word);

  let union = 0;
  for (const word of base) union += weigh(word);
  for (const word of asked) if (!base.has(word)) union += weigh(word);

  return union === 0 ? 1 : 1 - shared / union;
}

/** Co sklad na tuhle větu našel. */
export interface AuthoredMatch {
  readonly world: AuthoredWorld;
  /** `exact` znamená „tuhle větu jsem uměl". Cokoli jiného se musí přiznat. */
  readonly match: 'exact' | 'nearest';
  readonly distance: number;
}

/**
 * Který uvařený svět tahle věta dostane.
 *
 * **Deterministické, bez PRNG, bez sítě a bez modelu.** Táž věta dostane týž
 * svět při každém spuštění i po redeployi — jinak by porotce, který větu napíše
 * podruhé, dostal jiné místo a produkt by vypadal, že si nepamatuje nic.
 *
 * Při shodě vzdáleností rozhoduje `id`, ne pořadí v souboru: pořadí se změní
 * při každém doplnění skladu a rozhodovat podle něj znamená rozhodovat náhodou.
 */
export function chooseAuthored(
  prompt: string,
  worlds: readonly AuthoredWorld[] = AUTHORED_STORE.worlds,
): AuthoredMatch | null {
  let best: AuthoredMatch | null = null;
  for (const world of worlds) {
    const distance = distanceTo(prompt, world);
    if (best !== null && (distance > best.distance || (distance === best.distance && world.id >= best.world.id)))
      continue;
    best = { world, distance, match: distance <= EXACT_MAX_DISTANCE ? 'exact' : 'nearest' };
  }
  return best;
}

/**
 * Emitor nad uvařeným světem, nebo `null`, když sklad nemá **žádný**.
 *
 * ⚠ **Od `T43` je `null` výhradně prázdný sklad, ne neznámá věta.** Neznámá
 * věta dostane nejbližší svět; že je nejbližší, se pozná z `chooseAuthored()`
 * a řekne to porotci popisek (`T45`). Prázdná emise by se naopak tvářila jako
 * odpověď modelu a relace by skončila odmítnutím, které nikoho nikam nedovede.
 */
export function authoredEmitter(
  prompt: string,
  worlds: readonly AuthoredWorld[] = AUTHORED_STORE.worlds,
): BlueprintEmitter | null {
  const found = chooseAuthored(prompt, worlds);
  return found === null ? null : emitterFor(found.world);
}

/**
 * Emitor nad **jedním** uvařeným světem, který si volající už vybral.
 *
 * Existuje kvůli popisku (`T45-honestlabel`): route potřebuje vědět, jestli
 * je shoda `exact`, nebo `nearest`, takže si `chooseAuthored()` volá sama.
 * Bez tohohle vstupu by musela hledat dvakrát — jednou pro odpověď a podruhé
 * uvnitř `authoredEmitter()` — a dva hledače nad tímtéž se dají rozejít.
 */
export function emitterFor(world: AuthoredWorld): BlueprintEmitter {
  return (request: UpstreamRequest): Promise<unknown> => {
    const stage = requestStage(request);
    if (stage === null)
      return Promise.reject(
        new Error('the authored store was asked for a stage it does not recognise'),
      );
    return Promise.resolve(stage === 'planner' ? world.planner : world.compiler);
  };
}
