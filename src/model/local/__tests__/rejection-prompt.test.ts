/**
 * Věta, kterou se model dozví, co udělal špatně.
 *
 * Je to **jediný** vstup opravné smyčky. Vágní nebo prázdná věta vypadá jako
 * funkční smyčka — kola se protočí, kolo 2 vydá tutéž vadu a nikdo nepozná, že
 * model nedostal, co potřeboval. Vada je proto neviditelná až do měření T4, a
 * to je pozdě.
 *
 * Testuje se tedy to, co se okem nezkontroluje:
 *
 * 1. **Každá fáze i každý důvod vydá neprázdnou anglickou větu.** Sedm fází,
 *    pět důvodů ověřovače, nic nesmí propadnout na prázdný řetězec.
 * 2. **Věta nese adresu, ne náladu.** Cestu k poli, jméno pravidla nebo číslo
 *    kroku — model potřebuje vědět, KDE, ne že „to nevyšlo".
 * 3. **Cesty selhání.** Odmítnutí bez `issues`, `atStep: null`, neznámý důvod
 *    z budoucí verze. Žádná z nich nesmí shodit ani vydat prázdno.
 */

import { describe, expect, it } from 'vitest';

import type { Rejection, Stage } from '../../certify';
import { contextFromEmission, describeStep, rejectionSentence } from '../rejection-prompt';

const STAGES: readonly Stage[] = ['schema', 'references', 'lowering', 'witness', 'look', 'declined', 'request'];

/** Pět důvodů ověřovače, jak je vyjmenovává `RejectReason`. */
const WITNESS_REASONS = ['NO_FIT', 'INPUT_CAP', 'STEP_UNREACHABLE', 'NO_WIN', 'RUNTIME_FAULT'] as const;

function rejection(over: Partial<Rejection> = {}): Rejection {
  return {
    stage: 'schema',
    reason: 'SCHEMA_VIOLATION',
    detail: 'unrecognized key',
    issues: ['/sim/rules/2/effects: unrecognized key'],
    atStep: null,
    ...over,
  };
}

/** Věta je anglická a k něčemu — ne prázdná, ne jen kód. */
function isUsableSentence(text: string): boolean {
  return text.trim().length > 20 && /[a-z]{4,}\s+[a-z]{2,}/.test(text);
}

describe('každá fáze vydá použitelnou větu', () => {
  it.each(STAGES)('%s', (stage) => {
    const text = rejectionSentence(rejection({ stage, reason: `${stage.toUpperCase()}_FAILED` }));
    expect(isUsableSentence(text), `fáze ${stage} vydala: ${JSON.stringify(text)}`).toBe(true);
  });
});

describe('každý důvod ověřovače vydá použitelnou větu', () => {
  it.each(WITNESS_REASONS)('%s', (reason) => {
    const text = rejectionSentence(
      rejection({ stage: 'witness', reason, detail: 'horizon 600 exhausted in state running', atStep: 4 }),
    );
    expect(isUsableSentence(text), `důvod ${reason} vydal: ${JSON.stringify(text)}`).toBe(true);
  });
});

