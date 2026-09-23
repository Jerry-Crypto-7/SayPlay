/**
 * Režisér (P23-B T7): věta → `GameSpecV1`, hráč hraje hned.
 *
 * Pořadí je smysl celé vrstvy: **návrh ze slov jde ven synchronně** přes
 * `onDraft` ještě před prvním `await`, teprve pak cache, model, kritik a
 * opravy. Model píše jen GameSpec, odpověď čte `readDirectorAnswer`, blokující
 * nálezy kritika se nejdřív opravují z tabulky (`repairDeterministically`),
 * teprve pak nejvýš `maxRepairRounds` modelových kol RFC 6902. Přijatý spec se
 * uloží do cache; **cokoli jiného skončí návrhem** s `fallbackReason`, nikdy
 * výjimkou – návrh existuje vždy, takže větev `ok:false` kontraktu tady nemá
 * kdy nastat (zapsáno v `docs/play/CONTRACT-CHANGES.md`).
 *
 * `MALFORMED` = odpověď se nedala přečíst ani deterministicky opravit (model
 * odpověděl něčím jiným než GameSpec); modelová kola nad ní nemají z čeho
 * záplatovat. `UNREPAIRED` = spec se přečetl, ale blokující nálezy přežily i
 * poslední kolo. `MODEL_UNAVAILABLE` = větev nevrátila odpověď, v prvním
 * volání nebo v opravném kole.
 */

import type { GenerationBranch } from '@/server/pipeline';

import type { DirectorResult, FallbackReason } from '../contracts';
import { draftGameSpec } from '../draft';
import type { GameSpecV1 } from '../spec';

import type { DirectorCache } from './cache';
import { directorKey } from './cache';
import { type CriticIssue, blockingIssues, critique } from './critic';
import { DIRECTOR_PROMPT_VERSION, buildDirectorRequest } from './prompt';
import { readDirectorAnswer, unwrapAnswer } from './read';
import { MAX_REPAIR_ROUNDS, applyRepairAnswer, buildRepairRequest, repairDeterministically } from './repair';

export type { FallbackReason } from '../contracts';

/** Rozšíření `DirectorResult` – přiřaditelné do kontraktu, s tím, co obálka a měření potřebují navíc. */
/**
 * Proč režie skončila návrhem (P26 T3): kde to spadlo, přesný důvod a co model
 * poslal. Jde do záznamu selhání a do logu, nikdy hráči.
 */
export interface DirectorFailure {
  readonly stage: 'model' | 'read' | 'critic';
  readonly reason: string;
  readonly detail: string;
  readonly raw: unknown;
}

export type DirectedGame = DirectorResult & {
  /** Jen u návratu na návrh. */
  readonly failure?: DirectorFailure;
  /** Varovné nálezy kritika nad vráceným specem. */
  readonly warnings: readonly CriticIssue[];
  readonly ms: number;
  /** Kolikrát se volal model. */
  readonly calls: number;
};

export interface DirectorDeps {
  readonly branch: GenerationBranch;
  readonly cache?: DirectorCache;
  readonly now: () => number;
  readonly seed?: number;
  /** Návrh ze slov, synchronně před prvním `await` – obálka ho může hned kompilovat. */
  readonly onDraft?: (spec: GameSpecV1) => void;
  readonly maxRepairRounds?: number;
}

function warningsOf(spec: GameSpecV1): CriticIssue[] {
  return critique(spec).filter((issue) => issue.severity === 'warn');
}

export async function direct(sentence: string, deps: DirectorDeps): Promise<DirectedGame> {
  const started = deps.now();
  const draft = draftGameSpec(sentence, deps.seed);
  deps.onDraft?.(draft);
  let calls = 0;

  const fallback = (reason: FallbackReason, failure: DirectorFailure): DirectedGame => ({
    ok: true,
    spec: draft,
    source: 'draft',
    repairRounds: 0,
    fallbackReason: reason,
    failure,
    warnings: warningsOf(draft),
    ms: deps.now() - started,
    calls,
  });

  const request = buildDirectorRequest(sentence, draft);
  const key = directorKey({ sentence, promptVersion: DIRECTOR_PROMPT_VERSION, model: request.model, endpoint: deps.branch.id });
  const cached = deps.cache === undefined ? null : await deps.cache.read(key);
  // Záznam přijal kritik tehdejšího buildu; co dnešní kritik blokuje, je miss.
  if (cached !== null && blockingIssues(critique(cached)).length === 0) {
    return { ok: true, spec: cached, source: 'cached', repairRounds: 0, fallbackReason: null, warnings: warningsOf(cached), ms: deps.now() - started, calls };
  }

  calls += 1;
  const outcome = await deps.branch.generate({ prompt: sentence, request });
  if (!outcome.ok)
    return fallback(outcome.reason === 'MALFORMED_RESPONSE' ? 'MALFORMED' : 'MODEL_UNAVAILABLE', { stage: 'model', reason: outcome.reason, detail: outcome.detail, raw: outcome.raw ?? null });

  let spec: GameSpecV1;
  const body = unwrapAnswer(outcome.body);
  const read = readDirectorAnswer(body);
  if (read.ok) {
    spec = read.spec;
  } else {
    const repaired = repairDeterministically(body, read.reason);
    if (repaired === null) return fallback('MALFORMED', { stage: 'read', reason: read.reason, detail: read.detail, raw: outcome.body });
    spec = repaired.spec;
  }

  let blocks = blockingIssues(critique(spec));
  if (blocks.length > 0) {
    const repaired = repairDeterministically(spec, blocks);
    if (repaired !== null) {
      spec = repaired.spec;
      blocks = blockingIssues(critique(spec));
    }
  }

  const maxRounds = deps.maxRepairRounds ?? MAX_REPAIR_ROUNDS;
  let repairRounds = 0;
  while (blocks.length > 0 && repairRounds < maxRounds) {
    repairRounds += 1;
    calls += 1;
    const answer = await deps.branch.generate({ prompt: sentence, request: buildRepairRequest(spec, blocks) });
    if (!answer.ok) return fallback('MODEL_UNAVAILABLE', { stage: 'model', reason: answer.reason, detail: `repair round ${repairRounds}: ${answer.detail}`, raw: answer.raw ?? null });
    const applied = applyRepairAnswer(spec, answer.body);
    // Špatná záplata nechává spec i nálezy, jak byly – další kolo je dostane znovu.
    if (!applied.ok) continue;
    spec = applied.spec;
    blocks = blockingIssues(critique(spec));
  }
  if (blocks.length > 0) return fallback('UNREPAIRED', { stage: 'critic', reason: 'UNREPAIRED', detail: blocks.map((issue) => `${issue.code} ${issue.path}: ${issue.evidence}`).join('; '), raw: spec });

  await deps.cache?.write(key, spec);
  return { ok: true, spec, source: 'authored', repairRounds, fallbackReason: null, warnings: warningsOf(spec), ms: deps.now() - started, calls };
}

export { directorCache, directorCacheFromEnv, directorKey, type DirectorCache } from './cache';
export { type CriticIssue, blockingIssues, critique } from './critic';
export { DIRECTOR_PROMPT_VERSION, buildDirectorRequest } from './prompt';
export { readDirectorAnswer, type DirectorRead, type DirectorReadReason } from './read';
