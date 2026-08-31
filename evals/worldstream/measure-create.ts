/**
 * **Živé měřidlo create cesty (P13 T14).**
 *
 * Jedna otázka: **staví model doopravdy prostor, který ta věta popisuje?**
 * Třicet zmrazených vět projde celým řetězem — planner, compiler se
 * sebeopravou, sloty a hrubý svět — a z toho vznikne `create-report.json`,
 * podle kterého se rozhoduje, jestli vlna 3 vůbec začne.
 *
 * ## Proč to není Playwright, na rozdíl od `evals/measure-corpus.ts`
 *
 * Ta starší cesta běžela v prohlížeči, protože model počítal na WebGPU.
 * Cloudový model (vlna 2 T9) žádné GPU nechce a meshovač umí spočítat tvar
 * i na hlavním vlákně (`allowMainThread` v `src/shape/mesh-client.ts`), takže
 * celé měření je obyčejný Node skript. Ušetří to prohlížeč na kritické cestě
 * měření a hlavně to dovolí **pustit celý řetěz v jednotkovém testu** proti
 * atrapě modelu — což je jediný způsob, jak ověřit samotné měřidlo, aniž by
 * se za každý běh platilo.
 *
 * ## Co se soudí a co ne
 *
 * Měřidlo **nesoudí krásu**. Soudí, že to, co model napsal, je jeho vlastní
 * geometrie, že z ní vznikl svět, který se dá dohrát, a že třicet vět nedalo
 * třicetkrát tentýž prostor. Vzhled posuzuje člověk v bráně H2.
 *
 * ## Fallback se do autorství nepočítá — to je celý smysl toho pole
 *
 * `geometryAuthored` je pravda jen tehdy, když se model o geometrii **dostal
 * na obrazovku**: každý slot hrubého světa stojí na příčce `g3-reduced` nebo
 * `g2-rich`. Jakmile byť jediný objekt spadne na `semantic-clay`, autorství
 * pro tu větu neplatí. Bez toho pravidla by měřidlo hlásilo devadesát procent
 * i nad světem, který je celý z beden — a přesně tahle záměna („hezká kulisa
 * ke každé větě") je nemoc, ze které se P13 léčí.
 */

import { performance } from 'node:perf_hooks';

import { compileWithRepair, type BlueprintOutcome } from '@/model/worldstream-repair';
import {
  buildIntentRequest,
  readPlannerEmission,
  type PlannerEmission,
} from '@/model/worldstream-intent';
import type { Grammar, UpstreamRequest } from '@/model/prompt';
import type { MeshOrder, MeshResult } from '@/shape/mesh-client';
import type { GeomProgram } from '@/geom/program';
import { buildProxyWorld, type ProxyRung, type ProxyWorld } from '@/worldstream/proxy';
import type { WorldstreamBlueprint } from '@/worldstream/schema';

import type { CreateCase } from './lock.mjs';

/* ------------------------------------------------------------------ *
 * Brány.
 * ------------------------------------------------------------------ */

/** Podíl vět, u kterých se model o geometrii dostal na obrazovku. Z AC T14. */
export const GEOMETRY_AUTHORED_FLOOR = 0.9;

/** p95 od věty k hotovému hrubému světu. Slib produktu je „do tří sekund". */
export const ROUGH_WORLD_P95_MS = 3_000;

/**
 * Jak blízko si dva světy z **různých** vět smějí být.
 *
 * **Odkud to číslo je.** Brána H1 naměřila na `docs/contact-sheet.png`, že
 * pět z šesti vět dalo tutéž kompozici — týž prstenec kulisy kolem téže
 * mřížkové podlahy — a lišila se jen atmosféra. Profil níž atmosféru
 * **schválně nevidí** (počítá kusy a jejich rozmístění, ne `world.look`),
 * takže takové dvojici vyjde vzdálenost prakticky nula. Práh proto nemusí být
 * jemný, aby tu naměřenou vadu chytil; musí být jen nenulový.
 *
 * ⚠ **Je to podlaha, ne kalibrovaná mez.** Jemnější číslo se nedá stanovit
 * bez dat z živého běhu, a hádat ho by znamenalo vyrobit práh, který nic
 * neměří. Report proto nese **celou matici vzdáleností**, aby se dal po
 * prvním běhu nastavit z naměřeného, ne z názoru.
 */
