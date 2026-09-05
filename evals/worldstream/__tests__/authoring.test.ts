/**
 * Součástky nehlídaného běhu, který uvaří světy.
 *
 * ⚠ **Codex se tu nevolá a volat se nesmí.** Test, který sáhne na model, měří
 * poskytovatele: trvá minuty, padá po síti a o skriptu neřekne nic. Spouštěč je
 * proto vyměnitelný (`CodexRunner`) a všechny zkoušky běží nad předstíraným.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  answerFrom,
  askCodex,
  carryOver,
  outcomeOf,
  reportFrom,
  stillToAuthor,
  STORE_VERSION,
  withWorld,
  type AuthoredStore,
  type AuthoredWorld,
  type AuthoringResult,
} from '../authoring';

const EMPTY: AuthoredStore = { version: STORE_VERSION, worlds: [] };

function world(id: string): AuthoredWorld {
  return { id, prompt: `${id} prompt`, heroObjects: [], synonyms: [], planner: {}, compiler: {} };
}

/* ================================================================== *
 * 1. Výstup Codexu — dva formáty a próza kolem něj.
 * ================================================================== */

describe('the answer is read out of whatever Codex printed', () => {
  it('reads the bare JSON a pipe gets', () => {
    // ⚠ Do roury jde jen finální zpráva. Tohle je formát, který běh doopravdy
    // dostane, a proto se zkouší první.
    expect(answerFrom('{"intent":{"setting":"a harbour"}}')).toEqual({
      intent: { setting: 'a harbour' },
    });
  });

  it('reads the body out of the banner a terminal gets', () => {
    const terminal = ['OpenAI Codex v0.0.0', '--------', 'user', 'read the file', '', 'codex', '{"objects":[]}', '', 'tokens used: 1234'].join('\n');

    expect(answerFrom(terminal)).toEqual({ objects: [] });
  });

  it('reads through code fences, because a model writes them out of habit', () => {
    expect(answerFrom('```json\n{"kept":true}\n```')).toEqual({ kept: true });
  });

  it('throws on prose with no JSON in it instead of returning something empty', () => {
    // Prázdný objekt by se uložil jako svět a demo by na tu větu postavilo nic.
    expect(() => answerFrom('I could not do that.')).toThrow(/nevratil JSON/);
  });
});

/* ================================================================== *
 * 2. Kontrakt jde na disk, prompt zůstane jednořádkový.
 * ================================================================== */

describe('the request reaches Codex the one way that works', () => {
  it('puts the contract in a file and hands over only its path', () => {
    // ⚠ **Past 1.** `codex exec "<víceřádkový prompt>"` předá jen první řádek —
    // naměřeno, vrátil `{}`. Systémová zpráva má tisíce znaků a desítky řádků,
    // takže tudy jinak projít nemůže.
    let handed = '';
    const answer = askCodex(
      { model: 'x', system: 'line one\nline two\nline three', user: 'the brief' },
      (contractPath) => {
        handed = contractPath;
        return '{"ok":true}';
      },
    );

    expect(answer).toEqual({ ok: true });
    expect(handed).not.toContain('\n');
    expect(handed.endsWith('contract.md')).toBe(true);
  });

  it('writes both halves of the request, not just the system half', () => {
    // Bez `user` by Codex dostal kontrakt bez zadání a napsal by svět o ničem.
    let written = '';
    askCodex({ model: 'x', system: 'THE RULES', user: 'A lighthouse on a cliff' }, (path) => {
      written = readFileSync(path, 'utf8');
      return '{}';
    });

    expect(written).toContain('THE RULES');
    expect(written).toContain('A lighthouse on a cliff');
  });
});

/* ================================================================== *
 * 3. Sklad: co se uloží, co se přeskočí, co se zahodí.
 * ================================================================== */

