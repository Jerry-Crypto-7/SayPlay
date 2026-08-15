import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildLayoutScene, layoutById, measureScene } from '../../kit';
import {
  CAPABILITY_TOKENS,
  MANIFESTS,
  TOKEN_SENTENCES,
  canonicalVector,
  isCapabilityToken,
  type CapabilityToken,
} from '../manifests';
import {
  DEFAULT_MAX_TICKS,
  MS_PER_TICK,
  TICK_HZ,
  createStreams,
  nextInt,
  runTrace,
  ticksForSeconds,
  type Game,
  type GameView,
  type Intent,
} from '../loop';
import {
  blockingFor,
  extractVector,
  requirementsOf,
  route,
  routePrompt,
  stableHash,
  universallyForbidden,
  type RouteDecision,
} from '../router';

type Prompt = { id: string; bucket: string; split: string; prompt: string; pass: string };

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as T);
}

const PROMPTS = readJsonl<Prompt>('evals/prompts.jsonl');
const GOLD = new Map(
  readJsonl<{ id: string; required?: string[] }>('evals/gold.jsonl').map((entry) => [
    entry.id,
    entry.required ?? [],
  ]),
);
const DEV = PROMPTS.filter((prompt) => prompt.split === 'dev');

/** Rozhodnutí zhuštěné na to, v čem se dva běhy smějí lišit — jinak nic. */
function outcomeOf(decision: RouteDecision): string {
  return decision.kind === 'archetype'
    ? `archetype:${decision.archetype}`
    : `no_fit:${decision.nearest}:${decision.blocking.join(',')}`;
}

describe('manifesty', () => {
  it('jsou tři a jejich tokeny jsou ze slovníku', () => {
    expect(MANIFESTS).toHaveLength(3);
    for (const manifest of MANIFESTS) {
      for (const token of [...manifest.supported, ...manifest.forbidden]) {
        expect(isCapabilityToken(token)).toBe(true);
      }
    }
  });

  it('žádný token není zároveň supported i forbidden', () => {
    for (const manifest of MANIFESTS) {
      const overlap = manifest.supported.filter((token) => manifest.forbidden.includes(token));
      expect(overlap).toEqual([]);
    }
  });

  it('součin parametrických domén sedí na deklarovaný počet n-tic', () => {
    // `ARCHETYPES.md` §6 tvrdí 192 / 288 / 144 a T203 podle toho enumeruje.
    // Kdyby doména a číslo nesedělo, enumerace by tvrdila pokrytí, které nemá.
    for (const manifest of MANIFESTS) {
      const product = Object.values(manifest.params).reduce(
        (acc, domain) => acc * domain.length,
        1,
      );
      expect([manifest.id, product]).toEqual([manifest.id, manifest.tupleCount]);
    }
  });

  it('každý token slovníku má lidskou větu', () => {
    // Bez věty by `NO_FIT` zamlčel, co ho zablokovalo — a přesně to má §5 zakázat.
    for (const token of CAPABILITY_TOKENS) {
      expect(TOKEN_SENTENCES[token]?.length ?? 0).toBeGreaterThan(3);
    }
  });

  it('každý archetyp ukazuje na existující layout kitu', () => {
    for (const manifest of MANIFESTS) {
      expect(layoutById(manifest.sceneLayout)).toBeDefined();
    }
  });
});

describe('extrakce vektoru', () => {
  it('nikdy nevydá token mimo uzavřený slovník', () => {
    for (const prompt of PROMPTS) {
      for (const token of extractVector(prompt.prompt)) {
        expect(isCapabilityToken(token)).toBe(true);
      }
    }
  });

  it('je deterministická a kanonicky seřazená', () => {
    for (const prompt of PROMPTS) {
      const first = extractVector(prompt.prompt);
      expect(extractVector(prompt.prompt)).toEqual(first);
      expect(first).toEqual(canonicalVector(first));
    }
  });

  it('vágní prompt smí skončit prázdným vektorem', () => {
    // `ARCHETYPES.md` §2, anotační pravidlo 5. Prázdný vektor je platný výsledek,
    // ne selhání — všechny archetypy jsou proveditelné a rozhodne hash.
    expect(extractVector('a place')).toEqual([]);
    expect(extractVector('fun')).toEqual([]);
  });

  it('vektor je vlastnost promptu, ne délky textu', () => {
    expect(extractVector('a puzzle room where I have to find three keys to open the exit door'))
      .toContain('GOAL_COLLECT_N');
    expect(extractVector('a physics playground with bouncing balls I can throw at stacked boxes'))
      .toContain('REQ_PHYSICS_SIM');
  });
});

