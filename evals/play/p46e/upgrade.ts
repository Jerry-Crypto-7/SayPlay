/**
 * Měřidlo AI verze (P46E T1): nahraná první odpověď režiséra projde skutečnou
 * cestou produktu – rychlá verze se publikuje jako v `POST /api/play/games`,
 * `directUpgrade` nad ní pustí `direct()` (kompaktní režisér, ověření robotem
 * na semínkách návrhu) a AI verzi publikuje. Jediný dvojník je větev modelu:
 * vrátí nahrané tělo. Opravné kolo se nevolá (`maxRepairRounds: 0`), nahrávka
 * je jedna odpověď.
 *
 * Řádek říká, jestli AI verze vyšla, jestli nezahodila pravidla a logiku
 * rychlé verze a co hráči přidala. Boss, akce a vlastní úseky jsou novinka,
 * kterou hráč hraje; nové jméno role (`characters`) jen vidí – majitel 12. 10.:
 * „AI verze nic nepřidá“, když přidala jen postavy.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { derivedSeeds, publishReadSpec, seedFrom } from '@/app/api/play/_publish';
import { type PlayedGame, type UpgradeAdd as PlayedAdd, directUpgrade, upgradeAddsOf } from '@/app/api/play/_upgrade';
import { type DirectedGame, direct } from '@/play/director';
import { answered, failed, fakeBranch } from '@/play/director/__fixtures__/branch';
import type { LogicAnswerFixture } from '@/play/director/__fixtures__/logic-answers';
import { draftGameSpecWithMeta } from '@/play/draft';
import { actionEvidence } from '@/play/fidelity/action-evidence';
import type { GameSpecV1 } from '@/play/spec';
import { memoryVersionStore, type PublishedGame } from '@/play/version';

export const P46E_DIR = 'evals/play/p46e';

/** Co AI verze přidala proti rychlé verzi. `characters` jediné není novinka ve hře. */
export type UpgradeAdd = PlayedAdd | 'characters';
export const PLAYED_ADDS: readonly UpgradeAdd[] = ['boss', 'action', 'segments'];

export interface UpgradeRow {
  readonly id: string;
  readonly sentence: string;
  /** Výsledek `directUpgrade`: `ready` = AI verze publikovaná. */
  readonly status: 'ready' | 'draft-final';
  /** Důvod `draft-final`; `null` u `ready`. */
  readonly reason: string | null;
  /** Co vrátil `direct()` před bránou upgradu (`authored` = hra z odpovědi). */
  readonly directed: string;
  readonly directedReason: string | null;
  /** Počet pravidel rychlé a AI verze (`null` = AI verze nevyšla). */
  readonly rules: readonly [number, number | null];
  /** AI verze má pravidla, když je měla rychlá; `null` = AI verze nevyšla. */
  readonly keptRules: boolean | null;
  /** AI verze má blok `logic`, když ho měla rychlá; `null` = AI verze nevyšla. */
  readonly keptLogic: boolean | null;
  readonly adds: readonly UpgradeAdd[];
  readonly actionLost: boolean;
}

export const recordedAnswers = (dir: string): LogicAnswerFixture[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as LogicAnswerFixture);

export type Played = PlayedGame;

/** Novinky AI verze proti rychlé: co hráč hraje (`upgradeAddsOf`, brána upgradu od T4) a nová jména rolí. */
export function addsOf(quick: Played, ai: Played): UpgradeAdd[] {
  const adds: UpgradeAdd[] = upgradeAddsOf(quick, ai);
  const labels = new Set(quick.spec.roles.map((role) => role.label.toLowerCase()));
  if (ai.spec.roles.some((role) => !labels.has(role.label.toLowerCase()))) adds.push('characters');
  return adds;
}

async function played(game: PublishedGame): Promise<Played> {
  return { spec: game.spec, world: game.arcade!, witnesses: await actionEvidence(game.spec, game.version.seed, game.arcade) };
}

const hasLogic = (spec: GameSpecV1): boolean => spec.logic !== undefined;

