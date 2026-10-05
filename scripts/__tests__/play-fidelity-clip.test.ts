/**
 * Soudce slovesa z klipu (P37A T2). Sloveso je pohyb, takže soudce dostane
 * tři snímky v pořadí a zadání, které ho soudí podle změny mezi nimi. Test jde
 * skutečnou cestou procesem jako `upstream.test.ts` §7: `WORLDSMITH_CODEX_JS`
 * ukáže na skript, který zahraje `codex exec` – zapíše, co dostal, a odpověď
 * do souboru `-o`. Hlídá se, co by vypadalo správně a správně nebylo: klip
 * soudený jako jeden snímek, snímky přeházené, verdikt ze starého snímku.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLIP, contract, judge, judgeShot, type ChecklistEntry } from '../play-fidelity.mjs';

type Seen = { images: string[]; contract: string; cwd: string; files: string[]; content: string[] };
type Answer = { item: string; visible: boolean; why: string };

const CHECKLIST: ChecklistEntry[] = [
  { item: 'grandma cat', slot: 'hero', match: ['cat'] },
  { item: 'scarf', slot: 'role', match: ['scarf'] },
  { item: 'knit', slot: 'verb', controls: ['rhythm'] },
];

let dir: string;
let log: string;
let previous: string | undefined;

/** Falešný `codex exec`: zapíše obrázky a zadání do logu, `-o` dostane `answers`, nebo nic. */
function fakeCodex(answers: Answer[] | null): void {
  const file = join(dir, 'fake-codex.js');
  writeFileSync(file, [
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "const images = args.filter((arg) => arg.startsWith('--image=')).map((arg) => arg.slice('--image='.length));",
    "const contractPath = args.at(-1).replace(/^Read the file /, '').replace(/ and do exactly what it says\\.$/, '');",
    "const content = images.map((image) => fs.readFileSync(image, 'utf8'));",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ images, contract: fs.readFileSync(contractPath, 'utf8'), cwd: process.cwd(), files: fs.readdirSync(process.cwd()).sort(), content }) + String.fromCharCode(10));`,
    `const answers = ${JSON.stringify(answers)};`,
    "if (answers === null) process.exit(1);",
    "fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ items: answers }));",
  ].join('\n'));
  process.env.WORLDSMITH_CODEX_JS = file;
}

/** Snímky na disku; obsahem je jejich jméno, takže soudce pozná, který dostal, i pod neutrálním jménem. */
function shots(where: string, names: string[]): string[] {
  return names.map((name) => {
    writeFileSync(join(where, name), name);
    return join(where, name);
  });
}

const seen = (): Seen[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Seen) : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'p37a-clip-'));
  log = join(dir, 'calls.jsonl');
  previous = process.env.WORLDSMITH_CODEX_JS;
});

afterEach(() => {
  if (previous === undefined) delete process.env.WORLDSMITH_CODEX_JS;
  else process.env.WORLDSMITH_CODEX_JS = previous;
});

describe('the clip judge', () => {
  it('sends the three frames in order and asks for the verb from what moves between them', () => {
    fakeCodex([
      { item: 'Knit', visible: true, why: 'needles move between frames' },
      { item: 'grandma cat', visible: false, why: 'grey blob' },
      { item: 'sofa', visible: true, why: 'not on the list' },
    ]);
    const names = ['u01-draft-clip-1.png', 'u01-draft-clip-2.png', 'u01-draft-clip-3.png'];
    const { verdict } = judgeShot(shots(dir, names), CHECKLIST, dir, 'u01-draft-clip');

    const [call] = seen();
    expect(call.content).toEqual(names);
    expect(call.contract).toContain(`judging ${CLIP.frames} frames of a 3D game while it is being played, in order, taken 0.5 s apart`);
    expect(call.contract).toContain('judge it from what moves or changes between the frames');
    expect(call.contract).toContain('- "knit" (action)');
    // Odpověď se páruje bez ohledu na velikost písmen; chybějící položka a cizí položka nejsou „viděno“.
    expect(verdict).toEqual({ 'grandma cat': false, scarf: false, knit: true });
  });

  it('keeps the one-screenshot contract word for word, so older runs stay comparable', () => {
    fakeCodex([]);
    judgeShot(shots(dir, ['u01-draft-scene.png']), CHECKLIST, dir, 'u01-draft');
    const [call] = seen();
    expect(call.images).toHaveLength(1);
    expect(call.contract).toBe(contract(CHECKLIST));
    expect(call.contract.split('\n')[0]).toBe('You are judging one screenshot of a 3D game scene. You know nothing else about the game.');
    expect(call.contract).toContain('- an action counts only if the picture shows that this is what the game is about (for "shoot": a gun, a crosshair or projectiles);');
    expect(call.contract).not.toContain('frames');
  });

  it('fails loudly when the judge writes no answer', () => {
    fakeCodex(null);
    expect(() => judgeShot(shots(dir, ['x.png']), CHECKLIST, dir, 'u02-draft')).toThrow(/codex wrote no answer/);
    // Ani po selhání nezůstane dočasný adresář soudce viset.
    expect(existsSync(seen()[0].cwd)).toBe(false);
  });

  it('runs blind: an empty folder with neutral frame names, never the run folder with the spec', () => {
    // Ve složce běhu leží spec hry i se slovesem – soudce ji nesmí vidět ani jménem souboru.
    writeFileSync(join(dir, 'u01.json'), JSON.stringify({ id: 'u01', draft: { spec: { heroAction: 'knit', genre: 'rhythm' } } }));
    fakeCodex([{ item: 'knit', visible: true, why: 'needles' }]);
    judgeShot(shots(dir, ['u01-draft-clip-1.png', 'u01-draft-clip-2.png', 'u01-draft-clip-3.png']), CHECKLIST, dir, 'u01-draft-clip');

    const [call] = seen();
    expect(call.cwd).not.toBe(dir);
    expect(call.files).toEqual(['contract.md', 'frame-1.png', 'frame-2.png', 'frame-3.png', 'schema.json']);
    expect(call.images.map((image) => image.split(/[\\/]/).at(-1))).toEqual(['frame-1.png', 'frame-2.png', 'frame-3.png']);
    expect(call.contract).not.toMatch(/u01|draft|rhythm/);
    expect(existsSync(call.cwd)).toBe(false);
    // Zadání a odpověď zůstanou ve složce běhu jako záznam.
    expect(readFileSync(join(dir, 'u01-draft-clip-judge.md'), 'utf8')).toBe(call.contract);
    expect(JSON.parse(readFileSync(join(dir, 'u01-draft-clip-judge.out'), 'utf8')).items[0].item).toBe('knit');
  });
});

describe('judge --clip over a run', () => {
  const writeResult = (runDir: string, id: string, extra: Record<string, unknown>) =>
    writeFileSync(join(runDir, `${id}.json`), JSON.stringify({ id, checklist: CHECKLIST, draft: { spec: {} }, ai: null, ...extra }));

  it('re-judges a verdict that saw one screenshot, then leaves the clip verdict alone', () => {
    const runDir = join(dir, 'run');
    mkdirSync(runDir);
    const frames = ['u01-draft-clip-1.png', 'u01-draft-clip-2.png', 'u01-draft-clip-3.png'];
    shots(runDir, frames);
    writeResult(runDir, 'u01', { draft: { spec: {}, clip: { robot: true, frames } }, judge: { draft: { 'grandma cat': true, scarf: true, knit: false } } });
    fakeCodex([{ item: 'knit', visible: true, why: 'needles' }]);

    judge({ run: runDir, clip: true });
    judge({ run: runDir, clip: true });

    expect(seen()).toHaveLength(1);
    expect(seen()[0].content).toEqual(frames);
    const result = JSON.parse(readFileSync(join(runDir, 'u01.json'), 'utf8'));
    expect(result.judge.draft).toEqual({ 'grandma cat': false, scarf: false, knit: true });
    expect(result.judgeFrames.draft).toBe(3);
  });

  it('refuses a run without clips instead of judging the single screenshot', () => {
    const runDir = join(dir, 'run');
    mkdirSync(runDir);
    writeResult(runDir, 'u01', {});
    fakeCodex([]);
    expect(() => judge({ run: runDir, clip: true })).toThrow(/u01 draft: no clip/);
    expect(seen()).toEqual([]);
  });

  it('judges only the ids passed with --only', () => {
    const runDir = join(dir, 'run');
    mkdirSync(runDir);
    for (const id of ['u01', 'u02']) {
      const frames = [`${id}-a.png`, `${id}-b.png`, `${id}-c.png`];
      shots(runDir, frames);
      writeResult(runDir, id, { draft: { spec: {}, clip: { robot: true, frames } } });
    }
    fakeCodex([]);
    judge({ run: runDir, clip: true, only: 'u02' });
    expect(seen().map((call) => call.content[0])).toEqual(['u02-a.png']);
  });
});
