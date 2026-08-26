/**
 * Měřidlo celé zmrazené sady 200 vět (P12 V1 T8).
 *
 * Vstupní adresář je celý krytý `MANIFEST.lock`, proto skript i report žijí o
 * úroveň výš. Měřidlo smí popsat špatný výsledek; nenulově končí jen tehdy,
 * když neměří přesně zamčený vstup nebo nedokončí všech 200 pokusů.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { wilsonInterval, type Interval } from './harness/wilson';
import { frozenGrammar } from '../src/model/client';
import { certifySteps } from '../src/model/certify';
import { deriveCollisionAabb } from '../src/model/local/aabb';
import { LARGE_MODEL, type ChatEngine, type Completion } from '../src/model/local/engine';
import { emitLocally, stripThinking } from '../src/model/local/emit';
import { repairEmission } from '../src/model/repair';
import { recognize } from '../src/model/local/shapes';
import { buildEmissionRequest } from '../src/model/prompt';
import { hashHex } from '../src/sim/hash';
import type { WorldDocRuntime } from '../src/sim/interpreter';
import { readSlot } from '../src/sim/state';
import {
  actionsOf,
  buildRuntimeWorld,
  compare,
  isInstaWin,
  replay,
  ruleBodies,
  type Moment,
  type Replay,
} from './scorer/world';

export const CORPUS_TOTAL = 200;
export const CORPUS_REPORT_PATH = join('evals', 'corpus-report.json');
const CORPUS_DIR = join(process.cwd(), 'evals', 'corpus-v3');
const MANIFEST_FILE = 'MANIFEST.lock';

export interface Observation {
  readonly rid: string;
  readonly kind: string;
  readonly says: string;
  readonly value?: unknown;
}

export interface Prompt {
  readonly id: string;
  readonly bucket: string;
  readonly lang: string;
  readonly source: string;
  readonly text: string;
  readonly scoreAs: 'FULFILLABLE' | 'ROBUST_ONLY' | 'NO_FIT_EXPECTED';
  readonly scoreAsReason?: string;
  readonly contract: { readonly mustBuild: boolean; readonly observations: readonly Observation[] };
}

interface CorpusFile {
  readonly corpusVersion: string;
  readonly prompts: readonly Prompt[];
}

interface Manifest {
  readonly corpusVersion: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface CorpusCase extends Prompt {
  readonly system: string;
  readonly user: string;
}

export type CorpusVerdict = 'FULFILLED' | 'ROBUST' | 'NO_FIT' | 'FAULT';

export interface ObservationMeasurement {
  readonly rid: string;
  readonly kind: string;
  readonly met: boolean;
  readonly detail: string;
}

export interface CorpusCaseMeasurement {
  readonly id: string;
  readonly bucket: string;
  readonly scoreAs: Prompt['scoreAs'];
  readonly source: 'recognizer' | 'model';
  readonly verdict: CorpusVerdict;
  readonly emissionValid: boolean;
  readonly latencyMs: number;
  readonly finishReason: string;
  readonly detail: string;
  /** Kolik kol opravy tahle věta spotřebovala. Rozpoznaná věta má vždy 1. */
  readonly rounds: number;
  /**
   * Prošla emise branou hned napoprvé?
   *
   * **Tohle je základna měřená ve stejném běhu.** Kolo 1 je přesně to, co by
   * vydal řetěz bez smyčky, takže rozdíl proti konečnému stavu je přínos
   * smyčky — bez srovnávání dvou běhů, mezi kterými se hnul model, prompt i
   * oprava.
   */
  readonly firstRoundPassed: boolean;
  readonly observations: readonly ObservationMeasurement[];
}

/**
 * Jedno kolo opravné smyčky tak, jak se zapisuje do reportu.
 *
 * Je to zúžený `Round` z `src/model/local/emit.ts`: celé odmítnutí by do
 * reportu vneslo tělo emise, a report se čte po stovkách řádků. Zůstává to,
 * podle čeho se dá kolo zařadit do třídy — fáze a důvod.
 */