describe('the store grows without losing what it had', () => {
  it('does not touch the store it was handed', () => {
    const before = withWorld(EMPTY, world('c01'));
    const after = withWorld(before, world('c02'));

    expect(before.worlds.map((entry) => entry.id)).toEqual(['c01']);
    expect(after.worlds.map((entry) => entry.id)).toEqual(['c01', 'c02']);
  });

  it('replaces a second run of the same sentence instead of storing it twice', () => {
    // Dvě `c01` ve skladu by o tom, které z nich demo ukáže, rozhodovaly
    // pořadím v souboru — tedy náhodou.
    const first = withWorld(EMPTY, { ...world('c01'), prompt: 'first' });
    const again = withWorld(first, { ...world('c01'), prompt: 'second' });

    expect(again.worlds).toHaveLength(1);
    expect(again.worlds[0]?.prompt).toBe('second');
  });

  it('skips what is already authored, which is the whole of being interruptible', () => {
    // Bez tohohle filtru by druhý běh po přerušení zaplatil hodinu za práci,
    // kterou má hotovou — a u nehlídaného běhu se to pozná až podle času.
    const cases = [{ id: 'c01' }, { id: 'c02' }, { id: 'c03' }];
    const store = withWorld(withWorld(EMPTY, world('c01')), world('c03'));

    expect(stillToAuthor(cases, store).map((entry) => entry.id)).toEqual(['c02']);
  });

  it('has nothing left to author once the store holds every sentence', () => {
    const cases = [{ id: 'c01' }];
    expect(stillToAuthor(cases, withWorld(EMPTY, world('c01')))).toEqual([]);
  });
});

/* ================================================================== *
 * 4. Report — rozpad příčin, ne jedno číslo.
 * ================================================================== */

describe('the report says why the rest did not make it', () => {
  it('breaks the failures down by cause instead of counting them', () => {
    // „22 z 30" neřekne, co opravit. Rozpad ano: tři odmítnutí na schématu je
    // vada kontraktu, tři různé fáze je vada v každé zvlášť.
    const report = reportFrom(
      [
        { id: 'c01', kept: true, cause: null, detail: null, seconds: 150, calls: 3 },
        { id: 'c02', kept: false, cause: 'schema', detail: 'no layout', seconds: 190, calls: 4 },
        { id: 'c03', kept: false, cause: 'schema', detail: 'no win rule', seconds: 200, calls: 4 },
        { id: 'c04', kept: false, cause: 'shape', detail: null, seconds: 60, calls: 2 },
      ],
      '2026-09-05T20:00:00.000Z',
    );

    expect(report.kept).toBe(1);
    expect(report.attempted).toBe(4);
    expect(report.causes).toEqual({ schema: 2, shape: 1 });
    expect(report.secondsTotal).toBe(600);
  });

  it('counts no cause for a world that was kept, so the breakdown stays readable', () => {
    const report = reportFrom(
      [{ id: 'c01', kept: true, cause: null, detail: null, seconds: 1, calls: 1 }],
      'now',
    );

    expect(report.causes).toEqual({});
  });
});

/* ================================================================== *
 * 4b. Report přes dávky — běh je přerušitelný, měření musí být taky.
 * ================================================================== */

describe('a resumed batch continues the report instead of replacing it', () => {
  const EARLIER: readonly AuthoringResult[] = [
    { id: 'c01', kept: true, cause: null, detail: null, seconds: 150, calls: 3 },
    { id: 'c02', kept: false, cause: 'witness', detail: 'NO_WIN', seconds: 210, calls: 4 },
  ];

  it('keeps what earlier batches measured, so the report describes all 30', () => {
    // Bez tohohle popisuje report poslední dávku a tváří se, že popisuje
    // zmrazenou sadu. Naměřeno 5. 9. 2026: první dávka uvařila 11 vět.
    const report = reportFrom([...carryOver(EARLIER, [{ id: 'c03' }]), ...[
      { id: 'c03', kept: true, cause: null, detail: null, seconds: 160, calls: 3 },
    ]], 'now');

    expect(report.results.map((result) => result.id)).toEqual(['c01', 'c02', 'c03']);
    expect(report.attempted).toBe(3);
    expect(report.causes).toEqual({ witness: 1 });
  });

  it('drops the old verdict of a sentence it is about to try again', () => {
    // Dva záznamy o téže větě by se v rozpadu počítaly dvakrát a starý verdikt
    // už stejně neplatí — tuhle větu právě přepisuje nový běh.
    expect(carryOver(EARLIER, [{ id: 'c02' }]).map((result) => result.id)).toEqual(['c01']);
  });
});