describe('rozhodovací pravidlo', () => {
  it('vybraný archetyp vždycky splňuje manifest', () => {
    // Tohle je jádro AC „vybírá podle manifestů, ne podle klíčových slov":
    // ať přijde jakýkoli z 74 gold vektorů, vítěz musí obstát v množinové
    // aritmetice z §4. Router, který by rozhodoval slovem v promptu, tady spadne.
    for (const prompt of PROMPTS) {
      const required = GOLD.get(prompt.id) ?? [];
      const decision = route(required as CapabilityToken[], prompt.prompt);
      if (decision.kind !== 'archetype') continue;

      const manifest = MANIFESTS.find((entry) => entry.id === decision.archetype)!;
      const needs = requirementsOf(decision.required);
      const unsupported = needs.filter((token) => !manifest.supported.includes(token));
      const forbidden = needs.filter((token) => manifest.forbidden.includes(token));
      expect([prompt.id, unsupported, forbidden]).toEqual([prompt.id, [], []]);
    }
  });

  it('GOAL_NONE je popis absence výhry, ne požadavek', () => {
    // Jediná výjimka z „required ⊆ supported" a musí být vidět, ne schovaná:
    // GOAL_NONE není v `supported` žádného manifestu, takže by jinak poslal každou
    // statickou scénu na NO_FIT kvůli tomu, že po ničem netouží.
    expect(requirementsOf(['GOAL_NONE', 'GOAL_REACH'])).toEqual(['GOAL_REACH']);
    expect(route(['GOAL_NONE'], 'a quiet museum hall').kind).toBe('archetype');
    // A protiklad: skutečný požadavek, který žádný manifest neumí, výjimku nedostane.
    expect(route(['GOAL_NONE', 'REQ_PHYSICS_SIM'], 'a quiet museum hall').kind).toBe('no_fit');
  });

  it('nejtěsnější archetyp vyhrává nad obecnějším', () => {
    // GOAL_REACH + STATE_DISCRETE umí A1 (supported 10) i A3 (supported 11).
    // Bez pravidla „nejmenší supported" by široký archetyp postupně pohltil vše.
    const decision = route(['GOAL_REACH', 'STATE_DISCRETE'], 'a maze with an exit');
    expect(decision.kind).toBe('archetype');
    expect(decision.kind === 'archetype' && decision.feasible).toEqual([
      'collect_unlock',
      'guide_avoid',
    ]);
    expect(decision.kind === 'archetype' && decision.archetype).toBe('collect_unlock');
  });

  it('remízu rozsekne hash promptu, ne pozice v poli', () => {
    // Prázdný vektor -> proveditelné je všechno, A1 i A2 mají supported 10.
    // Kdyby se bralo první v pořadí, padly by sem všechny vágní prompty stejně.
    const vague = PROMPTS.filter((prompt) => (GOLD.get(prompt.id) ?? []).length === 0);
    const chosen = [...new Set(vague.map((prompt) => outcomeOf(route([], prompt.prompt))))];
    expect(chosen).toContain('archetype:collect_unlock');
    expect(chosen).toContain('archetype:sort_match');
  });

  it('je čistá funkce — nemutuje vstup a stejný vstup dá stejný výstup', () => {
    const required: CapabilityToken[] = ['GOAL_REACH', 'STATE_DISCRETE'];
    const frozen = Object.freeze([...required]);
    const first = route(frozen, 'a maze');
    const second = route(frozen, 'a maze');
    expect(second).toEqual(first);
    expect(required).toEqual(['GOAL_REACH', 'STATE_DISCRETE']);
  });

  it('odmítne token mimo slovník místo aby ho tiše ignoroval', () => {
    expect(() => route(['GOAL_TELEPORT' as CapabilityToken], 'x')).toThrow(/není ve slovníku/);
  });

  it('zákaz vyhrává nad podporou, i když si manifest odporuje', () => {
    // Nad dnešními třemi manifesty tahle větev nikdy nenastane — žádný token
    // není v obou množinách. Testuje se přes syntetický manifest, protože jinak
    // by šlo kontrolu `forbidden` z kódu smazat a sada by zůstala zelená.
    const contradictory = {
      ...MANIFESTS[0],
      supported: ['GOAL_REACH', 'STATE_TIMER'] as CapabilityToken[],
      forbidden: ['STATE_TIMER'] as CapabilityToken[],
    };
    expect(blockingFor(contradictory, ['GOAL_REACH', 'STATE_TIMER'])).toEqual(['STATE_TIMER']);
    expect(blockingFor(contradictory, ['GOAL_REACH'])).toEqual([]);
  });

  it('nepodporovaný token blokuje, i když ho manifest výslovně nezakazuje', () => {
    // Druhá půlka §4: `required ⊆ supported`. REQ_MULTI_AGENT není v A3 ani
    // v jedné množině, a přesto A3 vyloučí — §6 to u A3 vyžaduje jmenovitě.
    const guide = MANIFESTS.find((manifest) => manifest.id === 'guide_avoid')!;
    expect(guide.supported).not.toContain('REQ_MULTI_AGENT');
    expect(guide.forbidden).not.toContain('REQ_MULTI_AGENT');
    expect(blockingFor(guide, ['GOAL_REACH', 'REQ_MULTI_AGENT'])).toEqual(['REQ_MULTI_AGENT']);
  });

  it('stabilní hash je stabilní a není konstantní', () => {
    expect(stableHash('a maze')).toBe(stableHash('a maze'));
    expect(stableHash('a maze')).not.toBe(stableHash('a mazf'));
  });
});