/** Ztratila AI verze pravidla nebo logiku, které rychlá verze měla? */
export const keptOf = (quick: GameSpecV1, ai: GameSpecV1): { keptRules: boolean; keptLogic: boolean } => ({
  keptRules: (quick.rules?.length ?? 0) === 0 || (ai.rules?.length ?? 0) > 0,
  keptLogic: !hasLogic(quick) || hasLogic(ai),
});

/** Jedna nahraná odpověď: rychlá verze, upgrade z odpovědi a srovnání obou publikovaných her. */
export async function upgradeRow(fixture: Pick<LogicAnswerFixture, 'id' | 'sentence' | 'answer' | 'failure'>): Promise<UpgradeRow> {
  const { sentence } = fixture;
  const store = memoryVersionStore();
  const seeds = derivedSeeds(seedFrom(sentence.trim()));
  const quick = await publishReadSpec(store, draftGameSpecWithMeta(sentence, 1).spec, seeds, null, { origin: { sentence, seed: null } });
  if (!quick.ok) throw new Error(`${fixture.id}: the quick version did not publish: ${JSON.stringify(quick.issues)}`);
  const draft = quick.value.game;
  let directed: DirectedGame | null = null;
  const outcome = await directUpgrade(store, draft, { sentence, seed: null, ackMs: null, draftReadyMs: null, startedAt: Date.now(), caller: 'p46e-gauge' }, (_startedAt, _caller, check, nudge) => async (said) => {
    // Druhý pokus s pokynem (T4) nahrávka nemá: větev bez odpovědi, AI verze zůstane první.
    const branch = fakeBranch([fixture.answer === null || nudge !== undefined ? failed('UPSTREAM_UNAVAILABLE', fixture.failure ?? 'no answer') : answered(fixture.answer)]);
    const result = await direct(said, { branch, now: Date.now, check, compact: true, maxRepairRounds: 0, ...(nudge === undefined ? {} : { nudge }) });
    if (nudge === undefined) directed = result;
    return { ...result, callerLimited: false };
  });
  const head = { id: fixture.id, sentence, directed: (directed as DirectedGame | null)?.source ?? 'none', directedReason: (directed as DirectedGame | null)?.fallbackReason ?? null };
  const quickRules = draft.spec.rules?.length ?? 0;
  if (outcome.status !== 'ready') {
    return { ...head, status: 'draft-final', reason: outcome.reason, rules: [quickRules, null], keptRules: null, keptLogic: null, adds: [], actionLost: outcome.reason === 'ACTION_LOST' };
  }
  const child = (await store.get(outcome.versionId))!;
  return {
    ...head,
    status: 'ready',
    reason: null,
    rules: [quickRules, child.spec.rules?.length ?? 0],
    ...keptOf(draft.spec, child.spec),
    adds: addsOf(await played(draft), await played(child)),
    actionLost: false,
  };
}

const share = (hit: number, of: number): number | null => (of === 0 ? null : Math.round((hit / of) * 1000) / 1000);

export function upgradeSummary(rows: readonly UpgradeRow[]) {
  const ready = rows.filter((row) => row.status === 'ready');
  const played = ready.filter((row) => row.adds.some((add) => PLAYED_ADDS.includes(add)));
  const count = (add: UpgradeAdd) => ready.filter((row) => row.adds.includes(add)).length;
  return {
    n: rows.length,
    authored: rows.filter((row) => row.directed === 'authored').length,
    ready: ready.length,
    readyShare: share(ready.length, rows.length),
    keptRules: share(ready.filter((row) => row.keptRules === true).length, ready.length),
    keptLogic: share(ready.filter((row) => row.keptLogic === true).length, ready.length),
    adds: share(played.length, ready.length),
    onlyCharacters: ready.filter((row) => row.adds.length > 0 && !played.includes(row)).length,
    boss: count('boss'),
    action: count('action'),
    segments: count('segments'),
    actionLost: rows.filter((row) => row.actionLost).length,
    reasons: Object.fromEntries([...new Set(rows.flatMap((row) => (row.reason === null ? [] : [row.reason])))].sort().map((reason) => [reason, rows.filter((row) => row.reason === reason).length])),
  };
}