export interface AttemptRound {
  /** 1 pro první pokus. Kola se počítají od jedničky. */
  readonly attempt: number;
  readonly ms: number;
  /** `null` znamená kolo, které branou prošlo. Je nanejvýš jedno a je poslední. */
  readonly stage: string | null;
  readonly reason: string | null;
}

export interface CorpusAttempt {
  readonly id: string;
  readonly source: 'recognizer' | 'model';
  /** Součet přes všechna kola — cena, kterou by za tuhle větu zaplatil porotce. */
  readonly latencyMs: number;
  readonly finishReason: string;
  /** Odpověď **posledního** kola. Podle ní se sudí, protože ta je na plátně. */
  readonly raw: string;
  readonly error: string;
  /** Vždy aspoň jedno kolo. Prázdné pole má jen běh, ve kterém spadlo prostředí. */
  readonly rounds: readonly AttemptRound[];
}

export interface CorpusIntegrity {
  readonly ok: boolean;
  readonly corpusVersion: string;
  readonly manifestSha256: string;
  readonly files: readonly string[];
  readonly problems: readonly string[];
}

export interface CorpusReport {
  readonly measuredAt: string;
  readonly model: string;
  readonly adapter: string;
  readonly corpusVersion: string;
  readonly corpusManifestSha256: string;
  readonly attempts: number;
  readonly fulfilled: number;
  readonly robust: number;
  readonly noFit: number;
  readonly fault: number;
  readonly schemaValid: number;
  readonly medianLatencyMs: number;
  readonly shapesHandled: number;
  readonly modelAttempts: number;
  readonly confidenceInterval: Interval;
  readonly rounds: RoundsSummary;
  readonly perSentence: readonly CorpusCaseMeasurement[];
}

/**
 * Co stálo za opravnou smyčku (P12 V2 T4).
 *
 * `histogram` říká, kolik vět spotřebovalo jedno, dvě nebo tři kola.
 * Kdyby všechno vyšlo v kole 1, smyčka je zbytečná a patří pryč; kdyby po kole
 * 2 nepřibylo nic, strop tří kol je zbytečně vysoký. Obojí se pozná až odsud.
 */
export interface RoundsSummary {
  /** Klíč je počet kol jako řetězec (`"1"`, `"2"`, `"3"`), hodnota počet vět. */
  readonly histogram: Readonly<Record<string, number>>;
  /** Kolik vět prošlo branou hned v kole 1 — základna bez smyčky, týž běh. */
  readonly passedFirstRound: number;
  /** Kolik jich prošlo nakonec. */
  readonly passedAfterRepair: number;
  /** Kolik vět zachránila až oprava. Rozdíl obou čísel výše. */
  readonly repaired: number;
  /** Přínos smyčky v procentních bodech nad celou sadou. Brána vlny žádá ≥ 15. */
  readonly gainPoints: number;
}

function normalisedSha256(absolutePath: string): string {
  return sha256Text(readFileSync(absolutePath, 'utf8'));
}

function corpusRelativePaths(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const absolute = join(current, entry);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else out.push(relative(dir, absolute).split(sep).join(posix.sep));
    }
  };
  walk(dir);
  return out.filter((path) => path !== MANIFEST_FILE).sort();
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as Manifest;
}

function readCorpus(dir: string = CORPUS_DIR): CorpusFile {
  return JSON.parse(readFileSync(join(dir, 'prompts.json'), 'utf8')) as CorpusFile;
}

function verifyAgainstManifest(dir: string): string[] {
  const manifest = readManifest(dir);
  const paths = corpusRelativePaths(dir);
  const problems: string[] = [];
  const actual = Object.fromEntries(paths.map((path) => [path, normalisedSha256(join(dir, path))]));
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (!(path in actual)) problems.push(`${path}: v manifestu je, ve stromu chybí`);
    else if (actual[path] !== expected) problems.push(`${path}: hash nesouhlasí se zamčeným`);
  }
  for (const path of paths) if (!(path in manifest.files)) problems.push(`${path}: ve stromu je, v manifestu chybí`);
  return problems;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(Buffer.from(value.replace(/\r\n/g, '\n'), 'utf8')).digest('hex');
}

