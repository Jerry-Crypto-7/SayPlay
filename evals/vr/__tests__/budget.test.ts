/**
 * Rozpočet snímku Questu 2 (P65 T6) přepočítaný z měření: `evals/vr/budget.json` zapisuje `evals/vr/budget.mjs`
 * (všech 19 žánrů v emulátoru IWER, nad každým panely výsledku, sdílení, „Comfort“ a lobby s klávesnicí, a k tomu
 * obrazovky lobby a feedu, P67 T13). Nejhorší snímek každého případu se spočte znovu ze vzorků, ne z čísla, které
 * soubor nebo README o sobě tvrdí, a porovná s `QUEST2_BUDGET`. Případ nad rozpočtem test shodí; srazit se má
 * v profilu XR (`src/play/xr/quality.ts`, `XrCull` v `XrRig.tsx`, kresba panelů v `XrPanel.tsx`) a změřit znovu.
 *
 * Brána FPS z brýlí (P67 T13): když `evals/vr/quest2-fps.json` říká `connected: true`, medián a 5. percentil
 * každého žánru se spočtou znovu ze vzorků po sekundách a musí držet medián ≥ 72 a 5. percentil ≥ 65.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { QUEST2_BUDGET } from '@/play/xr/quality';

import { FPS_GATE, NOT_MEASURED, belowGate, summarizeFps } from '../../../scripts/quest-dev.mjs';

/** Panel otevřený ve vzorku; `null` = hra bez panelu (HUD hry k ní patří). */
type Panel = 'result' | 'share' | 'comfort' | 'lobby' | 'keyboard' | null;

interface Sample {
  readonly tick: number | null;
  readonly panel: Panel;
  readonly calls: number;
  readonly triangles: number;
  readonly textureMB: number;
  readonly presenting: boolean;
  readonly eyes: number;
  /** Karta sdílení: QR kód už na ní stál. */
  readonly qr?: boolean;
}
interface Row {
  readonly id: string;
  readonly kind: 'native' | 'room' | 'surround' | 'diorama' | 'screen';
  readonly samples: readonly Sample[];
  readonly max: { readonly calls: number; readonly triangles: number; readonly textureMB: number };
}
interface Report {
  readonly budget: { readonly calls: number; readonly triangles: number };
  readonly ticks: number;
  readonly every: number;
  readonly genres: readonly Row[];
  readonly screens: readonly Row[];
}
interface FpsRow {
  readonly id: string;
  readonly fps: readonly number[];
  readonly median: number | null;
  readonly p5: number | null;
  readonly samples: number;
}
type FpsFile =
  | { readonly connected: true; readonly tour: boolean; readonly gate: { readonly median: number; readonly p5: number }; readonly genres: readonly FpsRow[] }
  | { readonly connected: false; readonly note: string; readonly reason: string };

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const report = JSON.parse(read('../budget.json')) as Report;
const quest = JSON.parse(read('../quest2-fps.json')) as FpsFile;
const readme = read('../README.md');
/** Návod a měření pro lidi (`docs/vr/README.md`): souhrn rozpočtu po režimech. */
const guide = read('../../../docs/vr/README.md');

const worst = (samples: readonly Sample[]) => ({
  calls: Math.max(...samples.map((sample) => sample.calls)),
  triangles: Math.max(...samples.map((sample) => sample.triangles)),
});

/** Nejhorší snímek případu ze vzorků. */
const peakOf = (row: Row) => ({ ...worst(row.samples), textureMB: Math.max(...row.samples.map((sample) => sample.textureMB)) });

/** Nejhorší snímek s panelem `panel` (`null` = hra bez panelu); `null`, když se panel neměřil. */
function panelPeak(row: Row, panel: Panel): { calls: number; triangles: number } | null {
  const open = row.samples.filter((sample) => sample.panel === panel);
  return open.length === 0 ? null : worst(open);
}

/** Případy nad rozpočtem, přepočtené ze vzorků. */
function overBudget(rows: readonly Row[], budget: { readonly calls: number; readonly triangles: number }): string[] {
  return rows.flatMap((row) => {
    const peak = peakOf(row);
    return peak.calls > budget.calls || peak.triangles > budget.triangles ? [`${row.id}: ${String(peak.calls)} calls, ${String(peak.triangles)} triangles`] : [];
  });
}

const OVER_GAME: readonly Panel[] = ['result', 'share', 'comfort', 'lobby', 'keyboard'];

