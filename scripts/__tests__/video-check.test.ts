/**
 * Brána nad scénářem videa.
 *
 * Dva vzorky drží obě větve exit kódu — jeden pod tvrdým limitem, jeden nad
 * ním. Zbytek souboru je o tvarech, které **vypadají jako platný scénář a
 * nejsou**: překryté úseky, díra na časové ose, úsek běžící pozpátku a
 * chybějící beat. Všechny čtyři by prošly kontrolou, která jen sečte čísla —
 * a všechny čtyři vyrobí video jiné délky, než scénář tvrdí.
 *
 * Poslední blok míří na skutečný `docs/video-script.md`. Tvrdí o něm tři věci,
 * které jinak nedrží nic: že je pod **2:50** (rezerva na střih, ne tvrdý limit),
 * že v něm jsou všechny povinné scény a že prvních 15 s je věta → hraná hra.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  LIMIT_SECONDS,
  REQUIRED_BEATS,
  contiguityError,
  main,
  missingBeats,
  parseSegments,
  parseTime,
  totalSeconds,
} from '../video-check.mjs';

/** Cíl scénáře je 2:50, ne tvrdý limit 3:00 — deset sekund je rezerva na střih. */
const SCRIPT_TARGET_SECONDS = 170;

const HEADER = ['| Čas | Beat | Co je na obrazovce |', '|---|---|---|'];

/** Tabulka scénáře z dvojic `[konec úseku, beat]`, navazujících od nuly. */
function table(rows: Array<[end: string, beat: string]>): string {
  let start = '0:00';
  const lines = rows.map(([end, beat]) => {
    const line = `| ${start}–${end} | \`${beat}\` | popis |`;
    start = end;
    return line;
  });
  return [...HEADER, ...lines].join('\n');
}

