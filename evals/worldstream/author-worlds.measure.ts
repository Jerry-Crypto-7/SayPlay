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

import { groundTarget, buildRefineRequest, readRefineEmission } from '@/model/worldstream-refine';

import {
  askCodex,
  carryOver,
  changeOutcomeOf,
  outcomeOf,
  replayBlueprint,
  reportFrom,
  stillToAuthor,
  stillToChange,
  STORE_VERSION,
  withChange,
  withReject,
  withWorld,
  type AuthoredStore,
  type AuthoringReject,
  type AuthoringReport,
  type AuthoringResult,
} from './authoring';
import { readCorpus, type CreateCase, type RefineCase } from './lock.mjs';
import { driveCreateCase } from './measure-create';

const STORE_FILE = 'src/worldstream/authored-worlds.json';
const REPORT_FILE = 'evals/worldstream/authoring-report.json';

/**
 * Emise, které branou neprošly. **Není to sklad a do bundlu nejde.**
 *
 * ⚠ **Bez tohohle stojí každá diagnóza dalších 200 s.** Zahozená emise je
 * nejdražší artefakt téhle fáze — stojí jedno volání Codexu — a do 5. 9. 2026
 * se rovnou zahazovala. Otázku „proč `witness` odmítl pět vět" tak nešlo
 * zodpovědět jinak než uvařit je znovu a dívat se u toho. Uložená emise se
 * dá prohnat hledačem i verifikátorem **offline, zadarmo a kolikrát je
 * potřeba** — a to je jediný způsob, jak se dá kontrakt opravovat měřením
 * místo hádáním.
 *
 * Odsud se **nikdy nečte do produktu**: svět, který brána odmítla, je přesně
 * ten, co porotce vidět nesmí.
 */
const REJECTS_FILE = 'evals/worldstream/authoring-rejects.json';

function readRejects(): readonly AuthoringReject[] {
  try {
    return JSON.parse(readFileSync(REJECTS_FILE, 'utf8')) as AuthoringReject[];
  } catch {
    return [];
  }
}

/** Semínko relace píše měřidlo, ne model. Táž hodnota jako ve spiku. */
const SESSION_SEED = 4021;

/**
 * Kolik oprav dostane věta tady. **Šest, proti třem na živé cestě.**
 *
 * ⚠ **Naměřeno 5. 9. 2026 na prvních sedmnácti větách, ne odhadnuto.** Sedm
 * z jedenácti neúspěchů skončilo na čtyřech voláních, tedy na plánu a všech
 * třech kolech, a **ani jeden z nich se nezastavil na nepohnutém odmítnutí** —
 * kdyby se zastavil, volání by byla tři. Model tedy pořád opravoval a jen mu
 * došla kola. Že se poslední kolo vyplácí, ukazuje druhá strana téhož čísla:
 * **`c03` a `c15` se uložily až na čtvrté volání**, tedy dva z šesti světů,
 * které sklad má.
 *
 * Strop na živé cestě zůstává tři a nesahá se na něj: tam čeká porotce a každé
 * kolo je placené volání. Tady neplatí ani jedno — běh je nehlídaný a Codex
 * jede na předplatném (`G2`), takže kolo navíc stojí jen čas, kterého je dost.
 * Šest, ne „bez stropu": smyčka se musí umět vzdát, a zastavení na odmítnutí,
 * které už jednou padlo, je od `T12-oscillation` skutečná mez, ne dekorace.
 */
const AUTHOR_MAX_ROUNDS = 6;

function readStore(): AuthoredStore {
  try {
    return JSON.parse(readFileSync(STORE_FILE, 'utf8')) as AuthoredStore;
  } catch {
    return { version: STORE_VERSION, worlds: [] };
  }
}