export const WORLD_DISTANCE_FLOOR = 0.05;

/**
 * Fáze, na které se selhání rozpadá. Šest, jak je jmenuje úloha.
 *
 * `geom` a `shape` jsou dvě větve mezijazyka, `schema` je tvar odpovědi,
 * `reference` vazby uvnitř dokumentu, `lowering` a `witness` dva konce
 * certifikace světa. `planner` je sedmá a stojí mimo tu šestici schválně:
 * když selže planner, o compileru se nic nezměřilo.
 */
export const FAILURE_STAGES = [
  'planner',
  'schema',
  'reference',
  'geom',
  'shape',
  'lowering',
  'witness',
  'unavailable',
] as const;

export type FailureStage = (typeof FAILURE_STAGES)[number];

/* ------------------------------------------------------------------ *
 * Scrubbing — syrové odpovědi se archivují, klíče ne.
 * ------------------------------------------------------------------ */

/**
 * Vzory, které se v archivu nahradí značkou.
 *
 * **Uzavřený seznam tvarů, ne heuristika o entropii.** Klíč se pozná podle
 * toho, jak vypadá, a poskytovatelů je pár; „řetězec, co vypadá náhodně" by
 * naopak maskoval hashe světa, semínka a identifikátory, tedy přesně to, kvůli
 * čemu se archiv pořizuje.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\bghp_[A-Za-z0-9]{20,}/g,
];

/** Hlavičky, které se do archivu nedostanou vůbec. Malými písmeny. */
const SECRET_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

export const REDACTED = '[redacted]';

/** Klíče v textu. Vrací nový řetězec; vstup se nemění. */
export function scrubText(text: string): string {
  return SECRET_PATTERNS.reduce((carry, pattern) => carry.replace(pattern, REDACTED), text);
}

/**
 * Hlavičky do archivu.
 *
 * Jmenované se **nahrazují**, ne mažou: prázdno by se četlo jako „hlavička
 * tam nebyla", a to je jiná informace než „byla a je utajená". Zbytek projde
 * scrubbingem textu, protože klíč umí přistát i v `user-agent`.
 */
export function scrubHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    clean[name] = SECRET_HEADERS.has(name.toLowerCase()) ? REDACTED : scrubText(value);
  }
  return clean;
}

/** Cokoli, co jde do archivu. Projde stromem a vyčistí každý řetězec. */
export function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item));
  if (value !== null && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      clean[key] = SECRET_HEADERS.has(key.toLowerCase()) ? REDACTED : scrubDeep(nested);
    }
    return clean;
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Rozmanitost — vzdálenost dvou světů.
 * ------------------------------------------------------------------ */

/**
 * Otisk kompozice. **Dvě osy, obě o prostoru, žádná o atmosféře.**
 *
 * - `palette` — čím je svět postavený: histogram druhů uzlů kompozice
 *   a druhů uzlů hrdinských tvarů. Dva světy ze stejných kusů jsou si blízko,
 *   i když mají jiné barvy.
 * - `layout` — kde ty věci stojí: kvádry sémantických objektů, seřazené,
 *   v jednotkách světa. Tohle chytá „týž prstenec kolem téže podlahy".
 *
 * `world.look` se **nezapočítává schválně**. Právě atmosféra byla to jediné,
 * čím se lišilo pět z šesti světů na `docs/contact-sheet.png`, takže profil,
 * který ji vidí, by tu vadu rozmazal.
 */
export interface WorldProfile {
  readonly palette: Readonly<Record<string, number>>;
  readonly layout: readonly (readonly number[])[];
}

function countKinds(target: Record<string, number>, prefix: string, kinds: readonly string[]): void {
  for (const kind of kinds) {
    const key = `${prefix}:${kind}`;
    target[key] = (target[key] ?? 0) + 1;
  }
}