/** `m:ss` ze sekund, pro vzorky. */
function at(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Scénář ze scén po 15 s, kde poslední úsek končí v `end`. */
function script(beats: readonly string[], end: string): string {
  return table(beats.map((beat, index) => [index === beats.length - 1 ? end : at(15 * (index + 1)), beat]));
}

/** Scénář se všemi povinnými scénami, kde poslední úsek končí v `end`. */
function fullScript(end: string): string {
  return script(REQUIRED_BEATS, end);
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'video-check-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Vzorek na disk a exit kód skriptu nad ním. Výpis se cestou nekontroluje. */
function run(name: string, markdown: string): number {
  const file = join(dir, `${name}.md`);
  writeFileSync(file, markdown, 'utf-8');
  const silent = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return main([file]);
  } finally {
    silent.mockRestore();
  }
}

describe('exit kód: dva vzorky, obě větve', () => {
  it('pod tvrdým limitem skončí nulou', () => {
    expect(run('pod-limitem', fullScript('2:40'))).toBe(0);
  });

  it('nad tvrdým limitem skončí nenulově', () => {
    expect(run('nad-limitem', fullScript('3:20'))).toBe(1);
  });

  it('přesně na limitu ještě projde, o sekundu dál už ne', () => {
    expect(run('na-limitu', fullScript('3:00'))).toBe(0);
    expect(run('sekundu-pres', fullScript('3:01'))).toBe(1);
  });
});

describe('parseTime', () => {
  it.each([
    ['0:00', 0],
    ['1:23', 83],
    ['12:00', 720],
  ])('%s je %i s', (text, seconds) => {
    expect(parseTime(text)).toBe(seconds);
  });

  it.each(['1:60', '1:7', 'brzy', '', ':30'])('odmítne %s', (text) => {
    expect(parseTime(text)).toBeNull();
  });
});

describe('parseSegments: čte se tabulka, ne próza kolem ní', () => {
  it('vezme jen řádky s časovým rozsahem a beatem', () => {
    const markdown = [
      '# Scénář',
      '',
      'Věta o tom, že video trvá 0:00–9:99 a to není úsek.',
      ...HEADER,
      '| 0:00–0:30 | `world-builds` | svět se staví |',
      '',
      '> poznámka pod tabulkou',
    ].join('\n');
    expect(parseSegments(markdown)).toEqual([{ start: 0, end: 30, beat: 'world-builds' }]);
  });

  it('bere pomlčku i spojovník mezi značkami', () => {
    const rows = parseSegments(
      [...HEADER, '| 0:00-0:30 | `world-builds` | a |', '| 0:30–0:40 | `offline` | b |'].join('\n'),
    );
    expect(rows.map((row) => row.end)).toEqual([30, 40]);
  });
});

describe('contiguityError: součet musí být skutečná stopáž', () => {
  it('spojitá osa od nuly projde', () => {
    expect(contiguityError(parseSegments(fullScript('2:00')))).toBeNull();
  });

  it('překryv se najde — jinak by součet byl kratší než video', () => {
    const overlapping = [...HEADER, '| 0:00–0:40 | `a` | x |', '| 0:20–1:00 | `b` | y |'].join('\n');
    const segments = parseSegments(overlapping);
    expect(totalSeconds(segments)).toBe(80);
    expect(contiguityError(segments)).toContain('překryv');
  });

  it('díra mezi úseky se najde — jinak by součet byl kratší než video', () => {
    const gapped = [...HEADER, '| 0:00–0:20 | `a` | x |', '| 0:40–1:00 | `b` | y |'].join('\n');
    expect(contiguityError(parseSegments(gapped))).toContain('díra');
  });

  it('úsek pozpátku se najde — má zápornou délku a zkracuje součet', () => {
    const backwards = [...HEADER, '| 0:00–0:40 | `a` | x |', '| 0:40–0:20 | `b` | y |'].join('\n');
    expect(contiguityError(parseSegments(backwards))).toContain('dřív, než začal');
  });

  it('scénář, který nezačíná v nule, neprojde', () => {
    const late = [...HEADER, '| 0:10–0:40 | `a` | x |'].join('\n');
    expect(contiguityError(parseSegments(late))).toContain('ne v nule');
  });

  it('scénář bez jediného úseku neprojde jako nulová stopáž', () => {
    expect(run('bez-tabulky', '# Scénář\n\nŽádná tabulka.')).toBe(1);
  });
});

describe('missingBeats', () => {
  it('scénář bez jedné scény neprojde, i když je krátký', () => {
    const withoutLeaderboard = script(
      REQUIRED_BEATS.filter((beat) => beat !== 'leaderboard'),
      '1:40',
    );
    expect(missingBeats(parseSegments(withoutLeaderboard))).toEqual(['leaderboard']);
    expect(run('bez-zebricku', withoutLeaderboard)).toBe(1);
  });

  it('scéna navíc nevadí, chybí-li nic', () => {
    const withExtra = script([...REQUIRED_BEATS, 'close'], '2:00');
    expect(missingBeats(parseSegments(withExtra))).toEqual([]);
    expect(run('scena-navic', withExtra)).toBe(0);
  });
});

describe('argument a nečitelný soubor', () => {
  it('bez argumentu skončí nenulově', () => {
    const silent = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(main([])).toBe(1);
    } finally {
      silent.mockRestore();
    }
  });

  it('neexistující soubor skončí nenulově', () => {
    const silent = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(main([join(dir, 'neni-tam.md')])).toBe(1);
    } finally {
      silent.mockRestore();
    }
  });
});

describe('skutečný docs/video-script.md', () => {
  const scriptFile = join(process.cwd(), 'docs', 'video-script.md');

  it('projde bránou', () => {
    const silent = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(main([scriptFile])).toBe(0);
    } finally {
      silent.mockRestore();
    }
  });

  it('je pod 2:50, ne jen pod tvrdým limitem 3:00', () => {
    const segments = parseSegments(readFileSync(scriptFile, 'utf-8'));
    expect(totalSeconds(segments)).toBeLessThan(SCRIPT_TARGET_SECONDS);
    expect(SCRIPT_TARGET_SECONDS).toBeLessThan(LIMIT_SECONDS);
  });

  it('nese všechny povinné scény', () => {
    const segments = parseSegments(readFileSync(scriptFile, 'utf-8'));
    expect(missingBeats(segments)).toEqual([]);
    expect(REQUIRED_BEATS).toHaveLength(6);
  });

  it('prvních 15 s je věta → hraná hra', () => {
    const [first] = parseSegments(readFileSync(scriptFile, 'utf-8'));
    expect(first.beat).toBe('say-to-play');
    expect(first.end).toBeLessThanOrEqual(15);
  });
});
