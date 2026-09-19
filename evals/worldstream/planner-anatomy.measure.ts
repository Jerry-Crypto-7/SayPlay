/**
 * **Co zabírá místo v odpovědi plánovače.**
 *
 * Doměření 19. 9. 2026 (`latency-p21.json`) řeklo, že plánovač je dnes
 * 75–80 s na 2,3 tis. výstupních tokenů proti 17 s ze 13. 9. Rozdíl není
 * uvažování, ale délka odpovědi: 13. 9. psal `intent` + `objects`, od P20 T05
 * píše i `sceneSpec`. Tenhle soubor to číslo rozloží po polích, aby zeštíhlení
 * (P21 T18) mířilo na to, co doopravdy váží, a ne na dojem.
 *
 * ## Jak se měří
 *
 * Bajty UTF-8 kompaktního `JSON.stringify` každého pole (tak model odpověď
 * píše, bez odsazení). `provenance` není jedno pole, ale rozsypané objekty
 * u požadavků, instancí, atributů, orientací i relací — sčítá se každý výskyt
 * uvnitř `sceneSpec`. `envelope` je zbytek celku po odečtení tří polí: klíče,
 * závorky a čárky.
 *
 * ## Proč archiv T18
 *
 * Je to jediný archiv se `sceneSpec` (17. 9. 2026), týž zdroj jako
 * `massing-preview.measure.ts`. Je gitignorovaný, takže čísla přežijí jen
 * v artefaktu `planner-anatomy.json`, a ten se commituje. Nula volání modelu.
 *
 *     npx vitest run --config vitest.measure.mts evals/worldstream/planner-anatomy.measure.ts
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readSceneSpec, slimSceneSpec, type SceneSpec } from '@/scene/spec';

const ARCHIVE = fileURLToPath(new URL('../../plans/P20/t18-hybrid-v2-20260917-1803/raw', import.meta.url));
const ARCHIVE_SOURCE = 'plans/P20/t18-hybrid-v2-20260917-1803/raw/*-planner.json (2026-09-17 archive)';
const REPORT_FILE = fileURLToPath(new URL('./planner-anatomy.json', import.meta.url));

interface PlannerAnswer {
  readonly intent?: unknown;
  readonly objects?: unknown;
  readonly sceneSpec?: {
    readonly requirements?: unknown;
    readonly instances?: readonly {
      readonly attributes?: unknown;
      readonly orientation?: unknown;
      readonly requirementIds?: unknown;
    }[];
    readonly relations?: unknown;
    readonly clarifications?: unknown;
  };
}

const bytes = (value: unknown): number => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value)));

/** Součet všech `provenance` objektů kdekoli uvnitř hodnoty. */
function provenanceBytes(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, entry) => sum + provenanceBytes(entry), 0);
  if (value === null || typeof value !== 'object') return 0;
  return Object.entries(value).reduce(
    (sum, [key, entry]) => sum + (key === 'provenance' ? bytes(entry) : provenanceBytes(entry)),
    0,
  );
}

function measure(answer: PlannerAnswer) {
  const spec = answer.sceneSpec ?? {};
  const instances = spec.instances ?? [];
  const sumOver = (pick: (instance: (typeof instances)[number]) => unknown) =>
    instances.reduce((sum, instance) => sum + bytes(pick(instance)), 0);
  const whole = bytes(answer);
  const intent = bytes(answer.intent);
  const objects = bytes(answer.objects);
  const sceneSpec = bytes(answer.sceneSpec);
  return {
    whole,
    intent,
    objects,
    sceneSpec,
    envelope: whole - intent - objects - sceneSpec,
    sceneSpecFields: {
      provenance: provenanceBytes(answer.sceneSpec),
      requirements: bytes(spec.requirements),
      instances: bytes(spec.instances),
      instanceAttributes: sumOver((instance) => instance.attributes),
      instanceOrientation: sumOver((instance) => instance.orientation),
      instanceRequirementIds: sumOver((instance) => instance.requirementIds),
      relations: bytes(spec.relations),
      clarifications: bytes(spec.clarifications),
    },
  };
}

type Measured = ReturnType<typeof measure>;

/**
 * **Štíhlý tvar (P21 T18) nad týmž archivem — dvě čísla, protože archiv
 * nevznikl podle štíhlého zadání.**
 *
 * `lossless` je `slimSceneSpec()` nad plným plánem: odebere jen to, co
 * `readSceneSpec` doplní zpět beze změny (round-trip drží), takže původ
 * instance, který se od požadavku liší třeba jen o slovo, zůstává. To je
 * **dolní odhad** úspory. `asPrompted` je tvar, o který zadání od T18 žádá:
 * bez `requirementIds`, bez původu u instancí a atributů, orientace jen
 * citovaná, nejvýš 6 atributů — tedy **odhad toho, co model napíše**, a ten
 * změří až T21 živě. Cíl ≤ 55 % celku je v artefaktu cíl, rozhoduje číslo.
 */
const SLIM_TARGET_SHARE = 0.55;

function asPrompted(spec: SceneSpec) {
  return {
    ...spec,
    instances: spec.instances.map(({ requirementIds: _ids, provenance: _origin, orientation, attributes, ...rest }) => ({
      ...rest,
      attributes: attributes.slice(0, 6).map(({ name, value }) => ({ name, value })),
      ...(orientation.provenance.kind === 'requested' ? { orientation } : {}),
    })),
  };
}