describe('věta nese adresu, ne náladu', () => {
  it('u schématu opíše cestu k poli', () => {
    const text = rejectionSentence(rejection({ issues: ['/sim/rules/2/effects: unrecognized key'] }));
    expect(text).toContain('/sim/rules/2/effects');
  });

  it('u osiřelého odkazu opíše, co je nedeklarované', () => {
    const text = rejectionSentence(
      rejection({
        stage: 'references',
        reason: 'DANGLING_REFERENCE',
        detail: 'sim.rules[enterArch].event.zone names no declared socket glowingArch',
        issues: ['sim.rules[enterArch].event.zone: unknown socket glowingArch'],
      }),
    );
    expect(text).toContain('sim.rules[enterArch].event.zone');
    expect(text).toContain('glowingArch');
  });

  it('u nesnížitelného povrchu opíše pravidlo i událost', () => {
    const text = rejectionSentence(
      rejection({
        stage: 'lowering',
        reason: 'UNSUPPORTED_SURFACE',
        detail: 'rule warm: event onTimerEnd has no lowering',
        issues: ['rule warm: event onTimerEnd has no lowering'],
      }),
    );
    expect(text).toContain('onTimerEnd');
    expect(text).toContain('warm');
  });

  it('u neproveditelného kroku uvede jeho číslo a co ten krok dělal', () => {
    const text = rejectionSentence(
      rejection({
        stage: 'witness',
        reason: 'STEP_UNREACHABLE',
        detail: 'step lies after the run ended at tick 65',
        atStep: 2,
      }),
      {
        witness: [
          { tick: 1, actor: 'player', actionId: 'take', target: 'crystal' },
          { tick: 9, actor: 'player', actionId: 'use', target: 'altar' },
          { tick: 30, actor: 'player', actionId: 'enter', target: 'arch' },
        ],
      },
    );
    expect(text).toContain('2');
    expect(text).toContain('enter');
    expect(text).toContain('arch');
  });

  it('u NO_FIT doporučí tier, který by horizont unesl', () => {
    const text = rejectionSentence(
      rejection({ stage: 'witness', reason: 'NO_FIT', detail: 'horizon 900 does not fit tier short' }),
      { horizonTicks: 900 },
    );
    expect(text).toContain('standard');
  });

  it('u horizontu nad stropem všech tierů řekne zkrátit, ne povýšit', () => {
    // 9000 tiků neunese ani `long` (3600). Doporučit tier, který neexistuje, by
    // poslalo model do kola, ze kterého se nedostane.
    const text = rejectionSentence(
      rejection({ stage: 'witness', reason: 'NO_FIT', detail: 'horizon 9000 does not fit tier long' }),
      { horizonTicks: 9_000 },
    );
    expect(text).toContain('3600');
    expect(text).not.toContain('"long"');
  });

  it('u kopie ukázky jmenuje identifikátory, které do světa nepatří', () => {
    const text = rejectionSentence(
      rejection({
        stage: 'request',
        reason: 'EXAMPLE_COPY',
        detail: 'the model copied the syntax example instead of answering the request',
        issues: [],
      }),
    );
    expect(text).toContain('gatePad');
  });
});

describe('cesty selhání', () => {
  it('odmítnutí bez `issues` vydá větu z `detail`, ne prázdno', () => {
    const text = rejectionSentence(rejection({ issues: [], detail: 'the emission body is not a JSON object' }));
    expect(isUsableSentence(text)).toBe(true);
    expect(text).toContain('not a JSON object');
  });

  it('`atStep: null` u kroku nevyrobí „step null"', () => {
    const text = rejectionSentence(
      rejection({ stage: 'witness', reason: 'STEP_UNREACHABLE', detail: 'no step survived', atStep: null }),
    );
    expect(isUsableSentence(text)).toBe(true);
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });

  it('neznámý důvod z budoucí verze vydá obecnou větu místo pádu', () => {
    const text = rejectionSentence(rejection({ stage: 'witness', reason: 'A_REASON_FROM_2027', detail: '' }));
    expect(isUsableSentence(text)).toBe(true);
    expect(text).toContain('A_REASON_FROM_2027');
  });

  it('`atStep` mimo rozsah svědka větu nezlomí', () => {
    const text = rejectionSentence(
      rejection({ stage: 'witness', reason: 'STEP_UNREACHABLE', detail: 'broke', atStep: 40 }),
      { witness: [{ tick: 1, actor: 'player', actionId: 'take', target: 'crystal' }] },
    );
    expect(isUsableSentence(text)).toBe(true);
    expect(text).not.toContain('undefined');
  });
});

describe('kontext z emise', () => {
  it('vytáhne svědka i horizont, které si emise vyžádala', () => {
    const context = contextFromEmission({
      sim: { witness: { tier: 'short', H_cert: 600, ops: [{ tick: 3, actor: 'player', actionId: 'take' }] } },
    });
    expect(context.horizonTicks).toBe(600);
    expect(context.witness?.length).toBe(1);
  });

  it('z rozbité emise vydá prázdný kontext místo pádu', () => {
    expect(contextFromEmission(null)).toEqual({});
    expect(contextFromEmission('nonsense')).toEqual({});
    expect(contextFromEmission({ sim: { witness: { ops: 'not an array' } } })).toEqual({});
  });

  it('bez `H_cert` odvodí horizont ze stropu deklarovaného tieru', () => {
    const context = contextFromEmission({ sim: { witness: { tier: 'short', ops: [] } } });
    expect(typeof context.horizonTicks).toBe('number');
  });
});

describe('describeStep', () => {
  it('popíše tah jménem, ne indexem', () => {
    expect(describeStep({ tick: 4, actor: 'player', actionId: 'use', target: 'lever' })).toBe('player: use → lever');
  });

  it('kanonický zástupce za chybějící cíl se nevypisuje', () => {
    expect(describeStep({ tick: 4, actor: 'player', actionId: 'wait', target: 'none' })).toBe('player: wait');
    expect(describeStep({ tick: 4, actor: 'player', actionId: 'wait' })).toBe('player: wait');
  });
});
