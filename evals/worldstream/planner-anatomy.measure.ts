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

describe('the anatomy of the archived planner answers', () => {
  it('writes the bytes per field and the share of each field in the whole answer', () => {
    expect(existsSync(ARCHIVE), `${ARCHIVE} is missing — it is gitignored`).toBe(true);
    const files = readdirSync(ARCHIVE).filter((name) => name.endsWith('-planner.json')).sort();

    const cases = files.map((file) => ({
      id: file.replace('-planner.json', ''),
      ...measure((JSON.parse(readFileSync(`${ARCHIVE}/${file}`, 'utf8')) as { value: PlannerAnswer }).value),
    }));

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

    const report = {
      measuredAt: new Date().toISOString(),
      kind: 'byte anatomy of archived planner answers — zero model calls, no HTTP',
      source: ARCHIVE_SOURCE,
      method:
        'UTF-8 bytes of compact JSON.stringify per field; sceneSpec.provenance sums every nested provenance object; envelope = whole - intent - objects - sceneSpec',
      plans: files.length,
      average,
      shareOfWhole,
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
        '',
        `written to ${REPORT_FILE}`,
        '',
      ].join('\n'),
    );

    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((entry) => entry.envelope > 0)).toBe(true);
  });
});