function slimBytes(answer: PlannerAnswer): { lossless: number; asPrompted: number } | null {
  const spec = readSceneSpec(answer.sceneSpec);
  if (typeof spec === 'string') return null;
  return {
    lossless: bytes({ ...answer, sceneSpec: slimSceneSpec(spec) }),
    asPrompted: bytes({ ...answer, sceneSpec: asPrompted(spec) }),
  };
}

describe('the anatomy of the archived planner answers', () => {
  it('writes the bytes per field and the share of each field in the whole answer', () => {
    expect(existsSync(ARCHIVE), `${ARCHIVE} is missing — it is gitignored`).toBe(true);
    const files = readdirSync(ARCHIVE).filter((name) => name.endsWith('-planner.json')).sort();

    const cases = files.map((file) => {
      const answer = (JSON.parse(readFileSync(`${ARCHIVE}/${file}`, 'utf8')) as { value: PlannerAnswer }).value;
      return { id: file.replace('-planner.json', ''), ...measure(answer), slim: slimBytes(answer) };
    });

    const mean = (pick: (entry: Measured) => number) =>
      Math.round(cases.reduce((sum, entry) => sum + pick(entry), 0) / cases.length);
    const average: Measured = {
      whole: mean((e) => e.whole),
      intent: mean((e) => e.intent),
      objects: mean((e) => e.objects),
      sceneSpec: mean((e) => e.sceneSpec),
      envelope: mean((e) => e.envelope),
      sceneSpecFields: {
        provenance: mean((e) => e.sceneSpecFields.provenance),
        requirements: mean((e) => e.sceneSpecFields.requirements),
        instances: mean((e) => e.sceneSpecFields.instances),
        instanceAttributes: mean((e) => e.sceneSpecFields.instanceAttributes),
        instanceOrientation: mean((e) => e.sceneSpecFields.instanceOrientation),
        instanceRequirementIds: mean((e) => e.sceneSpecFields.instanceRequirementIds),
        relations: mean((e) => e.sceneSpecFields.relations),
        clarifications: mean((e) => e.sceneSpecFields.clarifications),
      },
    };
    const share = (value: number) => Math.round((value / average.whole) * 1000) / 1000;
    const shareOfWhole: Record<string, number> = {
      intent: share(average.intent),
      objects: share(average.objects),
      sceneSpec: share(average.sceneSpec),
      envelope: share(average.envelope),
      ...Object.fromEntries(
        Object.entries(average.sceneSpecFields).map(([key, value]) => [`sceneSpec.${key}`, share(value)]),
      ),
    };

    const slimmed = cases.flatMap((entry) => (entry.slim === null ? [] : [entry.slim]));
    const slimMean = (pick: (entry: { lossless: number; asPrompted: number }) => number) =>
      Math.round(slimmed.reduce((sum, entry) => sum + pick(entry), 0) / Math.max(1, slimmed.length));
    const slim = {
      readable: slimmed.length,
      target: { shareOfWhole: SLIM_TARGET_SHARE, note: 'P21 T18 goal, stated as a goal – the measured number decides, not this line' },
      lossless: { averageBytes: slimMean((e) => e.lossless), shareOfWhole: share(slimMean((e) => e.lossless)), method: 'slimSceneSpec() over the full archived plan; readSceneSpec() restores it byte for byte' },
      asPrompted: { averageBytes: slimMean((e) => e.asPrompted), shareOfWhole: share(slimMean((e) => e.asPrompted)), method: 'what the planner prompt asks for since T18: no requirementIds, no instance/attribute provenance, orientation only when requested, at most 6 attributes — an estimate of the next live answer, measured by T21' },
    };

    const report = {
      measuredAt: new Date().toISOString(),
      kind: 'byte anatomy of archived planner answers — zero model calls, no HTTP',
      source: ARCHIVE_SOURCE,
      method:
        'UTF-8 bytes of compact JSON.stringify per field; sceneSpec.provenance sums every nested provenance object; envelope = whole - intent - objects - sceneSpec',
      plans: files.length,
      average,
      shareOfWhole,
      slim,
      cases,
    };
    writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const pct = (value: number | undefined) => `${String(Math.round((value ?? 0) * 100))} %`;
    const f = average.sceneSpecFields;
    process.stdout.write(
      [
        '',
        `plans               ${String(files.length)}`,
        `whole answer        ${String(average.whole)} B`,
        `  intent + objects  ${String(average.intent + average.objects)} B (${pct(shareOfWhole.intent + shareOfWhole.objects)})`,
        `  sceneSpec         ${String(average.sceneSpec)} B (${pct(shareOfWhole.sceneSpec)})`,
        `    provenance      ${String(f.provenance)} B (${pct(shareOfWhole['sceneSpec.provenance'])})`,
        `    instances       ${String(f.instances)} B (orientation ${String(f.instanceOrientation)}, attributes ${String(f.instanceAttributes)}, requirementIds ${String(f.instanceRequirementIds)})`,
        `    requirements    ${String(f.requirements)} B`,
        `    relations       ${String(f.relations)} B`,
        `    clarifications  ${String(f.clarifications)} B`,
        `slim (T18)          lossless ${String(slim.lossless.averageBytes)} B (${pct(slim.lossless.shareOfWhole)}) · as prompted ${String(slim.asPrompted.averageBytes)} B (${pct(slim.asPrompted.shareOfWhole)}) · target ${pct(SLIM_TARGET_SHARE)}`,
        '',
        `written to ${REPORT_FILE}`,
        '',
      ].join('\n'),
    );

    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((entry) => entry.envelope > 0)).toBe(true);
  });
});