export function worldProfile(blueprint: WorldstreamBlueprint): WorldProfile {
  const palette: Record<string, number> = {};
  const geometry = blueprint.geometry as GeomProgram;
  countKinds(
    palette,
    'geom',
    geometry.nodes.map((node) => ('variant' in node ? `${node.kind}.${node.variant}` : node.kind)),
  );
  for (const shape of blueprint.shapes) {
    countKinds(
      palette,
      'shape',
      shape.nodes.map((node) => node.kind),
    );
  }

  // Kvádry se řadí, ne indexují: pořadí objektů píše planner podle věty, takže
  // dva stejné světy s objekty v jiném pořadí musí vyjít stejně.
  const layout = blueprint.objects
    .map((object) => [
      object.targetBounds.min[0],
      object.targetBounds.min[1],
      object.targetBounds.min[2],
      object.targetBounds.max[0],
      object.targetBounds.max[1],
      object.targetBounds.max[2],
    ])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);

  return { palette, layout };
}

/** Kosinová vzdálenost dvou histogramů, v ⟨0, 1⟩. Prázdný proti prázdnému je 0. */
function paletteDistance(first: WorldProfile, second: WorldProfile): number {
  const keys = new Set([...Object.keys(first.palette), ...Object.keys(second.palette)]);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const key of keys) {
    const left = first.palette[key] ?? 0;
    const right = second.palette[key] ?? 0;
    dot += left * right;
    leftNorm += left * left;
    rightNorm += right * right;
  }
  if (leftNorm === 0 && rightNorm === 0) return 0;
  if (leftNorm === 0 || rightNorm === 0) return 1;
  return 1 - dot / Math.sqrt(leftNorm * rightNorm);
}

/**
 * Rozdíl rozmístění, znormovaný na rozsah světa.
 *
 * Světy s různým počtem objektů se srovnávají po dvojicích, kolik jich mají
 * společně, a rozdíl v počtu se počítá jako plný nesoulad — jinak by svět
 * o jednom objektu vyšel blízko každému.
 */
function layoutDistance(first: WorldProfile, second: WorldProfile): number {
  const shared = Math.min(first.layout.length, second.layout.length);
  const total = Math.max(first.layout.length, second.layout.length);
  if (total === 0) return 0;

  let sum = 0;
  for (let index = 0; index < shared; index += 1) {
    let box = 0;
    for (let axis = 0; axis < 6; axis += 1) {
      // 128 je plný rozsah světových souřadnic (±64), takže jedna osa přispěje
      // nejvýš jedničkou a součet zůstane porovnatelný mezi běhy.
      box += Math.min(1, Math.abs(first.layout[index][axis] - second.layout[index][axis]) / 128);
    }
    sum += box / 6;
  }
  sum += total - shared;
  return sum / total;
}

/** Vzdálenost dvou světů v ⟨0, 1⟩. Nula znamená „tentýž prostor". */
export function worldDistance(first: WorldProfile, second: WorldProfile): number {
  return 0.6 * paletteDistance(first, second) + 0.4 * layoutDistance(first, second);
}

/* ------------------------------------------------------------------ *
 * Jeden případ.
 * ------------------------------------------------------------------ */

export interface CaseOutcome {
  readonly id: string;
  readonly category: string;
  readonly intentValid: boolean;
  readonly blueprintValid: boolean;
  /** Model napsal geometrii **a ta se dostala na obrazovku** — žádný fallback. */
  readonly geometryAuthored: boolean;
  readonly worldValid: boolean;
  readonly certified: boolean;
  /** Od věty k hotovému hrubému světu, včetně meshingu hrdinů. */
  readonly latencyMs: number;
  /** Kolik kol sebeopravy to stálo. Jedno znamená „napoprvé". */
  readonly rounds: number;
  readonly failure: { readonly stage: FailureStage; readonly detail: string } | null;
  /** Příčky, na kterých sloty skončily. Prázdné, když svět nevznikl. */
  readonly rungs: readonly ProxyRung[];
  readonly profile: WorldProfile | null;
}

export interface CaseDeps {
  /** Model. Dostane požadavek, vrátí rozpársovanou odpověď. */
  readonly emit: (request: UpstreamRequest) => Promise<unknown>;
  readonly mesh: (order: MeshOrder) => Promise<MeshResult>;
  readonly grammar: Grammar;
  readonly sessionSeed: number;
  readonly now?: () => number;
}

