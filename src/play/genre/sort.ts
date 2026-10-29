/**
 * Žánr Třídění (P66 T8): nahoře fronty věcí z věty, dole nádoby; klepnutí na frontu pošle její čelo do nádoby téhož
 * druhu nebo barvy, jinak do odkladiště s omezeným místem (ovládání `sort`, vstup pruhů – sloupec je fronta,
 * generátor `sort_bins` v `arcade/pieces/sort.ts`, úrovně v `sort-level.ts`).
 *
 * Hloubka: `rounds` krátkých kol (2–5, výchozí 3, každé do minuty, banner kola a hned další), v kolech přibývá druhů,
 * nádob a front; `items` věcí za hru. Plné odkladiště nebo hodiny kola = prohra, série správných ťuků zvedá kombo,
 * vzácná věc (háčky `rarity`) dá body navíc.
 *
 * **Věci z věty:** druhy věcí jsou role `sort0`–`sort4` (scéna je kreslí modelem popisku přes `cast.things`). Věta
 * s víc věcmi dá každému druhu jednu z nich (dokola, když jich je méně než druhů); věta s jednou věcí třídí tutéž věc
 * podle barev. Barvu má každý druh vždy – jen podle ní se pozná druh u věty s jednou věcí.
 *
 * Do rychlé hry žánr pustil P66 T12 jednou změnou výběru (narážky, `availability: 'ready'`, buňka `sort.default`
 * v `PRESETS`); věty sem vede znak žánru v `classify.ts`. Režisérovi a čtečce ho popíše T13. E2e hraje z ručního specu
 * (`e2e/fixtures/p66-sort-spec.json`).
 */

import { SORT, binsPerRound } from '../arcade/pieces/sort-level';
import { nounPhrase, plural, singular } from '../draft/lexicon';

import { type CastItem, type GenreModule, draftRoles, legacySpec, titleCase } from './contract';

/** Výchozí věci hračkářství (všechny mají model v knihovně). */
export const SORT_DEFAULTS = { items: ['teddy bear', 'rubber duck', 'ball'] } as const;

/** Rolí druhů: jedna na druh, `sort0`–`sort4`. */
export const SORT_ROLE_IDS = Array.from({ length: SORT.kinds }, (_, kind) => `sort${kind}`);

