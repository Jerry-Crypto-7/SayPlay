/**
 * **Codex uvaří světy dopředu.** `npm run author:worlds`.
 *
 * Model se tímhle stěhuje z běhu do přípravy. Důvod je naměřený a neměnný:
 * `codex exec` je lokální program přihlášený předplatným (žádný HTTP endpoint,
 * takže ho serverless funkce zavolat nemůže) a jedna věta stojí ~150 s proti
 * rozpočtu 3 s. Jako **autor** ale stačí: běh je nehlídaný, zdarma a jeho
 * výsledek jde do bundle.
 *
 * ## Uloží se jen svět, který prošel branami
 *
 * Emise se nepíše do skladu proto, že dorazila, ale proto, že ji přijal
 * `compileBlueprint()` **a** postavila se z ní geometrie. Harness je proto
 * `driveCreateCase()` — táž cesta, kterou měří `T14` nad placeným modelem.
 * Vlastní zjednodušený průchod by uložil něco, co brány nikdy neviděly.
 *
 * ## Běh je přerušitelný a druhý běh nedělá hotovou práci
 *
 * Sklad i report se zapisují **po každé větě**, ne na konci. Přerušený běh tak
 * neztratí nic a `stillToAuthor()` na příště přeskočí, co už uvnitř je.
 * `AUTHOR_LIMIT=5` uvaří pět vět a skončí — 30 vět je ~75 minut a plán říká
 * pouštět to po dávkách.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { frozenGrammar } from '@/model/client';
import { requestStage } from '@/model/worldstream-prompt';
import type { UpstreamRequest } from '@/model/prompt';
import { createMeshClient } from '@/shape/mesh-client';

import {
  askCodex,
  outcomeOf,
  reportFrom,
  stillToAuthor,
  STORE_VERSION,
  withWorld,
  type AuthoredStore,
  type AuthoringResult,
} from './authoring';
import { readCorpus, type CreateCase } from './lock.mjs';
import { driveCreateCase } from './measure-create';

const STORE_FILE = 'src/worldstream/authored-worlds.json';
const REPORT_FILE = 'evals/worldstream/authoring-report.json';

/** Semínko relace píše měřidlo, ne model. Táž hodnota jako ve spiku. */
const SESSION_SEED = 4021;

function readStore(): AuthoredStore {
  try {
    return JSON.parse(readFileSync(STORE_FILE, 'utf8')) as AuthoredStore;
  } catch {
    return { version: STORE_VERSION, worlds: [] };
  }
}

describe('Codex uvaří světy dopředu', () => {
  it(
    'projde zmrazenou sadu a uloží jen to, co prošlo branami',
    async () => {
      const corpus = readCorpus();
      const grammar = frozenGrammar();
      if (!grammar.ok) throw new Error(`${grammar.reason}: ${grammar.detail}`);

      const limit = Number(process.env.AUTHOR_LIMIT ?? '30');
      let store = readStore();
      const todo = stillToAuthor(corpus.create as CreateCase[], store).slice(0, limit);

      process.stdout.write(
        `\nsklad drží ${String(store.worlds.length)}, k uvaření ${String(todo.length)} z ${String(corpus.create.length)}\n\n`,
      );

      const results: AuthoringResult[] = [];
      const mesh = createMeshClient({ allowMainThread: true });

      try {
        for (const entry of todo) {
          const started = Date.now();
          // **Obě emise, rozlišené podle žádaných polí.** Ne podle pořadí:
          // opravné kolo pošle compiler požadavek znovu, takže „druhé volání je
          // compiler" se rozbije při prvním odmítnutí (naměřeno 5. 9. 2026).
          const answers: { planner: unknown; compiler: unknown } = {
            planner: null,
            compiler: null,
          };
          let calls = 0;
          let unavailable: string | null = null;

          const emit = (request: UpstreamRequest): Promise<unknown> => {
            calls += 1;
            const answer = askCodex(request);
            const stage = requestStage(request);
            if (stage === 'planner') answers.planner = answer;
            if (stage === 'compiler') answers.compiler = answer;
            return Promise.resolve(answer);
          };

          let done;
          try {
            done = await driveCreateCase(entry, {
              emit,
              mesh: mesh.mesh,
              grammar: grammar.value,
              sessionSeed: SESSION_SEED,
            });
          } catch (thrown) {
            unavailable = thrown instanceof Error ? thrown.message.slice(0, 120) : String(thrown);
          }

          const seconds = (Date.now() - started) / 1000;
          const { kept, cause } = outcomeOf({
            thrown: unavailable,
            blueprintValid: done?.blueprintValid ?? false,
            geometryAuthored: done?.geometryAuthored ?? false,
            failureStage: done?.failure?.stage ?? null,
            planner: answers.planner,
            compiler: answers.compiler,
          });

          if (kept) {
            const plan = answers.planner as {
              objects: readonly { stableId: string; role: string; synonyms?: readonly string[] }[];
            };
            store = withWorld(store, {
              id: entry.id,
              prompt: entry.prompt,
              heroObjects: plan.objects
                .filter((object) => object.role === 'hero')
                .map((object) => object.stableId),
              synonyms: plan.objects.flatMap((object) => object.synonyms ?? []),
              planner: answers.planner,
              compiler: answers.compiler,
            });
            // **Zápis po každé větě, ne na konci.** Nehlídaný běh se přeruší
            // výpadkem, restartem i Ctrl-C, a hodina práce se ztratit nesmí.
            writeFileSync(STORE_FILE, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
          }

          results.push({ id: entry.id, kept, cause, seconds, calls });
          writeFileSync(
            REPORT_FILE,
            `${JSON.stringify(reportFrom(results, new Date().toISOString()), null, 2)}\n`,
            'utf8',
          );

          process.stdout.write(
            `${entry.id} ${kept ? 'uloženo' : `zahozeno (${cause ?? '—'})`} · ${String(Math.round(seconds))} s · ${String(calls)} volání\n`,
          );
        }
      } finally {
        mesh.dispose();
      }

      const report = reportFrom(results, new Date().toISOString());
      process.stdout.write(
        `\n${String(report.kept)}/${String(report.attempted)} uloženo, sklad drží ${String(store.worlds.length)}, ${String(Math.round(report.secondsTotal / 60))} min\n` +
          `${Object.entries(report.causes).map(([cause, count]) => `  ${cause}: ${String(count)}`).join('\n')}\n`,
      );

      // Běh nic negatuje — brána nad naplněností skladu je `G2`. Tvrdí se
      // jediné: doběhl a zapsal, co uvařil.
      expect(store.worlds.length).toBeGreaterThan(0);
    },
    4 * 60 * 60_000,
  );
});
