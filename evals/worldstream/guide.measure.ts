/**
 * **Brána A6: kolikrát si průvodce vymyslí objekt, který ve světě není?**
 *
 * Celá ta funkce existuje kvůli jedinému číslu. Postava, která na otázku
 * odpoví plynule a přidá do cesty orientační bod navíc, se čte **líp** než
 * poctivá odpověď — a nikdo nepozná, kde ta nepravda vznikla, protože zbytek
 * věty pravdivý je. Měří se proto počet odpovědí, které jmenují objekt mimo
 * svět, a ten musí být nula. Všechno ostatní v artefaktu je kontext k němu.
 *
 *     npx vitest run --config vitest.measure.mts evals/worldstream/guide.measure.ts
 *
 * ## Deset otázek nad pěti světy, a kde se ty světy berou
 *
 * `src/worldstream/authored-worlds.json` — jedenáct emisí, které model
 * doopravdy napsal, zmrazené a commitnuté. Bere se **prvních pět, které se
 * postaví**, v pořadí souboru: výběr podle výsledku („ty, kde průvodce
 * odpovídá hezky") by měřil vlastní vkus.
 *
 * Na každý svět jdou dvě otázky, a každá se ptá na jinou třídu chyby:
 *
 * 1. **Na hrdinský objekt**, tedy na to, na co se ptá porotce. Tady se měří,
 *    jestli cesta vůbec vznikne a jestli ji certifikuje `verifyWitness`.
 * 2. **Na objekt, který v tom světě není.** Tady se měří to hlavní: odpověď
 *    smí jmenovat **jen slovo tazatele**, nikdy nejbližší existující objekt.
 *
 * ## Proč se certifikát počítá znovu
 *
 * `guideRoute()` vrací certifikát, který si vydal sám. Artefakt, který by ten
 * certifikát jen opsal, by dokazoval, že se implementace shoduje sama se
 * sebou. Stopa se proto pouští **znovu** přes `verifyWitness` a do artefaktu
 * jde tenhle druhý verdikt.
 *
 * ## Co po sobě nechá
 *
 * `guide.json`, a ten se commituje — je to jediný způsob, jak se výsledek
 * brány dá přečíst bez toho, aby se měření pouštělo znovu. `npm test` na něj
 * nesáhne: přípona `.measure.ts` není ve výchozím `include`.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { SOLVE_BUDGET } from '@/model/repair';
import { guideRoute } from '@/worldstream/guide';
import { phraseGuideAnswer } from '@/worldstream/guide-answer';
import { runtimeActions } from '@/worldstream/runtime-input';
import { TIER_POLICY } from '@/verify/tiers';
import { verifyWitness } from '@/verify/witness';
import authored from '@/worldstream/authored-worlds.json';

const OUT_FILE = fileURLToPath(new URL('./guide.json', import.meta.url));
const SOURCE = 'src/worldstream/authored-worlds.json (frozen compiler emissions)';

/** Kolik světů se měří. Pět, protože tolik jich obhlédne jedno sezení s cizím člověkem. */
const WORLDS = 5;

/**
 * Slova, která se ve světě hledat nemají.
 *
 * Nejsou to nesmysly: jsou to **věci, které by v takovém světě klidně být
 * mohly**, a právě proto je pokušení přimyslet si je největší. Každý svět
 * dostane **jiné** — pětkrát totéž slovo by pět případů jen vypadalo, ale
 * měřilo by jediný.
 */
const ABSENT_CANDIDATES = ['fountain', 'dragon', 'staircase', 'wellhouse', 'anchorstone'] as const;

interface QuestionRecord {
  readonly worldId: string;
  readonly prompt: string;
  readonly question: string;
  /** Slovo, na které se ptáme. */
  readonly asked: string;
  /** Je to jméno, které ve světě doopravdy je? */
  readonly present: boolean;
  readonly status: string;
  readonly reason: string | null;
  /** Kolik vstupů má nalezená cesta. Nula, když cesta není. */
  readonly routeLength: number;
  /** Druhý, nezávislý verdikt verifikátoru. `null`, když není co ověřovat. */
  readonly verify: string | null;
  readonly text: string;
  /** Jména ve větě, která ve světě nejsou a tazatel je neřekl. Tohle se počítá. */
  readonly invented: readonly string[];
  readonly ms: number;
}

/**
 * Zmrazená emise je **před opravou**, takže obálku svědka ještě nemá a
 * `buildRuntimeWorld` ji odmítne („witness declares no known tier"). Doplňuje
 * se tady přesně tak, jak ji staví `repairEmission()` před hledáním: prázdná
 * stopa a horizont tieru. Kdyby se doplnila i stopa, průvodce by hledal
 * v dokumentu, který už jednu cestu zná.
 */
function withWitness(sim: Record<string, unknown>): Record<string, unknown> {
  return { ...sim, witness: { tier: 'short', H_cert: TIER_POLICY.short.maxHorizonTicks, ops: [] } };
}