/** Předmět slovesa třídění („sorts toys, socks and books into boxes“, „sort the coloured balls“) až do konce věty. */
const SORT_OBJECT = /\b(?:sort|organi[sz]e|pack)(?:s|es|ed|ing)?\s+(?:out\s+|up\s+)?([a-z ,'-]+)/;
/** Kde výčet věcí končí: místo, kam se třídí, nebo další věta. */
const LIST_END = /\s(?:into|in|by|onto|on|to|inside|before|while|so|that|with|for|from)\s/;
/** Zájmena a prázdná slova nejsou věc k třídění. */
const NOT_ITEM = /^(?:it|them|everything|things|stuff|out|up|all)$/;
/** Kam se třídí („into boxes“): nádoby hry, ne prostředí věty. */
const DESTINATION = /\b(?:into|onto)\s+(?:the\s+|their\s+|its\s+|matching\s+|right\s+)*([a-z][a-z -]*)/;

/** Věci z výčtu za slovesem třídění, v jednotném čísle. */
function listedOf(sentence: string): string[] {
  const found = SORT_OBJECT.exec(sentence.toLowerCase());
  if (found === null) return [];
  const list = ` ${found[1] as string} `.split(LIST_END)[0] as string;
  return list
    .split(/,|\band\b/)
    .map((part) => nounPhrase(part))
    .filter((part): part is string => part !== null && !NOT_ITEM.test(part))
    .map(singular);
}

/** První text, který se vejde do meze schématu (dlouhé popisky z věty). */
const fit = (max: number, ...lines: readonly string[]): string => lines.find((line) => line.length <= max) ?? (lines.at(-1) as string);

/** Věci, které věta třídí: výčet za slovesem třídění („toys, socks and books“), jinak sbírané a kulisy obsazení. */
function sortedLabels(cast: readonly CastItem[]): string[] {
  const labels = cast.filter((item) => item.does === 'collect' || item.does === 'scenery').map((item) => singular(item.label));
  return [...new Set(labels)].slice(0, SORT.kinds);
}

export const sortGenre: GenreModule<'sort'> = {
  id: 'sort',
  modes: ['default'],
  // P66 T12: věty sem vede znak žánru v `classify.ts` (sloveso třídění, věc do správné nádoby); narážky přidají bod.
  // Ne „sort“: narážka bere každý tvar slova, tedy i „a sort of“, které znak žánru vynechává.
  cues: ['sorter', 'by colour', 'by color'],
  heroClasses: ['humanoid', 'animal', 'robot', 'monster', 'prop'],
  paramBounds: {
    items: { min: SORT.items.min, max: SORT.items.max },
    rounds: { min: SORT.rounds.min, max: SORT.rounds.max },
  },
  // P66 T12: živý – buňka `sort.default` je v `PRESETS` a věty sem vede klasifikátor.
  availability: () => 'ready',
  compile: (spec) => {
    const items = spec.params?.items ?? SORT.items.default;
    const rounds = spec.params?.rounds ?? SORT.rounds.default;
    const said = sortedLabels(spec.cast ?? []);
    const labels = said.length > 0 ? said : [...SORT_DEFAULTS.items];
    const bins = binsPerRound(items, rounds).reduce((sum, count) => sum + count, 0);
    const total = bins * SORT.capacity;
    const named = labels.slice(0, 3).map((label) => plural(label, 2));
    const list = named.length === 1 ? (named[0] as string) : `${named.slice(0, -1).join(', ')} and ${named.at(-1) as string}`;
    const by = labels.length === 1 ? ' by color' : '';
    return legacySpec(spec, {
      control: 'sort',
      controlParams: { generator: 'sort_bins', tuning: { items, rounds } },
      archetype: 'collect_exit',
      title: `${titleCase(spec.hero)} Sort`,
      objective: {
        kind: 'collect',
        description: fit(
          120,
          `Send ${list}${by} to bins of their kind: fill ${String(bins)} bins in ${String(rounds)} rounds, keep the shelf free.`,
          `Fill ${String(bins)} bins in ${String(rounds)} rounds and keep the shelf free.`,
        ),
        count: bins,
        role: 'sort0',
      },
      mechanics: [],
      roles: SORT_ROLE_IDS.map((id, kind) => ({ id, kind: 'collectible' as const, label: labels[kind % labels.length] as string })),
      tutorial: {
        goalLine: fit(50, `Sort the ${list}${by}!`, `Sort ${String(total)} things into bins!`),
        controlsHint: 'Tap a line to send its front item. Arrows and Space work too.',
      },
      mood: 'playful',
      targetDurationSec: 60,
    });
  },
  draftFill: (sentence, reading) => {
    const { hero, setting, cast } = draftRoles(sentence, reading);
    // Třídění zná jen věci k třídění: nepřítel věty se v nádobách nemá co dělat.
    let roles = (cast ?? []).filter((item) => item.does === 'collect' || item.does === 'scenery');
    const listed = listedOf(sentence);
    if (listed.length > 0) roles = [...listed.map((label): CastItem => ({ label, does: 'collect' })), ...roles.filter((item) => !listed.includes(singular(item.label)))];
    // „sorts toys into boxes in a toy shop“: krabice jsou nádoby hry; prostředí věty je obchod, nebo výchozí žánru.
    const into = DESTINATION.exec(sentence.toLowerCase());
    const bin = into === null ? null : nounPhrase(into[1] as string);
    const place = setting !== undefined && bin !== null && singular(setting) === singular(bin) ? undefined : setting;
    return {
      genre: 'sort',
      mode: 'default',
      ...(hero === undefined ? {} : { hero }),
      ...(place === undefined ? {} : { setting: place }),
      ...(roles.length === 0 ? {} : { cast: roles }),
    };
  },
};
