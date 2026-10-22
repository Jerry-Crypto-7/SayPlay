/**
 * Sada věrnosti (P26 T1): report nese všechny tři metriky a věta bez
 * kontrolního seznamu neprojde. Číslo, které v reportu chybí, se na bráně
 * přečte jako nula nebo jako „prošlo“ – obojí vypadá věrohodně.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { draftGameSpec } from '@/play/draft';

import { type ChecklistEntry, checkCorpus, offlineChain, readerDecision, readerDraft, specFidelity, summarize } from '../play-fidelity.mjs';

const CORPUS = JSON.parse(readFileSync(join(process.cwd(), 'evals', 'play', 'fidelity', 'corpus.json'), 'utf8'));

const checklist: ChecklistEntry[] = [
  { item: 'zombie', slot: 'role', match: ['zombie'] },
  { item: 'mall', slot: 'setting', match: ['mall'] },
  { item: 'shoot', slot: 'verb', controls: ['shooter'] },
];

const spec = (control: string, enemyLabel: string, setting: string) => ({
  control,
  roles: [
    { id: 'hero', kind: 'player', label: 'Survivor', count: 1 },
    { id: 'enemy', kind: 'target', label: enemyLabel, count: 3 },
  ],
  mechanics: [],
  theme: { setting, mood: 'tense' },
});

describe('fidelity corpus', () => {
  it('the committed corpus holds 30 valid sentences', () => {
    expect(checkCorpus(CORPUS)).toEqual([]);
    expect(CORPUS.sentences).toHaveLength(30);
  });

  // P28D T1: porotcovská sada je zamčená před změnami; jiný hash = přeučení na měřicí sadě.
  it('the judge-10 set is valid and unchanged since its freeze', () => {
    const text = readFileSync(join(process.cwd(), 'evals', 'play', 'fidelity', 'judge-10.json'), 'utf8').replace(/\r\n/g, '\n');
    expect(checkCorpus(JSON.parse(text))).toEqual([]);
    expect(JSON.parse(text).sentences).toHaveLength(10);
    expect(createHash('sha256').update(text).digest('hex')).toBe('fc108201c388715dc989de94eed7b8263dc18c5276ab49baf2b6f7cf11e71990');
  });

  it('a sentence without checklist items does not pass', () => {
    const issues = checkCorpus({ sentences: [{ id: 'x1', text: 'a game', checklist: [] }] });
    expect(issues.some((issue: string) => issue.includes('nouns'))).toBe(true);
    expect(issues.some((issue: string) => issue.includes('verbs'))).toBe(true);
  });
});

describe('specFidelity', () => {
  it('counts only what the control reads', () => {
    // Střelnice čte popisek nepřítele a od P26 T11 i prostředí (sada `mall`).
    const shooter = specFidelity(spec('shooter', 'Zombie', 'abandoned mall'), checklist);
    expect(shooter.items.map((item: { item: string; inSpec: boolean; read: boolean }) => [item.item, item.inSpec, item.read])).toEqual([
      ['zombie', true, true],
      ['mall', true, true],
      ['shoot', true, true],
    ]);
    // Mřížka čte všechno, ale sloveso „shoot“ neumí.
    expect(specFidelity(spec('tap_go', 'Zombies', 'abandoned mall'), checklist).score).toBeCloseTo(2 / 3, 3);
  });

  it('counts an arcade setting only when a scene set shows it', () => {
    const place = [{ item: 'nowhere', slot: 'setting' as const, match: ['nowhere'] }];
    const unknown = spec('shooter', 'Zombie', 'the land of nowhere');
    expect(specFidelity(unknown, place).items[0]).toMatchObject({ inSpec: true, read: false });
    expect(specFidelity({ ...unknown, theme: { ...unknown.theme, look: 'desert' } }, place).items[0]).toMatchObject({ inSpec: true, read: true });
    // Od P27A T3–T4 kreslí sadu každé ovládání arkády, i závod a souboj.
    for (const control of ['steer', 'duel']) expect(specFidelity(spec(control, 'Zombie', 'abandoned mall'), checklist).items[1]).toMatchObject({ inSpec: true, read: true });
  });
});

describe('summarize', () => {
  it('reports upgrade success, spec fidelity and recognizability', () => {
    const results = [
      {
        checklist,
        draft: { ms: 200, spec: spec('shooter', 'Target', 'green field') },
        upgrade: { status: 'ready', ms: 45_000 },
        ai: { spec: spec('shooter', 'Zombie', 'mall') },
        judge: { draft: { zombie: false, mall: false, shoot: true }, ai: { zombie: true, mall: false, shoot: true } },
      },
      {
        checklist,
        draft: { ms: 300, spec: spec('shooter', 'Target', 'green field') },
        upgrade: { status: 'draft-final', reason: 'MALFORMED', ms: 41_000 },
        ai: null,
        judge: { draft: { zombie: false, mall: false, shoot: false } },
      },
    ];
    const metrics = summarize(results);
    expect(metrics.upgradeSuccess).toEqual({ ok: 1, of: 2, failures: { MALFORMED: 1 } });
    expect(metrics.specFidelity.final).toBeCloseTo((3 / 3 + 1 / 3) / 2, 3);
    expect(metrics.specFidelity.ai).toBeCloseTo(3 / 3, 3);
    expect(metrics.recognizable.final.items).toEqual({ hit: 2, of: 6 });
    expect(metrics.recognizable.final.setting).toEqual({ hit: 0, of: 2 });
    expect(metrics.recognizable.final.judged).toBe(2);
    expect(metrics.timing.upgradeSecondsP50).toBe(45);
  });
});

// P29B T3: čtečka proti klíčovým slovům. Rozhodovací číslo zapíná produkční cestu,
// takže práh a směr porovnání se pinují, ne odhadují.
describe('reader gate', () => {
  it('turns the reader on only with +0.10 judge-10 read and p95 within 1500 ms', () => {
    expect(readerDecision({ reader: 0.56, regex: 0.459, p95Ms: 1500 })).toBe('draft');
    expect(readerDecision({ reader: 0.55, regex: 0.459, p95Ms: 900 })).toBe('off');
    expect(readerDecision({ reader: 0.9, regex: 0.459, p95Ms: 1501 })).toBe('off');
    expect(readerDecision({ reader: 0.559, regex: 0.459, p95Ms: 100 })).toBe('draft');
  });

  it('drafts on the control the reading picked and falls back to keywords without one', () => {
    const text = 'a corgi dodges traffic in a neon city';
    const reading = { control: 'steer' as const, verbs: [], hero: 'corgi', roles: [], setting: 'neon city', mood: null, numbers: { seconds: null, counts: [] }, genre: null, foe: null, item: null, world: null, title: null };
    expect(readerDraft(text, reading).control).toBe('steer');
    expect(readerDraft(text, null)).toEqual(draftGameSpec(text));
  });

  it('offlineChain measures the spec the given draft builds', () => {
    const [sentence] = CORPUS.sentences;
    const chain = offlineChain([sentence], () => readerDraft(sentence.text, { control: 'rhythm', verbs: [], hero: null, roles: [], setting: null, mood: null, numbers: { seconds: null, counts: [] }, genre: null, foe: null, item: null, world: null, title: null }));
    expect(chain.sentences[0].control).toBe('rhythm');
  });
});
