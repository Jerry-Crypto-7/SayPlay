/**
 * Kontrolní seznam z věty (P37A T8): co věta jmenuje a čím se hraje, bez ruky
 * a bez modelu. Ručně psaný seznam mají jen sady měření (`evals/play/p37a/dev-150.json`);
 * za běhu podle tohohle seznamu prompt režiséra říká, co má hra nést, a brána
 * upgradu (`score.ts`) měří, jestli AI verze nese víc než návrh.
 *
 * - **Podstatná jména** jsou popisky, které návrh ze slov přečetl (hrdina,
 *   nepřítel, věc, cíl, prostředí `GenreSpec`), a role z `readRoles` – ale jen
 *   ty, jejichž hlava (poslední slovo, jednotné číslo) ve větě opravdu stojí.
 *   Výchozí role z prostředí („wolf“, „meadow“) věta neřekla, a do seznamu proto
 *   nejdou: návrh by za ně dostal body, které AI verze dohnat nemůže. Nejvýš
 *   `MAX_NOUNS`, jako ruční sady: hrdina, role, prostředí.
 * - **Akce** jsou všechny podstatné trojice z intentu; věrnost je potvrzuje
 *   svědky skutečného hraní. Hlavní sloveso klasifikátoru zůstává pouze
 *   metadatem pro starší čtenáře.
 *
 * Deterministické: táž věta dá týž seznam v promptu i v bráně. Čtení modelem se
 * nepoužívá, i když je zapnuté – seznam musí vyjít stejně bez sítě.
 */

import { draftGenreFor } from '../draft';
import { extractIntent } from '../intent/extract';
import { essentialTriples, type Intent } from '../intent/contract';
import { readRoles, singular } from '../draft/lexicon';
import { classifyGenre } from '../genre/classify';
import type { GenreId } from '../genre/contract';
import { type FamilyId, familyOf } from '../genre/families';

import type { ChecklistEntry, FidelitySlot } from './chain';

/** Nejvýš tolik podstatných jmen, jako mají ruční sady (2–4). */
export const MAX_NOUNS = 4;

export interface MainVerb {
  /** Základní tvar z tabulky `VERBS` („knit“, „stir“). */
  readonly word: string;
  readonly family: FamilyId | null;
  readonly genre: GenreId;
  readonly mode: string;
}

export interface SentenceChecklist {
  readonly intent: Intent;
  readonly checklist: readonly ChecklistEntry[];
  /** `null` = věta herní sloveso nemá („a long queue at the pharmacy“). */
  readonly verb: MainVerb | null;
}

/**
 * Slovo, které návrh nechá za hlavou fráze („lanterns along“, „desk pls its“, „freezes a“):
 * hlavou by se stalo slovo, které věc nejmenuje a AI verze ho do popisku nedá.
 */
const TRAILING = /\s*\b(?:a|an|the|all|its|along|off|then|deep|home|up|down|out|away|back|over|around|through|plz|pls|lol)$/;

function clean(label: string): string {
  let text = label.toLowerCase().trim();
  while (TRAILING.test(text)) text = text.replace(TRAILING, '').trim();
  return text;
}

const head = (label: string): string => singular(label.split(/\s+/).at(-1) ?? '');

export function sentenceChecklist(sentence: string): SentenceChecklist {
  const text = sentence.toLowerCase();
  const words = new Set(text.replace(/['’]s\b/g, '').split(/[^a-z0-9-]+/).filter((word) => word !== '').map(singular));
  const intent = extractIntent(sentence);
  const ranking = classifyGenre(sentence, null);
  const choice = ranking.ranked[0];
  const genre = draftGenreFor(sentence, choice.genre, choice.mode);
  const roles = readRoles(sentence);
  const taken = new Set<string>();
  const said = (labels: readonly (string | null | undefined)[], slot: FidelitySlot, max: number): ChecklistEntry[] => {
    const entries: ChecklistEntry[] = [];
    for (const raw of labels) {
      if (entries.length >= max) break;
      const label = clean(raw ?? '');
      const noun = head(label);
      if (noun === '' || taken.has(noun) || !words.has(noun)) continue;
      taken.add(noun);
      entries.push({ item: label, slot, match: [noun] });
    }
    return entries;
  };
  const hero = said([genre?.hero, roles.player], 'hero', 1);
  const setting = said([genre?.setting, roles.setting], 'setting', 1);
  const others = said(
    // Obsazení návrhu (P39): každá jmenovaná věc kromě hrdiny, v pořadí návrhu.
    [...(genre?.cast ?? []).filter((item) => item.does !== 'hero').map((item) => item.label), roles.threat?.label, roles.target, roles.collectible, roles.item, roles.destination],
    'role',
    MAX_NOUNS - hero.length - setting.length,
  );

  // Bez čtení modelem má každé hlavní sloveso i režim (`GenreRanking.pick`).
  // Legacy display metadata remains available, but it no longer decides which
  // sentence actions enter the checklist or whether they are actually played.
  const verb: MainVerb | null = ranking.verb === null || ranking.pick === null ? null : { word: ranking.verb, family: familyOf(ranking.verb)?.id ?? null, genre: ranking.pick.genre, mode: ranking.pick.mode };
  const actions: ChecklistEntry[] = essentialTriples(intent).map(triple => ({ item: triple.verb, slot: 'verb', triple }));
  return { checklist: [...hero, ...others, ...setting, ...actions], verb, intent };
}
