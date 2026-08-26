/**
 * Opravná smyčka — odmítnutí jde zpátky do modelu.
 *
 * Smyčka běží **bez dozoru** v prohlížeči porotce. Selhání, na kterých záleží,
 * jsou proto přesně ta, co nastanou jen když je něco už špatně: model odpoví
 * pokaždé stejně, odpoví hůř, přestane odpovídat, nebo řetěz přeteče rozpočet.
 * Šťastná cesta se pozná okem (svět stojí); tyhle ne.
 *
 * ## Co se tu netestuje
 *
 * Kvalita emise. Stroj je vždycky předepsaný, žádné GPU — měří se **smyčka**,
 * ne model. To, o kolik smyčka zvedne certifikované světy, měří až T4 na
 * zmrazených 200 větách.
 */

import { describe, expect, it, vi } from 'vitest';

import { EXAMPLE_MARKER, buildEmissionRequest } from '../../prompt';
import { repairEmission } from '../../repair';
import { MAX_ROUNDS, ROUND_BUDGET_MS, emitLocally, localGrammar } from '../emit';
import { LARGE_MODEL, type ChatEngine } from '../engine';

const EXAMPLE_WORLD: Record<string, unknown> = (() => {
  const system = buildEmissionRequest('libovolná věta', localGrammar()).system;
  const at = system.indexOf(EXAMPLE_MARKER);
  return JSON.parse(system.slice(system.indexOf('{', at))) as Record<string, unknown>;
})();

/** Ukázka s jinou paletou — tvarem platná, ale není to doslovná kopie. */
function validWorld(palette: string): Record<string, unknown> {
  const repaired = repairEmission(EXAMPLE_WORLD).document as Record<string, unknown>;
  return { ...repaired, look: { ...(repaired.look as Record<string, unknown>), palette } };
}

/** Svět, jehož vítězné pravidlo míří do nedeklarované zóny. */
function danglingWorld(zone: string): Record<string, unknown> {
  const doc = validWorld('amber');
  const sim = { ...(doc.sim as Record<string, unknown>) };
  const rules = { ...(sim.rules as Record<string, unknown>) };
  const win = rules.win as { readonly event: Record<string, unknown> };
  rules.win = { ...win, event: { ...win.event, zone } };
  return { ...doc, sim: { ...sim, rules } };
}

/**
 * Stroj, který postupně vydá předepsané odpovědi. Poslední se opakuje.
 *
 * `seen` jsou uživatelské zprávy, `systems` systémové. Od úpravy rozpočtu okna
 * se mezi koly liší obojí, takže obojí musí být vidět.
 */
function scriptedEngine(
  answers: readonly string[],
): ChatEngine & { readonly seen: string[]; readonly systems: string[] } {
  const seen: string[] = [];
  const systems: string[] = [];
  return {
    seen,
    systems,
    modelId: LARGE_MODEL,
    complete: (system: string, user: string) => {
      seen.push(user);
      systems.push(system);
      const raw = answers[Math.min(seen.length - 1, answers.length - 1)];
      return Promise.resolve({ raw, finishReason: 'stop' });
    },
    unload: () => Promise.resolve(),
  };
}

const noRecognizer = () => null;

describe('kolik kol smyčka protočí', () => {
  it('platná odpověď napotřetí skončí certifikací a třemi koly', async () => {
    const engine = scriptedEngine([
      JSON.stringify(danglingWorld('nikdyDeklarovanaA')),
      JSON.stringify(danglingWorld('nikdyDeklarovanaB')),
      JSON.stringify(validWorld('cobalt')),
    ]);

    const outcome = await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.outcome).toBe('CERTIFIED');
    expect(outcome.rounds.length).toBe(3);
    expect(outcome.rounds.map((round) => round.attempt)).toEqual([1, 2, 3]);
    // Jen poslední kolo skončilo bez odmítnutí — předchozí dvě ho nesou.
    expect(outcome.rounds.map((round) => round.rejection === null)).toEqual([false, false, true]);
  });

  it('platná odpověď napoprvé model podruhé vůbec nezavolá', async () => {
    const engine = scriptedEngine([JSON.stringify(validWorld('cobalt'))]);

    const outcome = await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    expect(outcome.rounds.length).toBe(1);
    expect(engine.seen.length).toBe(1);
  });

  it('pořád jiná vada skončí po třech kolech a vrátí poslední odmítnutí', async () => {
    // „Odpovídá pořád stejně špatně" ve smyslu AC = pořád vadně, ale pokaždé
    // jinak. Když je odpověď DOSLOVA táž, zastaví se dřív — to je test níž.
    const engine = scriptedEngine([
      JSON.stringify(danglingWorld('a')),
      JSON.stringify(danglingWorld('b')),
      JSON.stringify(danglingWorld('c')),
      JSON.stringify(danglingWorld('d')),
    ]);

    const outcome = await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    expect(outcome.rounds.length).toBe(MAX_ROUNDS);
    expect(engine.seen.length).toBe(MAX_ROUNDS);
    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.outcome).toBe('REJECTED');
    if (outcome.body.outcome !== 'REJECTED') return;
    expect(outcome.body.rejection.reason).toBe('DANGLING_REFERENCE');
    expect(outcome.body.rejection.detail).toContain('d');
  });

  it('nepohnuté odmítnutí zastaví smyčku dřív, než strop dojde', async () => {
    // Táž odpověď podruhé = model tu vadu opravit neumí. Třetí kolo by jen
    // spálilo dalších ~34 s a porotce by na ně čekal.
    const engine = scriptedEngine([JSON.stringify(danglingWorld('porad_stejne'))]);

    const outcome = await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    expect(outcome.rounds.length).toBe(2);
    expect(engine.seen.length).toBe(2);
  });

  it('rozpoznaná věta model nespustí a vydá jediné kolo', async () => {
    const forbidden: ChatEngine = {
      modelId: LARGE_MODEL,
      complete: () => Promise.reject(new Error('model se neměl spustit')),
      unload: () => Promise.resolve(),
    };

    const outcome = await emitLocally({
      sentence: 'věta porotce',
      engine: forbidden,
      recognize: () => validWorld('slate'),
    });

    expect(outcome.rounds.length).toBe(1);
    expect(outcome.kind).toBe('verdict');
  });
});

