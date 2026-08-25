/**
 * Testy nad rozhodovací částí měření (P11 T5).
 *
 * Měřit se dá jen s WebGPU, ale **soudit** naměřené se dá tady: co je platná
 * emise, co je pád `#807`, kdy je běh krátký. Kdyby tyhle větve neměly test,
 * jediný důkaz o nich by byl report, který samy vyrobily.
 */

import { describe, expect, it } from 'vitest';

import { EXAMPLE_MARKER } from '../../../src/model/prompt';
import {
  FORCED_SHAPE_SCHEMA,
  LISTED_ISSUES,
  MEASURED_SENTENCES,
  RAW_EXCERPT_LIMIT,
  buildRawArchive,
  buildReport,
  classifyOutput,
  isBug807,
  loadSentences,
  measurementShortfall,
  median,
  mergeRecords,
  SHAPES_MARKER,
  splitByRecognizer,
  stripThinking,
  summarize,
  summarizeTiming,
  type AttemptRecord,
  type AttemptTiming,
} from '../measure-grammar';

/**
 * Platná emise se **nepíše sem**, ale bere se z příkladu v produkčním promptu.
 *
 * Vlastní ruční fixture by kontrolovala, jestli si test správně opsal schéma;
 * tahle bere přesně ten objekt, který uvidí model, a o kterém už
 * `src/model/__tests__/prompt.test.ts` dokazuje, že projde celou cestou. Když
 * se schéma emise změní, spadne obojí najednou — a nezůstane tu zelený test
 * nad tvarem, který systém přestal přijímat.
 */
const MINIMAL_WORLD: Record<string, unknown> = (() => {
  const system = loadSentences(1)[0]!.system;
  const at = system.indexOf(EXAMPLE_MARKER);
  return JSON.parse(system.slice(at + EXAMPLE_MARKER.length).trim()) as Record<string, unknown>;
})();

function attempt(overrides: Partial<AttemptRecord> & { id: string }): AttemptRecord {
  return { latencyMs: 100, finishReason: 'stop', raw: '', error: '', ...overrides };
}

describe('vynucený tvar', () => {
  it('žádá právě pět polí, která jmenuje systémový prompt', () => {
    const schema = JSON.parse(FORCED_SHAPE_SCHEMA) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required.sort()).toEqual(['irVersion', 'look', 'lookRevision', 'sim', 'simRevision']);
    // `sim: null` je poctivé odmítnutí. Kdyby gramatika `null` nepovolila,
    // NO_FIT by nešlo napsat a měření by trestalo model za správnou odpověď.
    expect(JSON.stringify(schema.properties.sim)).toContain('null');
  });
});

describe('classifyOutput', () => {
  it('přijme svět, který přijme produkční validátor', () => {
    expect(classifyOutput(JSON.stringify(MINIMAL_WORLD)).kind).toBe('fulfilled');
  });

  it('odliší poctivé odmítnutí od vadné emise', () => {
    const declined = { ...MINIMAL_WORLD, sim: null };
    expect(classifyOutput(JSON.stringify(declined)).kind).toBe('declined');
  });

  it('vadný tvar hlásí jako invalid, ne jako odmítnutí', () => {
    const broken = { ...MINIMAL_WORLD, sim: { layout: { width: 0, height: 0 } } };
    expect(classifyOutput(JSON.stringify(broken)).kind).toBe('invalid');
  });

  it('nerozpársovatelnou odpověď nehlásí jako invalid', () => {
    expect(classifyOutput('{"irVersion": "world-ir-v1"').kind).toBe('unparsable');
  });

  it('odřízne uvozující blok <think>, ale nic jiného', () => {
    const withThinking = `<think>\nlet me plan\n</think>\n${JSON.stringify(MINIMAL_WORLD)}`;
    expect(classifyOutput(withThinking).kind).toBe('fulfilled');
    expect(stripThinking('Sure! {"a":1}')).toBe('Sure! {"a":1}');
  });
});