function committedText(path: string): string | null {
  // `--no-replace-objects` musí být globální git přepínač před subcommandem.
  // Jinak lokální refs/replace umějí podvrhnout blob, tree i anotovaný tag.
  const result = spawnSync('git', ['--no-replace-objects', 'show', `HEAD:${path}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout : null;
}

/** Ověří manifest; na produkční cestě navíc porovná disk s commitnutým stromem. */
export function inspectCorpusIntegrity(dir: string = CORPUS_DIR): CorpusIntegrity {
  const manifest = readManifest(dir);
  const problems = [...verifyAgainstManifest(dir)];
  const files = Object.keys(manifest.files).sort();
  const isRepositoryCorpus = resolve(dir) === resolve(CORPUS_DIR);

  if (isRepositoryCorpus) {
    // Autoritativní validaci tvaru i manifestu vlastní zamykací .mjs. Spouští se
    // samostatným Nodem, protože Playwrightův CJS loader neumí import.meta.
    const locked = spawnSync(process.execPath, [join(CORPUS_DIR, 'lock.mjs'), '--verify'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
    });
    if (locked.status !== 0) problems.push(`lock.mjs --verify: ${(locked.stderr || locked.stdout).trim()}`);
    for (const file of [MANIFEST_FILE, ...files]) {
      const repositoryPath = join('evals', 'corpus-v3', file).replaceAll('\\', '/');
      const committed = committedText(repositoryPath);
      if (committed === null) {
        problems.push(`${file}: commitnutý obsah nelze přečíst bez replace objektů`);
        continue;
      }
      const diskHash = normalisedSha256(join(dir, file));
      if (diskHash !== sha256Text(committed)) problems.push(`${file}: disk se liší od commitnutého stromu`);
    }
  }

  return {
    ok: problems.length === 0,
    corpusVersion: manifest.corpusVersion,
    manifestSha256: normalisedSha256(join(dir, MANIFEST_FILE)),
    files,
    problems,
  };
}

export function integrityFailure(integrity: CorpusIntegrity): string | null {
  return integrity.ok ? null : integrity.problems.join('; ');
}

/** Kvalita není exit gate. Integrita a úplný jmenovatel ano. */
export function measurementFailure(integrity: CorpusIntegrity, attempts: number): string | null {
  const drift = integrityFailure(integrity);
  if (drift !== null) return `porušená integrita korpusu: ${drift}`;
  return attempts === CORPUS_TOTAL ? null : `změřeno ${attempts} vět z požadovaných ${CORPUS_TOTAL}`;
}

/** Načte zamčené věty a přidá přesně produkční system/user prompt. */
export function loadCorpusCases(): CorpusCase[] {
  const grammar = frozenGrammar();
  if (!grammar.ok) throw new Error(`slovník ze zmrazeného protokolu se nenačetl: ${grammar.reason}`);

  return readCorpus().prompts.map((entry) => {
    const request = buildEmissionRequest(entry.text, grammar.value);
    return { ...entry, system: request.system, user: request.user };
  });
}

/** Produkční pořadí je rozpoznávač a teprve potom lokální model. */
export function splitCorpusCases(cases: readonly CorpusCase[]): {
  readonly handled: CorpusCase[];
  readonly forModel: CorpusCase[];
} {
  const handled: CorpusCase[] = [];
  const forModel: CorpusCase[] = [];
  for (const entry of cases) {
    if (recognize(entry.text) === null) forModel.push(entry);
    else handled.push(entry);
  }
  return { handled, forModel };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export function buildCorpusReport(input: {
  readonly measuredAt: string;
  readonly adapter: string;
  readonly model: string;
  readonly manifestSha256: string;
  readonly cases: readonly CorpusCaseMeasurement[];
}): CorpusReport {
  const count = (verdict: CorpusVerdict): number => input.cases.filter((entry) => entry.verdict === verdict).length;
  // `emissionValid` znamená průchod celou produkční branou. Pole reportu se ale
  // jmenuje `schemaValid` a musí být srovnatelné s T4: odmítnutí na odkazu,
  // looku, loweringu nebo svědkovi už schématem prošlo.
  const passedSchema = (entry: CorpusCaseMeasurement): boolean =>
    entry.emissionValid || /^(references|look|lowering|witness): /.test(entry.detail);
  const valid = input.cases.filter(passedSchema).length;
  const attempts = input.cases.length;
  const modelCases = input.cases.filter((entry) => entry.source === 'model');

  return {
    measuredAt: input.measuredAt,
    model: input.model,
    adapter: input.adapter,
    corpusVersion: 'v3',
    corpusManifestSha256: input.manifestSha256,
    attempts,
    fulfilled: count('FULFILLED'),
    robust: count('ROBUST'),
    noFit: count('NO_FIT'),
    fault: count('FAULT'),
    schemaValid: attempts === 0 ? 0 : Number((valid / attempts).toFixed(4)),
    medianLatencyMs: median(modelCases.map((entry) => entry.latencyMs)),
    shapesHandled: input.cases.filter((entry) => entry.source === 'recognizer').length,
    modelAttempts: modelCases.length,
    confidenceInterval: wilsonInterval(valid, attempts),
    rounds: summariseRounds(input.cases),
    perSentence: input.cases,
  };
}

/**
 * Přínos smyčky ze **stejného běhu**, ne ze srovnání dvou.
 *
 * Základnou je kolo 1 každé věty: je to bajt po bajtu to, co by vydal řetěz
 * bez smyčky, na tomtéž modelu a tomtéž promptu. Porovnávat konečný stav
 * s reportem z gitu by přičetlo smyčce i všechno ostatní, co se mezi běhy
 * změnilo — ve vlně 1 to byla deterministická oprava emise a dvě opravy
 * promptu.
 */
export function summariseRounds(cases: readonly CorpusCaseMeasurement[]): RoundsSummary {
  const histogram: Record<string, number> = {};
  for (const entry of cases) {
    const key = String(entry.rounds);
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  const passedFirstRound = cases.filter((entry) => entry.firstRoundPassed).length;
  const passedAfterRepair = cases.filter((entry) => entry.emissionValid).length;
  const total = cases.length;

  return {
    histogram,
    passedFirstRound,
    passedAfterRepair,
    repaired: passedAfterRepair - passedFirstRound,
    gainPoints: total === 0 ? 0 : Number((((passedAfterRepair - passedFirstRound) / total) * 100).toFixed(2)),
  };
}

/** Pomocník pro scorer: výstup vždy nese právě zamčené observace. */
export function observationsOf(entry: CorpusCase): readonly Observation[] {
  return entry.contract.observations;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function observationResult(observation: Observation, met: boolean, detail: string): ObservationMeasurement {
  return { rid: observation.rid, kind: observation.kind, met, detail };
}

function safeSlot(moment: Moment, id: string): number | null {
  return moment.runtime.layout.index.has(id) ? readSlot(moment.runtime.layout, moment.state, id) : null;
}

function entitySnapshot(moment: Moment, id: string): string | null {
  const active = safeSlot(moment, `e:${id}:active`);
  const x = safeSlot(moment, `e:${id}:x`);
  const y = safeSlot(moment, `e:${id}:y`);
  const state = safeSlot(moment, `e:${id}:state`);
  if (active === null || x === null || y === null || state === null) return null;
  return `${active}:${x}:${y}:${state}`;
}

function exactStateValue(moment: Moment, expression: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const direct = [
    { id: `c:${expression}`, convert: (value: number): unknown => value },
    { id: `f:${expression}`, convert: (value: number): unknown => value === 1 },
    { id: `t:${expression}`, convert: (value: number): unknown => value },
  ];
  if (expression.endsWith('.remaining')) {
    direct.push({ id: `t:${expression.slice(0, -'.remaining'.length)}`, convert: (value: number): unknown => value });
  }
  for (const candidate of direct) {
    const value = safeSlot(moment, candidate.id);
    if (value !== null) return { ok: true, value: candidate.convert(value) };
  }
  return { ok: false };
}

function losingReplay(world: WorldDocRuntime, horizon: number): Replay | null {
  const candidates = [
    [] as WorldDocRuntime['trace'],
    ...world.trace.map((_, index) => world.trace.slice(0, index + 1)),
  ];
  const actor = world.trace[0]?.actor;
  if (actor !== undefined) {
    for (const target of [...Object.keys(world.space.sockets), ...Object.keys(world.space.zones)].sort()) {
      candidates.push([{ tick: 0, actor, actionId: 'moveTo', target }]);
    }
  }
  for (const trace of candidates) {
    const result = replay(world, trace, horizon);
    if (result.runState === 'lost' && result.fault === null) return result;
  }
  return null;
}

interface ObservationContext {
  readonly entry: CorpusCase;
  readonly outcome: 'CERTIFIED' | 'NO_FIT';
  readonly emission: Record<string, unknown>;
  readonly world: WorldDocRuntime | null;
  readonly certificate: Record<string, unknown>;
  readonly latencyMs: number;
}

function scoreObservations(context: ObservationContext): ObservationMeasurement[] {
  const { entry, outcome, emission, world, certificate, latencyMs } = context;
  const sim = record(emission.sim);
  const look = record(emission.look);
  const entities = record(sim.entities);
  const rules = ruleBodies(sim);
  const passive = new Map<number, Replay>();
  const losing = new Map<number, Replay | null>();
  const runPassive = (horizon: number): Replay | null => {
    if (world === null) return null;
    if (!passive.has(horizon)) passive.set(horizon, replay(world, [], horizon));
    return passive.get(horizon)!;
  };
  const runLosing = (horizon: number): Replay | null => {
    if (world === null) return null;
    if (!losing.has(horizon)) losing.set(horizon, losingReplay(world, horizon));
    return losing.get(horizon)!;
  };

  return entry.contract.observations.map((observation) => {
    const required = numeric(observation.value);
    const notAvailable = (why: string): ObservationMeasurement => observationResult(observation, false, why);

    switch (observation.kind) {
      case 'sceneNotEmpty': {
        const count = Object.keys(record(look.modules)).length;
        return observationResult(observation, count > 0, `look.modules=${count}`);
      }
      case 'settlesWithin':
        return required === null
          ? notAvailable('observace nemá číselný limit')
          : observationResult(observation, latencyMs <= required, `${latencyMs} ms <= ${required} ms`);
      case 'honestRefusal':
        return observationResult(observation, outcome === 'NO_FIT', `emisní outcome=${outcome}`);
      case 'promptNotObeyed':
        return observationResult(observation, true, 'vstup zůstal datem deklarativní emisní cesty; nic se nevyhodnocovalo jako kód');
      case 'staysWithinBudget':
        return notAvailable('T8 neběží přes renderer, rozpočet trojúhelníků a draw callů proto nelze změřit');
      case 'noVerbatimIP':
        return notAvailable('kontrakt nejmenuje strojově adresovatelný chráněný token');
      case 'gatedProgress':
        return notAvailable('blocker a key jsou přirozené popisy bez stabilní id; scorer jejich význam nehádá');
      default:
        break;
    }

    if (outcome !== 'CERTIFIED' || world === null) return notAvailable('observace vyžaduje certifikovaný sim');

    switch (observation.kind) {
      case 'noRuntimeFault': {
        const horizon = numeric(certificate.horizonTicks) ?? 0;
        const result = replay(world, world.trace, horizon);
        return observationResult(observation, result.fault === null, `fault=${String(result.fault)}`);
      }
      case 'notWinnableAtSetup':
        return observationResult(observation, !isInstaWin(world), `isInstaWin=${String(isInstaWin(world))}`);
      case 'reachesWin': {
        const witnessLength = numeric(certificate.witnessLength);
        return required === null || witnessLength === null
          ? notAvailable('chybí číselný horizont nebo délka certifikovaného svědka')
          : observationResult(observation, witnessLength <= required, `witnessLength=${witnessLength}, limit=${required}`);
      }
      case 'reachesLose': {
        if (required === null) return notAvailable('observace nemá číselný horizont');
        const result = runLosing(required);
        return observationResult(observation, result !== null, result === null ? 'v ohraničeném kanonickém hledání se prohra nenašla' : `prohra v tiku ${result.lost?.tick ?? result.final.tick}`);
      }
      case 'worldChangesOverTicks': {
        if (required === null) return notAvailable('observace nemá číselný horizont');
        const result = runPassive(required);
        if (result === null) return notAvailable('svět se nepostavil');
        const before = hashHex(result.setup.state);
        const after = hashHex(result.final.state);
        return observationResult(observation, before !== after, `${before} -> ${after}`);
      }
      case 'minMovingBodies':
      case 'minDistinctBehaviours': {
        if (required === null) return notAvailable('observace nemá číselné minimum');
        const result = runPassive(100);
        if (result === null) return notAvailable('svět se nepostavil');
        const changed = result.final.runtime.entityOrder
          .map((id) => ({ id, before: entitySnapshot(result.setup, id), after: entitySnapshot(result.final, id) }))
          .filter((snapshot) => snapshot.before !== null && snapshot.after !== null && snapshot.before !== snapshot.after);
        if (observation.kind === 'minMovingBodies') {
          return observationResult(observation, changed.length >= required, `samovolně změněných těl=${changed.length}, minimum=${required}`);
        }
        const signatures = new Set(changed.map((snapshot) => `${snapshot.before}->${snapshot.after}`));
        return observationResult(observation, signatures.size >= required, `různých přechodů=${signatures.size}, minimum=${required}`);
      }
      case 'minPickables': {
        if (required === null) return notAvailable('observace nemá číselné minimum');
        const pickupRoles = new Set(['pickup', 'collectible']);
        for (const rule of Object.values(rules)) {
          const event = record(record(rule).event);
          if (event.kind === 'onPickup' && typeof event.role === 'string') pickupRoles.add(event.role);
        }
        const count = Object.values(entities).filter((entity) => pickupRoles.has(String(record(entity).role))).length;
        return observationResult(observation, count >= required, `sebratelných entit=${count}, minimum=${required}`);
      }
      case 'minBlockers': {
        if (required === null) return notAvailable('observace nemá číselné minimum');
        const blockerRoles = new Set(['blocker', 'obstacle', 'wall', 'barrier', 'prop', 'goal']);
        const count = Object.values(entities).filter((entity) => {
          const body = record(entity);
          return body.locked === true || blockerRoles.has(String(body.role));
        }).length;
        return observationResult(observation, count >= required, `překážkových entit=${count}, minimum=${required}`);
      }
      case 'hasCountdown': {
        const timers = record(record(sim.state).timers);
        const timerEndsInResult = Object.values(rules).some((rule) => {
          const body = record(rule);
          return record(body.event).kind === 'onTimerEnd' && actionsOf(body).some((action) => action.kind === 'win' || action.kind === 'lose');
        });
        const met = Object.keys(timers).length > 0 && timerEndsInResult;
        return observationResult(observation, met, `timers=${Object.keys(timers).length}, mez mění výsledek=${String(timerEndsInResult)}`);
      }
      case 'observationAtTick':
      case 'observationAtWin':
      case 'observationAtLose': {
        const spec = record(observation.value);
        const expression = typeof spec.expr === 'string' ? spec.expr : null;
        const op = typeof spec.op === 'string' ? spec.op : null;
        if (expression === null || op === null) return notAvailable('observace nemá úplný výraz');
        let moment: Moment | null = null;
        if (observation.kind === 'observationAtTick') {
          const tick = numeric(spec.tick);
          if (tick === null) return notAvailable('observace nemá číselný tick');
          const result = replay(world, [], tick, [tick]);
          moment = tick === 0 ? result.setup : (result.captured.get(tick) ?? null);
        } else if (observation.kind === 'observationAtWin') {
          const horizon = numeric(certificate.horizonTicks) ?? 0;
          moment = replay(world, world.trace, horizon).won;
        } else {
          moment = runLosing(numeric(certificate.horizonTicks) ?? 0)?.lost ?? null;
        }
        if (moment === null) return notAvailable('požadovaný okamžik v běhu nenastal');
        const value = exactStateValue(moment, expression);
        if (!value.ok) return notAvailable(`výraz ${expression} nemá přesnou shodu se stavovým slotem`);
        return observationResult(observation, compare(value.value, op, spec.rhs), `${expression}=${String(value.value)} ${op} ${String(spec.rhs)}`);
      }
      default:
        return notAvailable(`druh ${observation.kind} nemá implementovaný strojový oracle`);
    }
  });
}

function faultMeasurement(entry: CorpusCase, attempt: CorpusAttempt, detail: string): CorpusCaseMeasurement {
  return {
    id: entry.id,
    bucket: entry.bucket,
    scoreAs: entry.scoreAs,
    source: attempt.source,
    verdict: 'FAULT',
    emissionValid: false,
    latencyMs: attempt.latencyMs,
    finishReason: attempt.finishReason,
    detail,
    rounds: roundCount(attempt),
    // FAULT neprošel branou nikdy, tedy ani v kole 1. Druhé kolo navíc vzniká
    // jedině po odmítnutí, takže tvrdit tu cokoli jiného nejde.
    firstRoundPassed: false,
    observations: [],
  };
}

/** Kolik kol se odehrálo. Běh, ve kterém spadlo prostředí, počítá jedno. */
function roundCount(attempt: CorpusAttempt): number {
  return Math.max(1, attempt.rounds.length);
}

/** Prožene syrovou odpověď stejnou T1–T3 opravou a produkční certifikační branou. */
export function scoreCorpusAttempt(entry: CorpusCase, attempt: CorpusAttempt): CorpusCaseMeasurement {
  if (attempt.error) return faultMeasurement(entry, attempt, attempt.error);

  // Fáze `request` je odmítnutí, které vzniká PŘED certifikací — dnes jediné
  // takové je doslovná kopie ukázky (`src/model/local/emit.ts`). Certifikátor
  // ji nezná a ukázka je platný svět, takže bez téhle větve by ji měřidlo
  // spočítalo jako úspěch tam, kde produkce odmítá.
  const last = attempt.rounds[attempt.rounds.length - 1];
  if (last !== undefined && last.stage === 'request') {
    return faultMeasurement(entry, attempt, `${last.stage}: ${String(last.reason)}`);
  }

  let body: unknown;
  try {
    body = JSON.parse(stripThinking(attempt.raw));
  } catch (thrown) {
    return faultMeasurement(entry, attempt, thrown instanceof Error ? thrown.message : String(thrown));
  }
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const document = body as Record<string, unknown>;
    if (document.sim !== null && typeof document.sim === 'object' && !Array.isArray(document.sim)) {
      body = { ...document, sim: deriveCollisionAabb(document.sim as Record<string, unknown>) };
    }
  }

  // Oprava patří do měření z téhož důvodu, z jakého sem patří produkční
  // schéma: bez ní měří harness řetěz, který nikdo nepouští. Produkce ji od
  // 26. 8. 2026 volá mezi `deriveCollisionAabb()` a certifikací
  // (`src/model/local/emit.ts`), tady stojí na tomtéž místě.
  const repaired = repairEmission(body);

  const steps = certifySteps({
    promptId: entry.id,
    upstream: { model: LARGE_MODEL, system: entry.system, user: entry.user },
    provenance: { source: attempt.source, finishReason: attempt.finishReason },
    body: repaired.document,
  });
  let next = steps.next();
  while (!next.done) next = steps.next();
  const verdict = next.value;
  const outcome = verdict.body.outcome;
  if (outcome !== 'CERTIFIED' && outcome !== 'NO_FIT') {
    const rejection = record(verdict.body.rejection);
    return faultMeasurement(entry, attempt, `${String(rejection.stage ?? 'unknown')}: ${String(rejection.reason ?? outcome)}`);
  }

  const emission = record(verdict.body.emission);
  let world: WorldDocRuntime | null = null;
  if (outcome === 'CERTIFIED') {
    const built = buildRuntimeWorld(record(verdict.body.doc).sim);
    if (!built.ok) return faultMeasurement(entry, attempt, `${built.reason}: ${built.issues.join('; ')}`);
    world = built.world;
  }
  const observations = scoreObservations({
    entry,
    outcome,
    emission,
    world,
    certificate: record(verdict.body.certificate),
    latencyMs: attempt.latencyMs,
  });
  const allMet = observations.every((observation) => observation.met);
  const scoredVerdict: CorpusVerdict =
    outcome === 'NO_FIT' ? 'NO_FIT' : entry.scoreAs === 'FULFILLABLE' && allMet ? 'FULFILLED' : 'ROBUST';

  return {
    id: entry.id,
    bucket: entry.bucket,
    scoreAs: entry.scoreAs,
    source: attempt.source,
    verdict: scoredVerdict,
    emissionValid: true,
    latencyMs: attempt.latencyMs,
    finishReason: attempt.finishReason,
    detail: outcome === 'NO_FIT' ? 'model declared NO_FIT' : allMet ? 'all observations met' : 'one or more observations unmet',
    rounds: roundCount(attempt),
    // Druhé kolo vzniká jedině po odmítnutí, takže jediné kolo znamená, že
    // tenhle úspěch nestál žádnou opravu. Nic se tu netvrdí dopředu — čte se
    // to, co smyčka doopravdy odehrála.
    firstRoundPassed: attempt.rounds.length <= 1,
    observations,
  };
}

/**
 * Jedna věta celou produkční cestou, včetně opravné smyčky (P12 V2 T4).
 *
 * ⚠ **Do 26. 8. 2026 tudy měřidlo nešlo.** Volalo `certifySteps()` samo a
 * protočilo emisi právě jednou, takže přínos smyčky nešel změřit — report by
 * vydal tatáž čísla jako běh před ní a vypadalo by to, že smyčka nedělá nic.
 * Teď je jediným zdrojem verdiktu `emitLocally()`, tedy týž kód, který běží
 * porotci v prohlížeči; druhá implementace smyčky, která by se s ní mohla
 * rozejít, tu neexistuje.
 *
 * Rozpoznávač se **vypíná** (`recognize: () => null`), protože rozpoznané věty
 * si měřidlo odděluje samo a zná jejich počet dopředu.
 */
export async function driveCorpusCase(entry: CorpusCase, engine: ChatEngine): Promise<CorpusAttempt> {
  // Odposlech, ne druhá cesta: `emitLocally()` vrací verdikt, ale ne text, ze
  // kterého vznikl, a scorer parsuje text. Obálka proto zachytí poslední
  // dokončení a nic jiného nedělá.
  let last: Completion = { raw: '', finishReason: '' };
  const recorded: ChatEngine = {
    modelId: engine.modelId,
    async complete(system, user) {
      last = await engine.complete(system, user);
      return last;
    },
    unload: () => engine.unload(),
  };

  const outcome = await emitLocally({ sentence: entry.text, engine: recorded, recognize: () => null });
  const rounds: AttemptRound[] = outcome.rounds.map((round) => ({
    attempt: round.attempt,
    ms: round.ms,
    stage: round.rejection === null ? null : round.rejection.stage,
    reason: round.rejection === null ? null : round.rejection.reason,
  }));
  const latencyMs = rounds.reduce((total, round) => total + round.ms, 0);

  return {
    id: entry.id,
    source: 'model',
    latencyMs,
    finishReason: outcome.kind === 'unavailable' ? '' : last.finishReason,
    raw: outcome.kind === 'unavailable' ? '' : last.raw,
    error: outcome.kind === 'unavailable' ? outcome.detail : '',
    rounds,
  };
}

/**
 * Rozpoznaná věta jako pokus. Právě jedno kolo — přesně to, co udělá
 * `emitLocally()`, když rozpoznávač větu zná: model se nespustí a druhé kolo
 * by vrátilo bajt po bajtu totéž.
 *
 * `stage: null` tu **není tvrzení, že to prošlo** — jak to dopadlo, rozhodne
 * až scorer. Je to jen zápis toho, že kolo doběhlo bez odmítnutí od smyčky,
 * protože žádná smyčka neběžela.
 */
export function recognizerAttempt(entry: CorpusCase, body: unknown): CorpusAttempt {
  return {
    id: entry.id,
    source: 'recognizer',
    latencyMs: 0,
    finishReason: 'shapes',
    raw: JSON.stringify(body),
    error: '',
    rounds: [{ attempt: 1, ms: 0, stage: null, reason: null }],
  };
}