describe('co model dostane v druhém kole', () => {
  it('důvod odmítnutí větou i svoji předchozí emisi', async () => {
    const first = danglingWorld('glowingArch');
    const engine = scriptedEngine([JSON.stringify(first), JSON.stringify(validWorld('cobalt'))]);

    await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    expect(engine.seen.length).toBe(2);
    const retry = engine.seen[1];
    // Původní věta musí zůstat — bez ní model opravuje naslepo.
    expect(retry).toContain('věta porotce');
    // Adresa vady, kterou napsal T2.
    expect(retry).toContain('glowingArch');
    // A jeho vlastní předchozí odpověď, aby měl co přepsat.
    expect(retry).toContain('"irVersion"');
  });

  it('první kolo žádnou opravnou omáčku nenese', async () => {
    const engine = scriptedEngine([JSON.stringify(validWorld('cobalt'))]);

    await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    expect(engine.seen[0]).not.toContain('rejected');
  });
});

describe('smyčka obtáčí deterministickou opravu, ne jen certifikaci', () => {
  it('svět, který projde až po opravě, se certifikuje v prvním kole', async () => {
    // Syrová ukázka nemá svědka. `repairEmission()` mu ho dohledá; kdyby smyčka
    // volala certifikaci samotnou, tenhle svět by padl a spálil tři kola.
    const raw = { ...EXAMPLE_WORLD, look: { ...(EXAMPLE_WORLD.look as Record<string, unknown>), palette: 'cobalt' } };
    const engine = scriptedEngine([JSON.stringify(raw)]);

    const outcome = await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    expect(outcome.rounds.length).toBe(1);
    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.outcome).toBe('CERTIFIED');
    expect(outcome.body.repairs?.length).toBeGreaterThan(0);
  });
});

describe('cesty selhání', () => {
  it('stroj, který vyhodí výjimku uprostřed, nechá kola, která už proběhla', async () => {
    let call = 0;
    const engine: ChatEngine = {
      modelId: LARGE_MODEL,
      complete: () => {
        call += 1;
        return call === 1
          ? Promise.resolve({ raw: JSON.stringify(danglingWorld('a')), finishReason: 'stop' })
          : Promise.reject(new Error('WebGPU device lost'));
      },
      unload: () => Promise.resolve(),
    };

    const outcome = await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.detail).toContain('WebGPU device lost');
    // Rozbité prostředí není verdikt o světě, ale kolo 1 se doopravdy odehrálo.
    expect(outcome.rounds.length).toBe(1);
  });

  it('nerozpársovatelná odpověď v druhém kole je odmítnutí, ne pád', async () => {
    const engine = scriptedEngine([JSON.stringify(danglingWorld('a')), 'tohle není JSON', 'tohle taky ne']);

    const outcome = await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.outcome).toBe('REJECTED');
    if (outcome.body.outcome !== 'REJECTED') return;
    expect(outcome.body.rejection.reason).toBe('NOT_A_DOCUMENT');
  });

  it('vyčerpaný rozpočet další kolo nezačne', async () => {
    const engine = scriptedEngine([
      JSON.stringify(danglingWorld('a')),
      JSON.stringify(danglingWorld('b')),
      JSON.stringify(validWorld('cobalt')),
    ]);
    // Hodiny, které mezi koly skočí přes celý rozpočet.
    let tick = 0;
    const now = () => {
      tick += 1;
      return tick === 1 ? 0 : ROUND_BUDGET_MS + 1;
    };

    const outcome = await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer, now });

    expect(outcome.rounds.length).toBe(1);
    expect(engine.seen.length).toBe(1);
    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.outcome).toBe('REJECTED');
  });

  it('kolo si změří čas z vlastních hodin, ne z wall-clocku', async () => {
    const engine = scriptedEngine([JSON.stringify(validWorld('cobalt'))]);
    // Tři čtení, ne dvě: řetěz si vezme svůj začátek, pak kolo svůj, a nakonec
    // se kolo uzavře. Rozpočet řetězu a cena kola jsou dvě různá měření.
    const now = vi.fn<() => number>();
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_000).mockReturnValueOnce(1_420);

    const outcome = await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer, now });

    expect(outcome.rounds[0].ms).toBe(420);
  });
});