describe('poctivé NO_FIT', () => {
  const universal = universallyForbidden();

  it('existuje aspoň jeden token zakázaný ve všech třech manifestech', () => {
    expect(universal.length).toBeGreaterThan(0);
    expect(universal).toContain('REQ_BEHAVIOUR_EDIT');
    expect(universal).toContain('STATE_CONTINUOUS');
  });

  it('prompt s takovým tokenem v gold vektoru skončí NO_FIT a řekne proč', () => {
    const affected = PROMPTS.filter((prompt) =>
      (GOLD.get(prompt.id) ?? []).some((token) => universal.includes(token as CapabilityToken)),
    );
    expect(affected.length).toBeGreaterThan(0);

    for (const prompt of affected) {
      const required = (GOLD.get(prompt.id) ?? []) as CapabilityToken[];
      const decision = route(required, prompt.prompt);
      expect([prompt.id, decision.kind]).toEqual([prompt.id, 'no_fit']);
      if (decision.kind !== 'no_fit') continue;

      const culprit = required.find((token) => universal.includes(token))!;
      expect(decision.blocking).toContain(culprit);
      // Věta je odvozená z rozdílu množin, takže musí blokující token pojmenovat.
      expect(decision.reason).toContain(TOKEN_SENTENCES[culprit]);
      expect(decision.reason).toContain(culprit);
    }
  });

  it('žádné rozhodnutí neposílá na prázdnou obrazovku', () => {
    // `DESIGN-BOOK.md` §13.4: NO_FIT vykreslí scénu z kitu. Oracle je skutečně
    // postavená scéna a její draw cally, ne existence stringu s id layoutu.
    const decisions = PROMPTS.map((prompt) => routePrompt(prompt.prompt));
    expect(decisions.some((decision) => decision.kind === 'no_fit')).toBe(true);

    const layoutIds = [...new Set(decisions.map((decision) => decision.sceneLayout))];
    for (const layoutId of layoutIds) {
      const layout = layoutById(layoutId);
      expect(layout).toBeDefined();
      const measured = measureScene(buildLayoutScene(layout!));
      expect([layoutId, measured.drawCalls > 0, measured.triangles > 0]).toEqual([
        layoutId,
        true,
        true,
      ]);
    }
  });

  it('NO_FIT ukáže scénu nejbližšího kandidáta, ne náhodnou', () => {
    const decision = route(['REQ_BEHAVIOUR_EDIT'], 'make the wolves afraid of the fire');
    expect(decision.kind).toBe('no_fit');
    if (decision.kind !== 'no_fit') return;
    const nearest = MANIFESTS.find((manifest) => manifest.id === decision.nearest)!;
    expect(decision.sceneLayout).toBe(nearest.sceneLayout);
  });
});

describe('nestabilita routování', () => {
  it('je ≤ 5 % přes pět běhů nad dev sadou', () => {
    // `ARCHETYPES.md` §9. Každý běh jde přes prompty v jiném pořadí, takže by se
    // projevila i skrytá paměť mezi voláními — ne jen globální náhoda.
    const runs = [0, 1, 2, 3, 4].map((offset) => {
      const order = DEV.map((_, index) => (index * 7 + offset * 13) % DEV.length);
      const outcomes = new Map<string, string>();
      for (const index of order) {
        const prompt = DEV[index];
        outcomes.set(prompt.id, outcomeOf(routePrompt(prompt.prompt)));
      }
      return outcomes;
    });

    const unstable = DEV.filter((prompt) => {
      const seen = new Set(runs.map((run) => run.get(prompt.id)));
      return seen.size > 1;
    });

    expect(unstable.map((prompt) => prompt.id)).toEqual([]);
    expect(unstable.length / DEV.length).toBeLessThanOrEqual(0.05);
  });

  it('router není konstantní funkce — všechny tři archetypy jsou nad dev sadou dosažitelné', () => {
    // Nestabilita 0 % je triviálně splnitelná routerem, který vrací pořád totéž.
    // Tenhle test je důvod, proč to o něčem vypovídá.
    const outcomes = DEV.map((prompt) => routePrompt(prompt.prompt));
    const archetypes = outcomes
      .filter((decision) => decision.kind === 'archetype')
      .map((decision) => decision.archetype);
    expect([...new Set(archetypes)].sort()).toEqual([
      'collect_unlock',
      'guide_avoid',
      'sort_match',
    ]);
    expect(outcomes.some((decision) => decision.kind === 'no_fit')).toBe(true);
  });
});

