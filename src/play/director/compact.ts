/**
 * Kompaktní první odpověď režiséra (P27D T2, C2 z `plans/P27/04-create-and-remix.md`;
 * na žánrech od P32B T4).
 *
 * Model nepíše celý GameSpec, jen výběr: žánr, režim, role a prostředí
 * (`GenreSpec`). Hru z toho složí modul žánru (`readGenreAnswer`), takže
 * mechaniky, parametry a ověření jsou vždy ty, které runtime hraje. Menší
 * odpověď je celý smysl – naměřeno živě, ne předpokládáno
 * (`evals/play/fidelity/README.md`). Od plného promptu se liší kratším úvodem
 * a tím, že smí nést ověřené příklady (`retrieval.ts`).
 */

import { canonicalHash } from '@/ir/worlddoc';
import { EMISSION_MODEL, type UpstreamRequest } from '@/model/prompt';

import type { GenreSpec } from '../genre/contract';

import { GENRE_ANSWER_SCHEMA, RECIPE_ANSWER_SCHEMA } from './answer-schema';
import { COURSE_LINE, directorUser, genrePromptLines, rulesPromptLines } from './prompt';
import { examplesBlock, nearestExamples } from './retrieval';

/** Systémový text bez věty; stavěný při volání, aby změna modulu žánru prošla ven. */
export function compactSystemPrompt(): string {
  return ["Choose how the user's sentence plays. Never output code. Answer one JSON object {plan, spec}: plan = one short line, spec = a live recipe with named content and explicit unmet; legacy GenreSpec remains accepted.", genrePromptLines(), rulesPromptLines()].join('\n');
}

/** Jako `DIRECTOR_PROMPT_VERSION`: text, schéma odpovědi (P36A T7) i řádek průběhu ve zprávě (P45B T11); změna kteréhokoli zneplatní cache. */
export const COMPACT_PROMPT_VERSION = canonicalHash({ system: compactSystemPrompt(), schema: GENRE_ANSWER_SCHEMA, course: COURSE_LINE });

/** `examples` (P30A T8): za výchozí bod 3–5 ověřených her k podobným větám; bez nich je zpráva jako dřív. */
export function buildCompactRequest(sentence: string, draft: GenreSpec | null, examples = false): UpstreamRequest {
  const user = directorUser(sentence, draft);
  return {
    model: EMISSION_MODEL,
    system: compactSystemPrompt(),
    user: examples ? `${user}\n\n${examplesBlock(nearestExamples(sentence, draft?.genre ?? null))}` : user,
    outputSchema: GENRE_ANSWER_SCHEMA,
    codexOutputSchema: RECIPE_ANSWER_SCHEMA,
  };
}