/** Co naměřily předchozí dávky. Chybějící report není chyba — první dávka žádný nemá. */
function readPreviousResults(): readonly AuthoringResult[] {
  try {
    const report = JSON.parse(readFileSync(REPORT_FILE, 'utf8')) as AuthoringReport;
    return report.results;
  } catch {
    return [];
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
      // **`AUTHOR_SKIP_CREATE=1` pustí jen druhou fázi.** `AUTHOR_LIMIT` na to
      // nestačí, protože krátí obě naráz: nula první fáze je i nula druhé.
      // Naměřeno 6. 9. 2026 — devatenáct nezaložených světů je devatenáct už
      // jednou zahozených vět (`authoring-report.json`), takže jejich opakování
      // stojí ~70 minut a druhou fázi jen odloží.
      const skipCreate = process.env.AUTHOR_SKIP_CREATE === '1';
      let store = readStore();
      const todo = skipCreate
        ? []
        : stillToAuthor(corpus.create as CreateCase[], store).slice(0, limit);

      process.stdout.write(
        `\nsklad drží ${String(store.worlds.length)}, k uvaření ${String(todo.length)} z ${String(corpus.create.length)}\n\n`,
      );

      // Dávka pokračuje v reportu, nezakládá nový. Bez tohohle popisuje
      // poslední dávku a tváří se, že popisuje celou zmrazenou sadu.
      const results: AuthoringResult[] = [...carryOver(readPreviousResults(), todo)];
      let rejects: readonly AuthoringReject[] = readRejects();
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
              maxRounds: AUTHOR_MAX_ROUNDS,
            });
          } catch (thrown) {
            unavailable = thrown instanceof Error ? thrown.message.slice(0, 120) : String(thrown);
          }

          const seconds = (Date.now() - started) / 1000;
          const { kept, cause, detail } = outcomeOf({
            thrown: unavailable,
            blueprintValid: done?.blueprintValid ?? false,
            geometryAuthored: done?.geometryAuthored ?? false,
            failureStage: done?.failure?.stage ?? null,
            failureDetail: done?.failure?.detail ?? null,
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
              // Druhé věty vaří **druhá fáze** téhož běhu, až nad hotovým
              // světem: bez blueprintu není proti čemu psát operace, a ten
              // vznikne teprve tady. Nový svět tedy vstupuje bez změn a druhá
              // fáze si ho v téže dávce vyzvedne.
              changes: [],
            });
            // **Zápis po každé větě, ne na konci.** Nehlídaný běh se přeruší
            // výpadkem, restartem i Ctrl-C, a hodina práce se ztratit nesmí.
            writeFileSync(STORE_FILE, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
          } else {
            // Zahozená emise se **schová**, ne smaže. Stála jedno volání Codexu
            // a je to jediný materiál, nad kterým jde příčinu odmítnutí zkoumat
            // offline; bez ní se táž otázka platí znovu, celých 200 s.
            rejects = withReject(rejects, {
              id: entry.id,
              prompt: entry.prompt,
              cause,
              detail,
              planner: answers.planner,
              compiler: answers.compiler,
            });
            writeFileSync(REJECTS_FILE, `${JSON.stringify(rejects, null, 2)}\n`, 'utf8');
          }

          results.push({ id: entry.id, kept, cause, detail, seconds, calls });
          writeFileSync(
            REPORT_FILE,
            `${JSON.stringify(reportFrom(results, new Date().toISOString()), null, 2)}\n`,
            'utf8',
          );

          process.stdout.write(
            `${entry.id} ${kept ? 'uloženo' : `zahozeno (${cause ?? '—'})`} · ${String(Math.round(seconds))} s · ${String(calls)} volání` +
              `${detail === null ? '' : `\n   ${detail.slice(0, 160)}`}\n`,
          );
        }

        /* ---------------------------------------------------------- *
         * Druhá fáze: ke každému hotovému světu aspoň jedna změna.
         * ---------------------------------------------------------- */

        // **Až tady, ne v téže smyčce** (`T35-actsthree4`). Druhá věta se píše
        // proti hotovému blueprintu, takže svět uvařený o pár řádků výš je
        // teprve teď použitelný — a druhá fáze si ho v téže dávce vyzvedne.
        // Blueprint se přehraje ze skladu, takže **nestojí ani jedno volání**;
        // platí se jedině za samotnou změnu.
        const changesTodo = stillToChange(corpus.refine as RefineCase[], store).slice(0, limit);
        // Věta, na kterou se sahá znovu, zahazuje svůj starý verdikt — táž
        // úvaha jako u `carryOver()` výš. Bez toho by se `r12` v rozpadu
        // příčin počítala dvakrát, jednou zahozená a jednou uložená.
        const carried = carryOver(results, changesTodo);
        results.length = 0;
        results.push(...carried);

        process.stdout.write(`\nk uvaření ${String(changesTodo.length)} druhých vět\n\n`);

        for (const entry of changesTodo) {
          const started = Date.now();
          const world = store.worlds.find((candidate) => candidate.id === entry.createId)!;

          let thrown: string | null = null;
          let grounded = false;
          let accepted = false;
          let rejection: string | null = null;
          let answer: unknown = null;
          let stableId = '';
          let synonyms: readonly string[] = [];
          let calls = 0;

          try {
            const blueprint = await replayBlueprint(world, {
              grammar: grammar.value,
              sessionSeed: SESSION_SEED,
            });
            if (typeof blueprint === 'string') throw new Error(blueprint);

            // **Grounding je tentýž, který běží v route** — čistá funkce, žádné
            // volání. Věta, kterou nerozřeší, se modelu neposílá vůbec: v provozu
            // by skončila nabídkou kandidátů, ne změnou, takže by uvařená emise
            // neměla kde vzniknout ani k čemu být.
            // Sklad drží jen změny stojících objektů; věta, která staví
            // (P22 T13 `addition`), se neuvaří a nepošle.
            const target = groundTarget(entry.prompt, blueprint.objects);
            if (!target.ok || target.kind !== 'edit') {
              rejection = target.ok ? 'ADDITION' : target.reason;
            } else {
              grounded = true;
              stableId = target.target.stableId;
              synonyms = [target.target.label, ...target.target.synonyms];

              calls += 1;
              answer = askCodex(buildRefineRequest(entry.prompt, blueprint, target.target));
              // Táž brána, kterou emise projde v route. Uložit něco, co jí
              // neprojde, znamená nabídnout porotci zaručenou chybu.
              const read = readRefineEmission(answer, target.target);
              accepted = read.ok;
              if (!read.ok) rejection = `${read.reason}: ${read.detail}`;
            }
          } catch (error) {
            thrown = error instanceof Error ? error.message.slice(0, 160) : String(error);
          }

          const seconds = (Date.now() - started) / 1000;
          const outcome = changeOutcomeOf({ thrown, grounded, accepted, rejection });

          if (outcome.kept) {
            store = withChange(store, world.id, {
              id: entry.id,
              prompt: entry.prompt,
              stableId,
              synonyms,
              refine: answer,
            });
            writeFileSync(STORE_FILE, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
          }

          results.push({
            id: entry.id,
            kept: outcome.kept,
            cause: outcome.cause,
            detail: outcome.detail,
            seconds,
            calls,
          });
          writeFileSync(
            REPORT_FILE,
            `${JSON.stringify(reportFrom(results, new Date().toISOString()), null, 2)}\n`,
            'utf8',
          );

          process.stdout.write(
            `${entry.id} → ${world.id} ${outcome.kept ? 'uloženo' : `zahozeno (${outcome.cause ?? '—'})`} · ${String(Math.round(seconds))} s · ${String(calls)} volání` +
              `${outcome.detail === null ? '' : `\n   ${outcome.detail.slice(0, 160)}`}\n`,
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