describe('isBug807', () => {
  it('pozná doslovnou signaturu z hlášení', () => {
    expect(
      isBug807(
        'Check failed: (token_id >= 0 && token_id < tokenizer_info_.GetVocabSize()) is false: Invalid token id -1447643207',
      ),
    ).toBe(true);
  });

  it('obecný pád WASM runtimu za reprodukci nevydává', () => {
    // Kdyby stačilo `Aborted()`, report by hlásil reprodukci pokaždé, když
    // dojde paměť — a věta o známé chybě by přestala něco znamenat.
    expect(isBug807('RuntimeError: Aborted()')).toBe(false);
    expect(isBug807('Error: out of memory')).toBe(false);
  });
});

describe('median', () => {
  it('u sudého počtu vrátí průměr dvou prostředních', () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('u lichého počtu vrátí prostřední', () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  it('prázdný vstup nespadne', () => {
    expect(median([])).toBe(0);
  });
});

describe('summarize', () => {
  const records: AttemptRecord[] = [
    attempt({ id: 'P001', raw: JSON.stringify(MINIMAL_WORLD), latencyMs: 100 }),
    attempt({ id: 'P002', raw: JSON.stringify({ ...MINIMAL_WORLD, sim: null }), latencyMs: 300 }),
    attempt({ id: 'P003', raw: 'not json', latencyMs: 200 }),
    attempt({ id: 'P004', error: 'Invalid token id -1' }),
    attempt({ id: 'P005', raw: '{"irVersion":"x"', finishReason: 'length', latencyMs: 400 }),
  ];

  it('počítá odmítnutí do schemaValid, a přesto ho vede zvlášť', () => {
    const summary = summarize('m', records);
    expect(summary.fulfilled).toBe(1);
    expect(summary.declined).toBe(1);
    // 2 přijaté z 5 pokusů. Kdyby se odmítnutí nepočítalo, vyšlo by 0.2 a
    // poctivé NO_FIT by se vykazovalo jako vada modelu.
    expect(summary.schemaValid).toBe(0.4);
  });

  it('pád se nepočítá do latence ani do tvarových kategorií', () => {
    const summary = summarize('m', records);
    expect(summary.crashes).toBe(1);
    expect(summary.attempts).toBe(5);
    expect(summary.fulfilled + summary.declined + summary.invalid + summary.unparsable).toBe(4);
    expect(summary.medianLatencyMs).toBe(250);
  });

  it('useknutou odpověď spočítá a bug807 pozná z pádu', () => {
    const summary = summarize('m', records);
    expect(summary.truncated).toBe(1);
    expect(summary.bug807).toBe(true);
  });
});

/**
 * Rozpad latence je číslo, podle kterého se rozhodne, jestli se model do dema
 * vrátí. Vada v něm nevypadá jako vada: podíl 0,15 a podíl 0,42 jsou obojí
 * uvěřitelná čísla a nikdo je na obrazovce nerozezná. Proto je tu na každou
 * vlastnost jedna aserce, a schválně i na ty cesty, které se spustí jen tehdy,
 * když je něco jinak — pokus bez rozpadu a prázdný běh.
 */
describe('summarizeTiming', () => {
  const timing = (overrides: Partial<AttemptTiming>): AttemptTiming => ({
    promptTokens: 2000,
    completionTokens: 0,
    e2eMs: 0,
    timeToFirstTokenMs: 200,
    perTokenMs: 0,
    grammarMs: 0,
    sampleMs: 0,
    grammarInitMs: 10,
    ...overrides,
  });

  const measured: AttemptRecord[] = [
    attempt({
      id: 'P001',
      timing: timing({ e2eMs: 1000, completionTokens: 80, perTokenMs: 400, grammarMs: 300, sampleMs: 100 }),
    }),
    attempt({
      id: 'P002',
      timing: timing({ e2eMs: 3000, completionTokens: 320, perTokenMs: 600, grammarMs: 300, sampleMs: 300 }),
    }),
  ];

  it('podíly počítá ze součtů, ne jako medián podílů', () => {
    const summary = summarizeTiming(measured);
    // Součty: režie mezi tokeny 400+600 = 1000 z 4000 ms celkem.
    expect(summary.perTokenShare).toBe(0.25);
    expect(summary.grammarShare).toBe(0.15);
    // Vzorkování je vlastní podíl, ne dopočet do `perTokenShare`: 100+300 = 400.
    expect(summary.sampleShare).toBe(0.1);
    // Medián podílů by tu dal něco úplně jiného (0,4 a 0,2 → 0,3), takže tahle
    // aserce zabíjí právě záměnu obou způsobů počítání.
  });

  it('rychlost psaní nepočítá do času čekání na první token', () => {
    const summary = summarizeTiming(measured);
    // 400 tokenů za 4000 − 400 = 3600 ms. Kdyby se počítalo z celého e2e,
    // vyšlo by 100,0 a model by vypadal pomalejší, než je.
    expect(summary.decodeTokensPerS).toBe(111.1);
  });

  it('pokus bez rozpadu se vynechá, nezapočte se jako nula', () => {
    const withShapes = [...measured, attempt({ id: 'P003', finishReason: SHAPES_MARKER, latencyMs: 0 })];
    const summary = summarizeTiming(withShapes);
    expect(summary.samples).toBe(2);
    // Nula ve vzorku by medián stáhla na 1000 a tvrdila by, že jsou odpovědi
    // rychlejší, než jsou — přitom u té věty žádný model neběžel.
    expect(summary.medianE2eMs).toBe(2000);
    expect(summary.medianCompletionTokens).toBe(200);
  });

  it('běh bez jediného rozpadu nedělí nulou', () => {
    const summary = summarizeTiming([attempt({ id: 'P001' })]);
    expect(summary.samples).toBe(0);
    expect(summary.decodeTokensPerS).toBe(0);
    expect(summary.perTokenShare).toBe(0);
    expect(summary.grammarShare).toBe(0);
    expect(summary.sampleShare).toBe(0);
  });
});

describe('measurementShortfall', () => {
  const base = { primary: summarize('m', []), reproduction: null, adapter: 'nvidia/ampere', measuredAt: 'x' };

  it('krátký běh pojmenuje', () => {
    expect(measurementShortfall(buildReport(base))).toContain('40');
  });

  it('plný běh projde', () => {
    const full = summarize(
      'm',
      Array.from({ length: MEASURED_SENTENCES }, (_, index) => attempt({ id: `P${index}`, raw: 'not json' })),
    );
    expect(measurementShortfall(buildReport({ ...base, primary: full }))).toBeNull();
  });

  it('reprodukce v druhém modelu se propíše do bug807Reproduced', () => {
    const repro = summarize('small', [attempt({ id: 'P001', error: 'Invalid token id -1' })]);
    expect(buildReport({ ...base, reproduction: repro }).bug807Reproduced).toBe(true);
  });
});

describe('loadSentences', () => {
  it('vezme prvních 40 vět ze zmrazené sady a postaví produkční prompt', () => {
    const sentences = loadSentences();
    expect(sentences).toHaveLength(MEASURED_SENTENCES);
    expect(sentences[0]?.id).toBe('P001');
    // Prompt musí být ten produkční, jinak se výsledek nedá srovnat se
    // serverovou větví: obsahuje výčet polí obálky i větu ze zadání.
    expect(sentences[0]?.system).toContain('irVersion, simRevision, lookRevision, sim, look');
    expect(sentences[0]?.user).toContain(sentences[0]?.text ?? '');
  });
});

/**
 * Proč tyhle dva testy vznikly až po prvním měření.
 *
 * První běh (20. 8. 2026, nvidia/ampere, 40 vět) vrátil `schemaValid: 0` a
 * u 28 z nich **doslova stejnou** hlášku `expected nonoptional, received
 * undefined`. Ta věta říká, že chybí povinné pole, ale neříká **které** — a
 * `decision.md` v T6 se má rozhodovat právě podle toho, co model vynechává.
 * Report tedy naměřil číslo, ze kterého nešlo přečíst příčinu.
 *
 * Cesta k poli i ukázka syrové odpovědi jsou proto součástí měřidla, ne
 * pozdější diagnostiky: bez nich by se musel dvouhodinový běh opakovat pokaždé,
 * když se někdo zeptá „a co tam vlastně chybělo".
 */
describe('report se dá přečíst i po běhu', () => {
  it('u vadné emise jmenuje cestu k poli, ne jen hlášku schématu', () => {
    const broken = { ...MINIMAL_WORLD, sim: { layout: { width: 0, height: 0 } } };
    const detail = classifyOutput(JSON.stringify(broken)).detail;

    // Hláška samotná je pořád k dispozici, ale musí ji uvozovat cesta.
    expect(detail).toMatch(/sim\.\w+: /);
    expect(detail.length).toBeGreaterThan(0);
  });

  it('u chyby v kořeni dokumentu cestu nevymýšlí', () => {
    const { irVersion: _dropped, ...withoutVersion } = MINIMAL_WORLD;
    const detail = classifyOutput(JSON.stringify(withoutVersion)).detail;
    expect(detail).toMatch(/^1× rozpor — irVersion:/);
  });

  it('nezastaví se u prvního rozporu — počítá obě větve najednou', () => {
    // Zod vrací seznam; `issues[0]` z něj vybere jedno pole a zbytek zamlčí.
    // Report by pak u celého chybějícího dokumentu jmenoval jediné pole.
    const count = (body: Record<string, unknown>): number =>
      Number(/^(\d+)× rozpor/.exec(classifyOutput(JSON.stringify(body)).detail)![1]);

    const simOnly = count({ ...MINIMAL_WORLD, sim: { layout: {} } });
    const both = count({ ...MINIMAL_WORLD, sim: { layout: {} }, look: { palette: 'x' } });

    expect(simOnly).toBeGreaterThan(1);
    expect(both).toBeGreaterThan(simOnly);
  });

  it('pojmenuje i větev vzhledu, ne jen simulaci', () => {
    const detail = classifyOutput(JSON.stringify({ ...MINIMAL_WORLD, look: { palette: 'x' } })).detail;
    expect(detail).toContain('look.');
  });

  it('dlouhý seznam ořízne, ale řekne kolik zbylo', () => {
    const broken = { ...MINIMAL_WORLD, sim: { layout: {} }, look: { palette: 'x' } };
    const detail = classifyOutput(JSON.stringify(broken)).detail;

    expect(detail.split('; ').length).toBeLessThanOrEqual(LISTED_ISSUES);
    expect(detail).toMatch(/\(\+\d+ dalších\)$/);
  });

  it('nese ukázku toho, co model doopravdy napsal', () => {
    const raw = `{"irVersion":"world-ir-v1","sim":{"broken":true}}`;
    const summary = summarize('m', [attempt({ id: 'P001', raw })]);

    expect(summary.perSentence[0]!.rawExcerpt).toContain('world-ir-v1');
  });

  it('ukázku ořízne, aby jedna zacyklená odpověď nezaplavila report', () => {
    const raw = `{"irVersion":"${'x'.repeat(5000)}"}`;
    const summary = summarize('m', [attempt({ id: 'P001', raw })]);

    expect(summary.perSentence[0]!.rawExcerpt.length).toBeLessThanOrEqual(600);
  });

  it('u pádu ukázku nepředstírá', () => {
    const summary = summarize('m', [attempt({ id: 'P001', error: 'RuntimeError: Aborted()' })]);
    expect(summary.perSentence[0]!.rawExcerpt).toBe('');
  });
});

/**
 * Proč se syrové odpovědi ukládají celé, vedle reportu.
 *
 * Měření trvá půl hodiny na skutečném GPU. Když se pak ukáže, že se report ptal
 * na špatnou věc, není z čeho odpovědět jinak než dalším půlhodinovým během —
 * ukázka v reportu je oříznutá schválně. Archiv drží to, co model napsal, celé,
 * takže každá další otázka nad týmž během je zadarmo.
 */
describe('archiv syrových odpovědí', () => {
  it('drží odpověď celou, ne oříznutou jako ukázka v reportu', () => {
    const raw = `{"irVersion":"${'x'.repeat(5000)}"}`;
    const archive = buildRawArchive('2026-08-20T00:00:00.000Z', [{ model: 'm', records: [attempt({ id: 'P001', raw })] }]);

    expect(archive.runs[0]!.outputs[0]!.raw).toBe(raw);
    expect(archive.runs[0]!.outputs[0]!.raw.length).toBeGreaterThan(RAW_EXCERPT_LIMIT);
  });

  it('pád do archivu nezapisuje — žádná odpověď nevznikla', () => {
    const archive = buildRawArchive('2026-08-20T00:00:00.000Z', [
      { model: 'm', records: [attempt({ id: 'P001', error: 'RuntimeError: Aborted()' }), attempt({ id: 'P002', raw: '{}' })] },
    ]);

    expect(archive.runs[0]!.outputs.map((o) => o.id)).toEqual(['P002']);
  });

  it('oba modely drží zvlášť, ať je poznat čí je která odpověď', () => {
    const archive = buildRawArchive('2026-08-20T00:00:00.000Z', [
      { model: 'big', records: [attempt({ id: 'P001', raw: '{"a":1}' })] },
      { model: 'small', records: [attempt({ id: 'P001', raw: '{"b":2}' })] },
    ]);

    expect(archive.runs.map((r) => r.model)).toEqual(['big', 'small']);
    expect(archive.measuredAt).toBe('2026-08-20T00:00:00.000Z');
  });
});

/**
 * Měření jede v produkčním pořadí: rozpoznávač první, model na zbytek.
 *
 * Kdyby report měřil jen model, měřil by cestu, kterou produkt nepoužívá — a AC
 * T7 se ptá právě na to, o kolik se `schemaValid` zvedne, když se rozpoznávač
 * zapojí. Proto se ta hranice testuje tady, ne až v půlhodinovém e2e běhu.
 */
describe('rozdělení mezi rozpoznávač a model', () => {
  it('nechá modelu jen věty, které rozpoznávač nezná', () => {
    const sentences = loadSentences();
    const { handled, forModel } = splitByRecognizer(sentences);

    expect(handled.length + forModel.length).toBe(sentences.length);
    expect(handled.length).toBeGreaterThan(0);
    // Kdyby rozpoznávač obsloužil všechno, měření o modelu už nic neříká —
    // a `CLAUDE.md` rozpor 9 přesně tímhle tvarem popisuje vakuózní mechanismus.
    expect(forModel.length).toBeGreaterThan(0);
  });

  it('pokusy z rozpoznávače jsou v reportu poznat', () => {
    const { handled } = splitByRecognizer(loadSentences());
    expect(handled.every((record) => record.finishReason === SHAPES_MARKER)).toBe(true);

    const summary = summarize('m', handled);
    expect(summary.shapesHandled).toBe(handled.length);
    // Rozpoznávač staví platné světy, takže se počítají do `schemaValid`.
    expect(summary.fulfilled).toBe(handled.length);
  });

  it('nulová latence rozpoznávače nestahuje medián modelu', () => {
    const model = attempt({ id: 'P002', raw: '{}', latencyMs: 30000 });
    const shaped = { id: 'P001', latencyMs: 0, finishReason: SHAPES_MARKER, raw: '{}', error: '' };
    const summary = summarize('m', [shaped, model]);

    // Kdyby se nula počítala, medián by spadl na 15 000 a přestal by být
    // srovnatelný s během bez rozpoznávače.
    expect(summary.medianLatencyMs).toBe(30000);
  });

  it('sloučené záznamy jdou v pořadí korpusu, ne v pořadí doběhnutí', () => {
    const sentences = loadSentences(3);
    const shuffled = [
      attempt({ id: sentences[2]!.id, raw: '{}' }),
      attempt({ id: sentences[0]!.id, raw: '{}' }),
      attempt({ id: sentences[1]!.id, raw: '{}' }),
    ];

    expect(mergeRecords(sentences, shuffled).map((record) => record.id)).toEqual(sentences.map((s) => s.id));
  });
});