describe('Quest 2 frame budget per genre (evals/vr/budget.json)', () => {
  it('measures all 19 genres – 4 played by hand, 3 around the player, 6 tracks on the stage, 6 on the desk – in a two-eye VR session', () => {
    const ids = report.genres.map((genre) => genre.id);
    expect(new Set(ids).size).toBe(19);
    expect(new Set(ids.map((id) => id.split('.')[0])).size).toBe(19);
    const genresOf = (kind: Row['kind']) => report.genres.filter((genre) => genre.kind === kind).map((genre) => genre.id.split('.')[0]).sort();
    expect(genresOf('native')).toEqual(['shooter', 'slice', 'throw', 'whack']);
    // Svět kolem hráče (P67 T6) se měří ve svém režimu, ne na stole.
    expect(genresOf('room')).toEqual(['arena', 'catch', 'defense']);
    // Tratě na pódiu (P67 T7) také ve svém režimu: pódium vidí víc trati než stůl.
    expect(genresOf('surround')).toEqual(['crowd', 'flap', 'hop', 'platformer', 'runner', 'voyage']);
    expect(genresOf('diorama')).toHaveLength(6);
    for (const row of [...report.genres, ...report.screens]) {
      expect(row.samples.length, row.id).toBeGreaterThan(1);
      expect(row.samples.every((sample) => sample.presenting && sample.eyes === 2), row.id).toBe(true);
    }
  });

  it('measures the panels over every game: result, the Share card with its QR code, Comfort, and the lobby with the keyboard from New game', () => {
    for (const genre of report.genres) {
      expect(genre.samples.filter((sample) => sample.panel === null).length, `${genre.id} play`).toBeGreaterThan(1);
      expect(OVER_GAME.filter((panel) => panelPeak(genre, panel) === null), genre.id).toEqual([]);
      // Karta sdílení se měří až s kódem: „Getting your link…“ by kód nekreslila.
      expect(genre.samples.filter((sample) => sample.panel === 'share').every((sample) => sample.qr === true), `${genre.id} share`).toBe(true);
    }
  });

  it('measures the lobby on /play (card, then keyboard) and the feed in VR (round, result with Next, next preview)', () => {
    expect(report.screens.map((screen) => [screen.id, screen.kind])).toEqual([
      ['lobby', 'screen'],
      ['feed', 'screen'],
    ]);
    const [lobby, feed] = report.screens;
    expect(panelPeak(lobby!, 'lobby')).not.toBeNull();
    expect(panelPeak(lobby!, 'keyboard')).not.toBeNull();
    expect(panelPeak(feed!, null)).not.toBeNull();
    expect(panelPeak(feed!, 'result')).not.toBeNull();
  });

  it('was measured against the current budget', () => {
    expect(report.budget).toEqual(QUEST2_BUDGET);
  });

  it('keeps the summary of each case equal to its worst sample', () => {
    for (const row of [...report.genres, ...report.screens]) expect(row.max, row.id).toEqual(peakOf(row));
  });

  it('keeps every genre, every panel over it, the lobby and the feed within the budget', () => {
    expect(overBudget([...report.genres, ...report.screens], QUEST2_BUDGET)).toEqual([]);
  });

  it('flags a case whose worst frame goes over the budget – a game frame or a panel frame', () => {
    const [first, ...rest] = report.genres;
    const spiked = { ...first!, samples: [...first!.samples, { ...first!.samples[0]!, calls: QUEST2_BUDGET.calls + 1 }] };
    expect(overBudget([spiked, ...rest, ...report.screens], QUEST2_BUDGET)).toEqual([expect.stringContaining(first!.id)]);
    const heavy = { ...first!, samples: [...first!.samples, { ...first!.samples[0]!, triangles: QUEST2_BUDGET.triangles + 1 }] };
    expect(overBudget([heavy], QUEST2_BUDGET)).toHaveLength(1);
    const keyboard = first!.samples.find((sample) => sample.panel === 'keyboard')!;
    const typed = { ...first!, samples: [...first!.samples, { ...keyboard, calls: QUEST2_BUDGET.calls + 44 }] };
    expect(overBudget([typed], QUEST2_BUDGET)).toHaveLength(1);
  });

  it('shows the measured numbers in evals/vr/README.md, not numbers typed by hand', () => {
    const cell = (text: string) => (text === '–' ? null : { calls: Number(text.split(' / ')[0]), triangles: Number(text.split(' / ')[1]) });
    const rows = new Map(
      [...readme.matchAll(/^\| `([^`]+)` \| (native|room|surround|diorama|screen) \| (\d+) \| (\d+) \| ([\d.]+) \|(.*)$/gm)].map((match) => [
        match[1],
        {
          kind: match[2],
          calls: Number(match[3]),
          triangles: Number(match[4]),
          textureMB: Number(match[5]),
          panels: match[6]!
            .split('|')
            .map((part) => part.trim())
            .filter(Boolean)
            .map(cell),
        },
      ]),
    );
    expect(rows.size).toBe(report.genres.length + report.screens.length);
    for (const genre of report.genres) {
      expect(rows.get(genre.id), genre.id).toEqual({ kind: genre.kind, ...peakOf(genre), panels: [null, 'result', 'share', 'comfort', 'keyboard'].map((panel) => panelPeak(genre, panel as Panel)) });
    }
    for (const screen of report.screens) expect(rows.get(screen.id), screen.id).toEqual({ kind: screen.kind, ...peakOf(screen), panels: [] });
  });

  it('shows the worst frame of each mode in docs/vr/README.md, recomputed from the samples', () => {
    const rows = new Map(
      [...guide.matchAll(/^\| (native|room|surround|diorama|lobby|feed) \| (\d+) \| `([^`]+)` \| (\d+) \| `([^`]+)` \|$/gm)].map((match) => [
        match[1],
        { calls: Number(match[2]), callsAt: match[3], triangles: Number(match[4]), trianglesAt: match[5] },
      ]),
    );
    const modes = [...new Set(report.genres.map((genre) => genre.kind)), ...report.screens.map((screen) => screen.id)];
    expect([...rows.keys()].sort()).toEqual([...modes].sort());
    for (const mode of modes) {
      const cases = [...report.genres, ...report.screens].filter((row) => (row.kind === 'screen' ? row.id : row.kind) === mode);
      const most = (field: 'calls' | 'triangles') => cases.reduce((best, row) => (peakOf(row)[field] > peakOf(best)[field] ? row : best));
      expect(rows.get(mode), mode).toEqual({ calls: peakOf(most('calls')).calls, callsAt: most('calls').id, triangles: peakOf(most('triangles')).triangles, trianglesAt: most('triangles').id });
    }
  });
});

describe('Quest 2 frame rate gate (evals/vr/quest2-fps.json)', () => {
  it('is the gate of the plan: median ≥ 72 and 5th percentile ≥ 65 FPS on every genre', () => {
    expect(FPS_GATE).toEqual({ median: 72, p5: 65 });
    if (quest.connected) expect(quest.gate).toEqual(FPS_GATE);
  });

  it('recomputes each genre from its per-second samples, and every genre holds the gate', () => {
    if (!quest.connected) {
      // Neměřeno: soubor to řekne i s důvodem a README nevydává emulátor za brýle.
      expect(quest.note).toBe(NOT_MEASURED);
      expect(quest.reason.length).toBeGreaterThan(0);
      expect(readme).toContain(NOT_MEASURED);
      return;
    }
    for (const genre of quest.genres) {
      const again = summarizeFps(genre.fps);
      expect({ median: genre.median, p5: genre.p5, samples: genre.samples }, genre.id).toEqual(again ?? { median: null, p5: null, samples: 0 });
    }
    // Prohlídka v brýlích hraje tytéž žánry jako rozpočet.
    if (quest.tour) expect(quest.genres.map((genre) => genre.id).sort()).toEqual(report.genres.map((genre) => genre.id).sort());
    expect(belowGate(quest.genres)).toEqual([]);
    for (const genre of quest.genres) expect(readme, genre.id).toMatch(new RegExp(`^\\| \`${genre.id}\` \\| ${String(genre.median)} \\| ${String(genre.p5)} \\|`, 'm'));
  });

  it('a genre that drops frames fails the gate even when its stored summary says otherwise', () => {
    const fps = [72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 72, 50];
    const lying = { id: 'runner.default', fps, median: 72, p5: 72, samples: 20 };
    const again = { ...lying, ...summarizeFps(fps)! };
    expect(again.p5).toBe(50);
    expect(belowGate([again])).toEqual(['runner.default']);
    expect(belowGate([{ id: again.id, median: null, p5: null, samples: 0 }])).toEqual(['runner.default']);
  });
});