/* ================================================================== *
 * 5. Co se uloží — jediné rozhodnutí, které vidí porotce.
 * ================================================================== */

describe('only a world that came through the gates is kept', () => {
  const GOOD = {
    thrown: null,
    blueprintValid: true,
    geometryAuthored: true,
    failureStage: null,
    planner: { intent: {} },
    compiler: { world: {} },
  };

  it('keeps a case that passed both gates', () => {
    expect(outcomeOf(GOOD)).toEqual({ kept: true, cause: null, detail: null });
  });

  it('throws away a broken answer and names the stage it died on', () => {
    // Vadná odpověď (próza, useknutý JSON, prázdno) přiletí sem jako výjimka
    // z parseru. Uložit se nesmí a v reportu musí být poznat proč.
    expect(outcomeOf({ ...GOOD, thrown: 'Codex nevratil JSON' })).toEqual({
      kept: false,
      cause: 'unavailable',
      detail: 'Codex nevratil JSON',
    });
    expect(outcomeOf({ ...GOOD, blueprintValid: false, failureStage: 'schema' })).toEqual({
      kept: false,
      cause: 'schema',
      detail: null,
    });
  });

  it('keeps the cause short and puts the sentence beside it', () => {
    // **Tohle je ta vada, kvůli které se to měnilo.** Zpráva slepená do
    // `cause` vyrobí v rozpadu příčin vlastní příčku pro každé znění, takže
    // deset odmítnutí téže třídy se přečte jako deset různých vad. Klíč je
    // proto uzavřený a text jde vedle něj.
    const first = outcomeOf({ ...GOOD, thrown: 'exit 1: socket hang up' });
    const second = outcomeOf({ ...GOOD, thrown: 'exit 1: read ECONNRESET' });

    expect(first.cause).toBe(second.cause);
    expect(first.detail).not.toBe(second.detail);
  });

  it('carries the reason the gate gave, not just the stage it stood at', () => {
    // „witness" sám neřekne, co opravit: hledač cestu nenašel, našel ji nad
    // stropem, nebo runtime spadl — tři vady, tři různá místa opravy. Jedna
    // věta stojí ~200 s, takže zahozený důvod se platí znovu.
    expect(
      outcomeOf({
        ...GOOD,
        blueprintValid: false,
        failureStage: 'witness',
        failureDetail: 'NO_WIN: horizon exhausted without a win',
      }),
    ).toEqual({
      kept: false,
      cause: 'witness',
      detail: 'NO_WIN: horizon exhausted without a win',
    });
  });

  it('throws away a world that compiled and then fell back to clay', () => {
    // ⚠ `blueprintValid` samo nestačí. Uložený svět, který se nevykreslí, je
    // horší než žádný: tváří se jako hotová práce a `G2` na něj řekne ano.
    expect(outcomeOf({ ...GOOD, geometryAuthored: false, failureStage: 'shape' })).toEqual({
      kept: false,
      cause: 'shape',
      detail: null,
    });
  });

  it('throws away a case where only one of the two emissions was seen', () => {
    // Sklad bez plánu vydá na planner požadavek `null` a relace skončí
    // odmítnutím, jehož příčina není nikde vidět.
    expect(outcomeOf({ ...GOOD, planner: null }).kept).toBe(false);
    expect(outcomeOf({ ...GOOD, compiler: null }).cause).toMatch(/incomplete/);
  });
});