/**
 * Fáze, na které to prasklo.
 *
 * `WORLD_REJECTED` nese fázi certifikace jen jako **předponu v textu**
 * (`worldstream-compiler.ts` skládá `${stage}: ${detail}`), takže se odsud
 * čte řetězcem. Je to křehké a je to zapsané: až routovaná úloha
 * `T12-worldstage` propustí `Rejection` celý, přečte se pole místo předpony.
 */
export function stageOfOutcome(outcome: BlueprintOutcome): FailureStage {
  if (outcome.kind === 'unavailable') return 'unavailable';
  if (outcome.kind === 'compiled') return 'schema';

  switch (outcome.fault.reason) {
    case 'GEOM_INVALID':
      return 'geom';
    case 'SHAPE_INVALID':
      return 'shape';
    case 'PLACEMENT_MISMATCH':
    case 'REFERENCE_BROKEN':
      return 'reference';
    case 'WORLD_REJECTED': {
      const prefix = outcome.fault.detail.split(':')[0]?.trim();
      if (prefix === 'lowering') return 'lowering';
      if (prefix === 'witness') return 'witness';
      if (prefix === 'references') return 'reference';
      return 'schema';
    }
    default:
      return 'schema';
  }
}

/** Autorská geometrie znamená, že žádný slot nespadl na hlínu. */
export function rungsAreAuthored(world: ProxyWorld): boolean {
  if (world.kind !== 'built') return false;
  return (
    world.slots.length > 0 &&
    world.slots.every((entry) => entry.form.rung === 'g3-reduced' || entry.form.rung === 'g2-rich')
  );
}