describe('sdílená herní vrstva', () => {
  type Counting = { tick: number; hits: number; noise: number };

  const probe: Game<Counting> = {
    manifest: MANIFESTS[0],
    goal: 'klikni třikrát',
    create(seed) {
      const streams = createStreams(seed);
      return { tick: 0, hits: 0, noise: nextInt(streams.spawn, 0, 1_000_000) };
    },
    advance(state, intents) {
      const hits = state.hits + intents.filter((intent) => intent.kind === 'point').length;
      return { ...state, tick: state.tick + 1, hits };
    },
    project(state): GameView {
      return {
        archetype: 'collect_unlock',
        title: 'sonda',
        goal: 'klikni třikrát',
        phase: state.hits >= 3 ? 'won' : 'running',
        tick: state.tick,
        counters: [{ label: 'hits', value: state.hits, max: 3 }],
        timeLeftTicks: null,
        message: null,
        sceneLayout: MANIFESTS[0].sceneLayout,
      };
    },
  };

  const click: Intent[] = [{ kind: 'point', target: 'orb' }];

  it('tik je 20 Hz a převod sekund na tiky z něj vychází', () => {
    expect(TICK_HZ).toBe(20);
    expect(MS_PER_TICK).toBe(50);
    expect(ticksForSeconds(90)).toBe(1800);
    expect(DEFAULT_MAX_TICKS).toBe(3600);
  });

  it('stopa doběhne do výhry a zastaví se na ní', () => {
    const result = runTrace(probe, 7, [click, click, click, click]);
    expect(result.view.phase).toBe('won');
    expect(result.ticks).toBe(3);
  });

  it('stejný seed a stopa dají identický průběh', () => {
    const a = runTrace(probe, 42, [click, click]);
    const b = runTrace(probe, 42, [click, click]);
    expect(b).toEqual(a);
    expect(runTrace(probe, 43, [click, click]).state.noise).not.toBe(a.state.noise);
  });

  it('strop tiků drží i stopu, která nikdy nevyhraje', () => {
    const result = runTrace(probe, 1, [], 25);
    expect(result.ticks).toBe(25);
    expect(result.view.phase).toBe('running');
  });

  it('oddělené streamy se navzájem neposouvají', () => {
    // Kdyby subsystémy sdílely jeden stream, jeden los navíc ve spawnu by přepsal
    // rozmístění překážek a replay by přestal sedět.
    const streams = createStreams(9);
    const hazardFirst = nextInt(streams.hazard, 0, 1_000_000);
    const fresh = createStreams(9);
    nextInt(fresh.spawn, 0, 1_000_000);
    nextInt(fresh.spawn, 0, 1_000_000);
    expect(nextInt(fresh.hazard, 0, 1_000_000)).toBe(hazardFirst);
  });
});

describe('architektonická nezávislost', () => {
  it('fallback neodkazuje na jádro ani slovem', () => {
    // Plný důkaz je T204 (build ve stromu, kde jádro neexistuje). Tenhle sken je
    // AC T202 a chytí to nejlevnější porušení hned, ne až za dva dny.
    //
    // Skenuje se disk, ne `git grep`: nový soubor je do commitu nesledovaný a
    // `git grep` by ho neviděl, takže by test mlčel právě nad tím kódem, kvůli
    // kterému existuje.
    //
    // Hledaný řetězec se skládá z kusů, aby ho tenhle soubor sám neobsahoval.
    const core = ['sim', 'ir', 'verify', 'patch'].map((name) => `${'src'}/${name}`);
    const offenders: string[] = [];

    for (const entry of readdirSync('src/fallback', { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = join(entry.parentPath, entry.name);
      const content = readFileSync(file, 'utf8');
      if (core.some((needle) => content.includes(needle))) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
