/**
 * Kola opravy na obrazovce (P12 V2 T5).
 *
 * Soudí se **čisté funkce panelu**, ne jeho render — tak to má repozitář
 * u ostatních HUD panelů (`captionFor`, `promptOutcome`, `repairLines`).
 *
 * ⚠ **Že se kola objeví aspoň dvakrát, nejde ověřit e2e sadou a není to
 * opomenutí.** Kola vyrábí jedině `emitLocally()` z modelu na WebGPU;
 * Playwright běží přes SwiftShader, kde `modelPhase` skončí na `unavailable`
 * a model se nespustí ani jednou. Zbývaly dvě cesty: přidat do produkce seam
 * na podstrčení stroje, tedy plochu, která existuje kvůli testu, nebo pokrýt
 * pravidlo tady a nechat e2e sadě to, co v jejím prostředí opravdu nastane
 * (panel bez opravy nestojí a roh dál patří svým panelům). Zvolená je druhá,
 * protože první by kvůli jednomu tvrzení otevřela produkt.
 */

import { describe, expect, it } from 'vitest';

import { roundLines, roundsCaption, showsRounds } from '../hud/RepairRounds';

import type { Rejection } from '@/model/certify';
import type { Round } from '@/model/local/emit';

function rejection(overrides: Partial<Rejection> = {}): Rejection {
  return {
    stage: 'references',
    reason: 'DANGLING_REFERENCE',
    detail: 'sim.rules.win.event.zone names no declared zone exitPad',
    issues: [],
    atStep: null,
    ...overrides,
  };
}

function round(attempt: number, fault: Rejection | null): Round {
  return { attempt, rejection: fault, ms: 34_000 };
}

describe('kdy panel stojí', () => {
  it('jedno kolo není oprava a panel se neukáže', () => {
    expect(showsRounds([round(1, null)])).toBe(false);
    expect(showsRounds([])).toBe(false);
  });

  it('dvě a víc kol je oprava a ta se ukazuje', () => {
    expect(showsRounds([round(1, rejection()), round(2, null)])).toBe(true);
    expect(showsRounds([round(1, rejection()), round(2, rejection()), round(3, null)])).toBe(true);
  });
});

describe('kola na řádky', () => {
  it('poslední kolo bez odmítnutí je certifikované, předchozí nesou důvod', () => {
    const lines = roundLines([round(1, rejection()), round(2, null)]);

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.state)).toEqual(['rejected', 'certified']);
    expect(lines.map((line) => line.attempt)).toEqual([1, 2]);
  });

  it('důvod je věta s adresou, ne kód odmítnutí', () => {
    const lines = roundLines([round(1, rejection()), round(2, null)]);

    // Porotci `DANGLING_REFERENCE` neřekne nic; adresa pole ano. Je to táž
    // věta, jakou dostal model — na obrazovce nesmí stát hezčí převyprávění.
    expect(lines[0]!.text).not.toContain('DANGLING_REFERENCE');
    expect(lines[0]!.text).toContain('sim.rules.win.event.zone');
  });

  it('u nedohrané cesty pojmenuje krok, na kterém se to zlomilo', () => {
    const lines = roundLines([
      round(1, rejection({ stage: 'witness', reason: 'STEP_UNREACHABLE', detail: 'witness step 3', atStep: 3 })),
      round(2, null),
    ]);

    expect(lines[0]!.text).toContain('step 3');
    expect(lines[0]!.text).not.toContain('STEP_UNREACHABLE');
  });

  it('tři neúspěšná kola nemají certifikovaný řádek', () => {
    const lines = roundLines([round(1, rejection()), round(2, rejection()), round(3, rejection())]);

    expect(lines.every((line) => line.state === 'rejected')).toBe(true);
  });
});

describe('nadpis podle výsledku', () => {
  it('povedená oprava a nepovedená se liší, a obě mluví o opravě', () => {
    const fixed = roundsCaption(roundLines([round(1, rejection()), round(2, null)]));
    const failed = roundsCaption(roundLines([round(1, rejection()), round(2, rejection())]));

    expect(fixed).not.toBe(failed);
    expect(fixed).toContain('corrected itself');
    expect(failed).toContain('could not fix it');
  });

  it('prázdný seznam nespadne', () => {
    expect(roundsCaption([])).toContain('could not fix it');
  });
});

describe('rozhraní je anglicky', () => {
  it('žádný řádek ani nadpis nenese českou diakritiku', () => {
    const lines = roundLines([round(1, rejection()), round(2, null)]);
    const text = [roundsCaption(lines), ...lines.map((line) => line.text)].join(' ');

    expect(text).not.toMatch(/[ěščřžýáíéúůťňďó]/i);
  });
});