describe('doslovná kopie ukázky', () => {
  it('je odmítnutí, které dostane další kolo', async () => {
    const engine = scriptedEngine([JSON.stringify(EXAMPLE_WORLD), JSON.stringify(validWorld('cobalt'))]);

    const outcome = await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    expect(outcome.rounds.length).toBe(2);
    expect(outcome.rounds[0].rejection?.reason).toBe('EXAMPLE_COPY');
    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    expect(outcome.body.outcome).toBe('CERTIFIED');
  });
});

/**
 * Rozpočet okna modelu (naměřeno 26. 8. 2026).
 *
 * Model má okno **4 096 tokenů** a požadavek prvního kola z něj zabírá skoro
 * všechno. Opravné kolo k němu přikládá předchozí emisi, takže bez úspory jinde
 * nezbude místo na odpověď — a naměřeně se pak usekne. Tyhle testy hlídají obě
 * úspory, protože obě jsou neviditelné: prompt, který se nevejde, vypadá jako
 * fungující smyčka a vydá horší svět.
 */
describe('rozpočet okna v opravném kole', () => {
  it('opravné kolo neposílá ukázku syntaxe, první kolo ano', async () => {
    const engine = scriptedEngine([
      JSON.stringify(danglingWorld('nikdyDeklarovanaA')),
      JSON.stringify(validWorld('cobalt')),
    ]);

    await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    expect(engine.systems).toHaveLength(2);
    expect(engine.systems[0]).toContain(EXAMPLE_MARKER);
    expect(engine.systems[1]).not.toContain(EXAMPLE_MARKER);
    // Slovník a pravidla zůstávají — mizí ukázka, ne to, čím se emise soudí.
    expect(engine.systems[1]).toContain('irVersion, simRevision, lookRevision, sim, look');
  });

  it('opravné kolo se vejde do menšího prostoru než první, ne do většího', async () => {
    const engine = scriptedEngine([
      JSON.stringify(danglingWorld('nikdyDeklarovanaA')),
      JSON.stringify(validWorld('cobalt')),
    ]);

    await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    const first = engine.systems[0]!.length + engine.seen[0]!.length;
    const repair = engine.systems[1]!.length + engine.seen[1]!.length;
    expect(repair).toBeLessThan(first);
  });

  it('předchozí emise jde do promptu kompaktně, bez odsazení', async () => {
    const rejected = danglingWorld('nikdyDeklarovanaA');
    const engine = scriptedEngine([JSON.stringify(rejected), JSON.stringify(validWorld('cobalt'))]);

    await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    const retry = engine.seen[1]!;
    // Odsazená podoba téhož dokumentu je o tisíce znaků delší a v okně chybí
    // přesně odpovědi. Stačí ověřit, že tam není ani její začátek.
    expect(retry).not.toContain(JSON.stringify(rejected, null, 1).slice(0, 60));
    expect(retry).toContain('"irVersion":');
  });
});

describe('verdikt nese požadavek svého kola', () => {
  it('po opravě sedí upstream na to, co model doopravdy dostal', async () => {
    const engine = scriptedEngine([
      JSON.stringify(danglingWorld('nikdyDeklarovanaA')),
      JSON.stringify(validWorld('cobalt')),
    ]);

    const outcome = await emitLocally({ sentence: 'věta porotce', engine, recognize: noRecognizer });

    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') return;
    // Vlna 0: o modelu se nesmí tvrdit nic, co nedostal. Verdikt vzniká v kole
    // 2, takže musí nést požadavek kola 2 — jinak stopa ukazuje cizí prompt.
    expect(outcome.body.upstream.user).toBe(engine.seen[1]);
    expect(outcome.body.upstream.system).toBe(engine.systems[1]);
    expect(outcome.body.upstream.system).not.toContain(EXAMPLE_MARKER);
  });
});