export async function driveCreateCase(entry: CreateCase, deps: CaseDeps): Promise<CaseOutcome> {
  const clock = deps.now ?? (() => performance.now());
  const started = clock();

  const empty = {
    id: entry.id,
    category: entry.category,
    blueprintValid: false,
    geometryAuthored: false,
    worldValid: false,
    certified: false,
    rungs: [] as readonly ProxyRung[],
    profile: null,
  };

  let plan: PlannerEmission;
  try {
    const emitted = await deps.emit(buildIntentRequest(entry.prompt));
    const read = readPlannerEmission(emitted);
    if (!read.ok) {
      return {
        ...empty,
        intentValid: false,
        latencyMs: clock() - started,
        rounds: 1,
        failure: { stage: 'planner', detail: `${read.reason}: ${read.detail}` },
      };
    }
    plan = read.value;
  } catch (error) {
    return {
      ...empty,
      intentValid: false,
      latencyMs: clock() - started,
      rounds: 1,
      failure: {
        stage: 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const outcome = await compileWithRepair({
    plan,
    grammar: deps.grammar,
    sessionSeed: deps.sessionSeed,
    emit: deps.emit,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  if (outcome.kind !== 'compiled') {
    return {
      ...empty,
      intentValid: true,
      latencyMs: clock() - started,
      rounds: outcome.rounds.length,
      failure: {
        stage: stageOfOutcome(outcome),
        detail: outcome.kind === 'unavailable' ? outcome.detail : outcome.fault.detail,
      },
    };
  }

  const world = await buildProxyWorld(outcome, { mesh: deps.mesh });
  const blueprint = outcome.result.value;
  const authored = rungsAreAuthored(world);

  return {
    id: entry.id,
    category: entry.category,
    intentValid: true,
    blueprintValid: true,
    geometryAuthored: authored,
    worldValid: world.kind === 'built',
    certified: outcome.result.verdict.body.outcome === 'CERTIFIED',
    latencyMs: clock() - started,
    rounds: outcome.rounds.length,
    failure: authored
      ? null
      : {
          // Blueprint prošel, ale na obrazovku se model nedostal. Je to jiné
          // selhání než odmítnutí a nesmí se s ním sloučit.
          stage: 'shape',
          detail:
            world.kind === 'built'
              ? `${world.slots.filter((entry_) => entry_.form.rung === 'semantic-clay').length} of ${world.slots.length} objects fell back to clay`
              : world.reason,
        },
    rungs: world.kind === 'built' ? world.slots.map((entry_) => entry_.form.rung) : [],
    profile: worldProfile(blueprint),
  };
}

/* ------------------------------------------------------------------ *
 * Report.
 * ------------------------------------------------------------------ */

export interface WorldPair {
  readonly a: string;
  readonly b: string;
  readonly distance: number;
}

export interface CreateReport {
  readonly measuredAt: string;
  readonly sessionSeed: number;
  readonly cases: readonly CaseOutcome[];
  readonly totals: {
    readonly attempted: number;
    readonly intentValid: number;
    readonly blueprintValid: number;
    readonly geometryAuthored: number;
    readonly worldValid: number;
    readonly certified: number;
  };
  readonly geometryAuthoredRate: number;
  readonly latencyP95Ms: number;
  readonly failuresByStage: Readonly<Record<FailureStage, number>>;
  /** Celá matice po dvojicích, seřazená od nejbližší. Kalibruje práh. */
  readonly pairs: readonly WorldPair[];
  readonly closestPair: WorldPair | null;
  /** Prázdné pole znamená, že běh prošel branami. */
  readonly gateFailures: readonly string[];
}

/** p95 tak, jak ho počítá zbytek repa: index `ceil(0,95 · n) − 1` na seřazeném. */
export function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

export function buildCreateReport(
  cases: readonly CaseOutcome[],
  meta: { readonly sessionSeed: number; readonly measuredAt: string },
): CreateReport {
  const totals = {
    attempted: cases.length,
    intentValid: cases.filter((entry) => entry.intentValid).length,
    blueprintValid: cases.filter((entry) => entry.blueprintValid).length,
    geometryAuthored: cases.filter((entry) => entry.geometryAuthored).length,
    worldValid: cases.filter((entry) => entry.worldValid).length,
    certified: cases.filter((entry) => entry.certified).length,
  };

  const failuresByStage = Object.fromEntries(
    FAILURE_STAGES.map((stage) => [stage, cases.filter((e) => e.failure?.stage === stage).length]),
  ) as Record<FailureStage, number>;

  const profiled = cases.filter(
    (entry): entry is CaseOutcome & { profile: WorldProfile } => entry.profile !== null,
  );
  const pairs: WorldPair[] = [];
  for (let i = 0; i < profiled.length; i += 1) {
    for (let j = i + 1; j < profiled.length; j += 1) {
      pairs.push({
        a: profiled[i].id,
        b: profiled[j].id,
        distance: worldDistance(profiled[i].profile, profiled[j].profile),
      });
    }
  }
  pairs.sort((left, right) => left.distance - right.distance);

  const geometryAuthoredRate =
    cases.length === 0 ? 0 : totals.geometryAuthored / cases.length;
  const latencyP95Ms = percentile95(cases.map((entry) => entry.latencyMs));
  const closestPair = pairs[0] ?? null;

  const gateFailures: string[] = [];
  if (geometryAuthoredRate < GEOMETRY_AUTHORED_FLOOR) {
    gateFailures.push(
      `geometryAuthored ${geometryAuthoredRate.toFixed(3)} is below the floor ${GEOMETRY_AUTHORED_FLOOR}`,
    );
  }
  if (latencyP95Ms > ROUGH_WORLD_P95_MS) {
    gateFailures.push(
      `p95 to a finished rough world is ${Math.round(latencyP95Ms)} ms, above ${ROUGH_WORLD_P95_MS} ms`,
    );
  }
  if (closestPair !== null && closestPair.distance < WORLD_DISTANCE_FLOOR) {
    gateFailures.push(
      `worlds ${closestPair.a} and ${closestPair.b} are ${closestPair.distance.toFixed(4)} apart, below the floor ${WORLD_DISTANCE_FLOOR}: two different sentences built the same space`,
    );
  }

  return {
    measuredAt: meta.measuredAt,
    sessionSeed: meta.sessionSeed,
    cases,
    totals,
    geometryAuthoredRate,
    latencyP95Ms,
    failuresByStage,
    pairs,
    closestPair,
    gateFailures,
  };
}