/** Jména, která ve světě doopravdy jsou: entity, sokety a zóny. */
function worldNames(world: ReturnType<typeof buildRuntimeWorld> & { ok: true }): ReadonlySet<string> {
  return new Set([
    ...world.world.ir.entities.map((entity) => entity.stableId),
    ...Object.keys(world.world.space.sockets),
    ...Object.keys(world.world.space.zones),
  ]);
}

/**
 * Slovesa, která svět sám deklaruje (`moveTo`, `activate`, …).
 *
 * Věta průvodce je jmenuje vedle objektů, a **není to výmysl o světě**: jsou
 * to vstupy, na které se v něm ptá nějaké pravidlo. Měřený počet výmyslů by
 * bez nich byl nafouknutý o každý krok každé cesty — a číslo, které roste
 * s délkou pravdivé odpovědi, neměří poctivost.
 */
function worldVerbs(world: ReturnType<typeof buildRuntimeWorld> & { ok: true }): ReadonlySet<string> {
  return new Set(runtimeActions({ ...world.world, trace: [] }).map((action) => action.actionId));
}

function measure(worldId: string, prompt: string, sim: Record<string, unknown>, asked: string): QuestionRecord {
  const built = buildRuntimeWorld(sim);
  expect(built.ok ? [] : built.issues, `svět ${worldId} se nepostavil`).toEqual([]);
  if (!built.ok) throw new Error('unreachable');

  const names = worldNames(built);
  const verbs = worldVerbs(built);
  const world = { ...built.world, trace: [] };
  const started = performance.now();
  const answer = guideRoute(world, asked, SOLVE_BUDGET);
  const ms = Math.round((performance.now() - started) * 1000) / 1000;
  const sentence = phraseGuideAnswer(answer);

  return {
    worldId,
    prompt,
    question: `How do I get to the ${asked}?`,
    asked,
    present: names.has(asked),
    status: answer.status,
    reason: answer.status === 'NO_ROUTE' ? answer.reason : null,
    routeLength: answer.status === 'ROUTE' ? answer.ops.length : 0,
    // Znovu, ne z certifikátu v odpovědi.
    verify: answer.status === 'ROUTE'
      ? verifyWitness({ ...world, trace: answer.ops }, answer.ops).verdict
      : null,
    text: sentence.text,
    invented: sentence.names.filter((name) => name !== asked && !names.has(name) && !verbs.has(name)),
    ms,
  };
}

describe('brána A6 – průvodce nad zmrazenými světy', () => {
  it('odpoví na deset otázek nad pěti světy a zapíše, co z toho vyšlo', () => {
    const cases: QuestionRecord[] = [];

    for (const entry of authored.worlds) {
      if (cases.length >= WORLDS * 2) break;
      const sim = withWitness(entry.compiler.world.sim as Record<string, unknown>);
      if (!buildRuntimeWorld(sim).ok) continue;

      // Svět bez hrdinského objektu tuhle otázku neumí položit; měřit místo
      // něj náhodnou entitu by byl jiný pokus, ne tentýž.
      const hero = entry.heroObjects[0] as string | undefined;
      if (hero === undefined) continue;
      const present = measure(entry.id, entry.prompt, sim, hero);
      const names = worldNames(buildRuntimeWorld(sim) as never);
      const mine = ABSENT_CANDIDATES[cases.length / 2];
      const absent = names.has(mine) ? ABSENT_CANDIDATES.find((word) => !names.has(word)) : mine;
      expect(absent, `ve světě ${entry.id} je každé z nepřítomných slov`).toBeDefined();
      cases.push(present, measure(entry.id, entry.prompt, sim, absent!));
    }

    expect(cases.length, 'míň než pět postavitelných světů, jmenovatel by byl jiný').toBe(WORLDS * 2);

    const summary = {
      total: cases.length,
      worlds: new Set(cases.map((entry) => entry.worldId)).size,
      routes: cases.filter((entry) => entry.status === 'ROUTE').length,
      certified: cases.filter((entry) => entry.verify === 'CERTIFIED').length,
      notInWorld: cases.filter((entry) => entry.status === 'NOT_IN_WORLD').length,
      /** Tohle je ta brána. Všechno ostatní je kontext. */
      invented: cases.filter((entry) => entry.invented.length > 0).length,
      slowestMs: Math.max(...cases.map((entry) => entry.ms)),
    };

    writeFileSync(OUT_FILE, `${JSON.stringify({
      measuredAt: new Date().toISOString(),
      provenance: SOURCE,
      budget: SOLVE_BUDGET,
      summary,
      cases,
    }, null, 2)}\n`);

    // Prahy rešerše jsou cíl, ne podmínka projití – rozhoduje naměřené číslo.
    // Jediné, co se tu tvrdí, je právě to, kvůli čemu průvodce existuje.
    expect(summary.invented, 'průvodce si přimyslel objekt, který ve světě není').toBe(0);
  });
});
