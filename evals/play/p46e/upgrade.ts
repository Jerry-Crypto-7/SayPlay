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
import { directUpgrade } from '@/app/api/play/_upgrade';
import { abilityIdsOf } from '@/play/arcade/abilities/state';
import { ABILITIES, type ArcadeWorld, BODY, bodyBase, nativeRule } from '@/play/arcade/contract';
import { segmentNewsOf } from '@/play/arcade/pieces/pacing';
import type { ActionWitness } from '@/play/arcade/witness';
import { type DirectedGame, direct } from '@/play/director';
import { answered, failed, fakeBranch } from '@/play/director/__fixtures__/branch';
import type { LogicAnswerFixture } from '@/play/director/__fixtures__/logic-answers';
import { draftGameSpecWithMeta } from '@/play/draft';
import { actionEvidence } from '@/play/fidelity/action-evidence';
import type { GameSpecV1 } from '@/play/spec';
import { memoryVersionStore, type PublishedGame } from '@/play/version';

export const P46E_DIR = 'evals/play/p46e';

/** Co AI verze přidala proti rychlé verzi. `characters` jediné není novinka ve hře. */
export type UpgradeAdd = 'boss' | 'action' | 'segments' | 'characters';
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

/** Model bosse finále (poslední předloha chování pravidla `pacing`); `null` = hra bez bosse. */
function bossOf(world: ArcadeWorld): string | null {
  const params = nativeRule(world.rules, 'pacing')?.params as { readonly finale?: string; readonly behaviours?: readonly { readonly template: number }[] } | undefined;
  const template = params?.finale === 'boss' ? params.behaviours?.at(-1)?.template : undefined;
  return template === undefined ? null : (world.kinds[world.initial[bodyBase(template) + BODY.kind] as number] ?? '');
}

const ACTIONS: ReadonlySet<string> = new Set(ABILITIES);

/** Akce hrdiny: tlačítka akcí (P46A) a akce, kterou robot ve hře opravdu udělal. */
const actionsOf = (world: ArcadeWorld, witnesses: readonly ActionWitness[]): Set<string> =>
  new Set([...abilityIdsOf(world.control), ...witnesses.map((witness) => witness.verb).filter((verb) => ACTIONS.has(verb))]);

const segmentsOf = (world: ArcadeWorld): string[] => segmentNewsOf(world).map((item) => `${item.beat}:${item.news}`);

export interface Played {
  readonly spec: GameSpecV1;
  readonly world: ArcadeWorld;
  readonly witnesses: readonly ActionWitness[];
}

/** Novinky AI verze proti rychlé: jiný nebo nový boss, nová akce, jiný neprázdný scénář úseků, nová jména rolí. */
export function addsOf(quick: Played, ai: Played): UpgradeAdd[] {
  const adds: UpgradeAdd[] = [];
  const boss = bossOf(ai.world);
  if (boss !== null && boss !== bossOf(quick.world)) adds.push('boss');
  const had = actionsOf(quick.world, quick.witnesses);
  if ([...actionsOf(ai.world, ai.witnesses)].some((action) => !had.has(action))) adds.push('action');
  const segments = segmentsOf(ai.world);
  if (segments.length > 0 && segments.join() !== segmentsOf(quick.world).join()) adds.push('segments');
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
  const outcome = await directUpgrade(store, draft, { sentence, seed: null, ackMs: null, draftReadyMs: null, startedAt: Date.now(), caller: 'p46e-gauge' }, (_startedAt, _caller, check) => async (said) => {
    const branch = fakeBranch([fixture.answer === null ? failed('UPSTREAM_UNAVAILABLE', fixture.failure ?? 'no answer') : answered(fixture.answer)]);
    directed = await direct(said, { branch, now: Date.now, check, compact: true, maxRepairRounds: 0 });
    return { ...directed, callerLimited: false };
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
