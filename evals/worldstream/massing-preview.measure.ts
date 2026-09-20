/**
 * **Kolik archivovaných plánů uvidí porotce něco, a kolik nic.**
 *
 * Přísný náhled (`src/scene/intent-preview.ts`) je schválně úzký: relace, které
 * neumí rozvrhnout, radši odmítne. Naměřeno nad archivem série T18 tím
 * profilem projde **jeden plán z osmnácti** — zbylých sedmnáct porotců do
 * příchodu blueprintu nevidělo nic. `buildMassingPreview` staví hrubý hmotový
 * model, který žádnou relaci nečte, takže není co odmítnout; tenhle soubor to
 * číslo změří místo aby ho tvrdil.
 *
 * ## Proč archiv T18, a ne `create-raw.json`
 *
 * `evals/worldstream/create-raw.json` vznikl 6. 9. 2026, tedy dřív, než
 * planner začal vydávat `sceneSpec`. `buildIntentPreview` nad ním skončí na
 * `INVALID_SCENE_SPEC` u všech třiceti vět a porovnání obou cest by neměřilo
 * nic. Jediný archiv se `sceneSpec` je ten z 17. 9. 2026 — týž zdroj, který
 * pro fázi `layout` používá `replay-create.measure.ts`.
 *
 * ## Co po sobě nechá
 *
 * `massing-preview.json`, a ten se **commituje**: archiv je v `.gitignore`,
 * takže bez artefaktu by to číslo zůstalo jen v commit zprávě. Nestojí ani
 * jedno volání modelu — obě cesty jsou čistý deterministický kód nad
 * odpověďmi, které už na disku leží.
 *
 *     npx vitest run --config vitest.measure.mts evals/worldstream/massing-preview.measure.ts
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readPlannerEmission } from '@/model/worldstream-intent';
import { buildIntentPreview } from '@/scene/intent-preview';
import { buildMassingPreview, isMassingPreview } from '@/scene/massing-preview';

/** Musí sedět s `replay-create.measure.ts`, jinak by se měřil jiný běh. */
const SESSION_SEED = 4021;

const ARCHIVE = fileURLToPath(new URL('../../plans/P20/t18-hybrid-v2-20260917-1803/raw', import.meta.url));
const ARCHIVE_SOURCE = 'plans/P20/t18-hybrid-v2-20260917-1803/raw/*-planner.json (2026-09-17 archive)';
const REPORT_FILE = fileURLToPath(new URL('./massing-preview.json', import.meta.url));

describe('the rough massing preview over the archived planner emissions', () => {
  it('says how many plans get a preview, and compares it with the strict path on the same set', () => {
    expect(existsSync(ARCHIVE), `${ARCHIVE} is missing — it is gitignored`).toBe(true);
    const files = readdirSync(ARCHIVE).filter((name) => name.endsWith('-planner.json')).sort();

    const cases = files.map((file) => {
      const read = readPlannerEmission(
        (JSON.parse(readFileSync(`${ARCHIVE}/${file}`, 'utf8')) as { value?: unknown }).value,
      );
      if (!read.ok) return { id: file.replace('-planner.json', ''), readable: false as const, reason: read.reason };
      const strict = buildIntentPreview(read.value, { sessionSeed: SESSION_SEED });
      const massing = buildMassingPreview(read.value, { sessionSeed: SESSION_SEED });
      return {
        id: file.replace('-planner.json', ''),
        readable: true as const,
        objects: read.value.objects.length,
        strict: strict.ok ? 'preview' : strict.reason,
        massing: massing.ok
          ? {
              masses: massing.origins.length,
              plates: massing.origins.filter((origin) => origin.basis === 'ground-plate').length,
              // Nejmenší a největší hrana: hmoty ve špatném měřítku se poznají
              // tady, ne až na snímku.
              smallestEdgeM: Math.round(Math.min(...massing.origins.map((o) => o.size[0])) * 1000) / 1000,
              largestEdgeM: Math.round(Math.max(...massing.origins.map((o) => o.size[0])) * 1000) / 1000,
              rough: isMassingPreview(massing.preview),
              // Jedna hmota na jeden objekt rejstříku — kontrola, ne přání.
              perObject: massing.origins.length === read.value.objects.length
                && massing.preview.objects.length === read.value.objects.length,
            }
          : { refused: `${massing.reason}: ${massing.details.join('; ')}` },
      };
    });

    const readable = cases.filter((entry) => entry.readable);
    const withMassing = readable.filter((entry) => 'masses' in entry.massing);
    const withStrict = readable.filter((entry) => entry.strict === 'preview');
    const strictReasons = readable.reduce<Record<string, number>>((tally, entry) => {
      if (entry.strict === 'preview') return tally;
      return { ...tally, [entry.strict]: (tally[entry.strict] ?? 0) + 1 };
    }, {});

    const report = {
      measuredAt: new Date().toISOString(),
      kind: 'deterministic replay of archived planner emissions — zero model calls, no HTTP',
      source: ARCHIVE_SOURCE,
      sessionSeed: SESSION_SEED,
      plannerEmissions: files.length,
      readable: readable.length,
      strictPreviews: withStrict.length,
      massingPreviews: withMassing.length,
      strictRefusalsByReason: strictReasons,
      warnings: [
        'Coverage only: a block per object is not a claim that the massing resembles the sentence. Shapes, proportions and spacing come from role and importance, never from the model.',
        'The archive is gitignored, so this report is the only place the numbers survive a clean clone.',
      ],
      cases,
    };
    writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    process.stdout.write(
      [
        '',
        `planner emissions   ${String(files.length)} (readable ${String(readable.length)})`,
        `strict preview      ${String(withStrict.length)}/${String(readable.length)}`,
        `massing preview     ${String(withMassing.length)}/${String(readable.length)}`,
        `strict refusals     ${Object.entries(strictReasons).map(([reason, count]) => `${reason} ${String(count)}`).join(', ')}`,
        '',
        `written to ${REPORT_FILE}`,
        '',
      ].join('\n'),
    );

    // Jediná tvrzení téhle sady: každý čitelný plán dostal náhled, a v každém
    // je přesně jedna hmota na jeden objekt rejstříku plánovače.
    expect(withMassing.length).toBe(readable.length);
    expect(withMassing.every((entry) => 'perObject' in entry.massing && entry.massing.perObject)).toBe(true);
    expect(withMassing.every((entry) => 'rough' in entry.massing && entry.massing.rough)).toBe(true);
  });
});
