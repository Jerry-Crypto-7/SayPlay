/**
 * `readme-claims.mjs`: číslo bez zdroje a mrtvý odkaz shodí kontrolu (P79 T1).
 * Chování nad skutečným stromem měří `submission-check-gate.test.ts` (kontrola 9).
 */

import { describe, expect, it } from 'vitest';

import {
  claimRowProblems,
  documentProblems,
  headingSlugs,
  measuredNumbers,
  parseClaims,
} from '../readme-claims.mjs';

const keys = (markdown: string) => measuredNumbers(markdown).map(({ key }) => key);

describe('measuredNumbers: co je naměřené číslo', () => {
  it('bere zlomky, „of“, rozsahy, desetinná čísla, jednotky a celá čísla od sta', () => {
    expect(keys('Playable 200 / 200, judge 11 of 12, 3 out of 4, 45–60 FPS, 1.8 s, +139 ms, 0 USD, 7 %, 1787 models.'))
      .toEqual(['200/200', '11/12', '3/4', '45–60', '1.8', '139', '0', '7', '1787']);
  });

  it('nebere jména, roky, data, verze ani malá čísla bez jednotky', () => {
    expect(keys('P74 on 7 November 2026 (2026-11-07), gpt-6-astra, TRELLIS.2-4B, 3D, iPhone 15, PR #113 at 12:00, 4 seeds, 60 Hz.'))
      .toEqual([]);
  });

  it('nečte kód, komentáře ani cíle odkazů', () => {
    const markdown = [
      'Run `next start -p 3210` and read [the run](evals/p74/run-1234.json).',
      '<!-- 999 hidden -->',
      '```',
      'median 4.2 s',
      '```',
      'See https://example.io/v/1234 for more.',
    ].join('\n');
    expect(keys(markdown)).toEqual([]);
  });

  it('hlásí řádek, na kterém číslo stojí', () => {
    expect(measuredNumbers('# Title\n\nmedian 1.8 s')).toEqual([{ key: '1.8', text: '1.8 s', line: 3 }]);
  });
});

const CLAIMS = [
  '| ID | Claim | Numbers | Date | File | Evidence |',
  '|---|---|---|---|---|---|',
  '| C1 | Quick version | 200/200, 1.8 s | 2026-11-07 | `evals/run.json` | `"playable": 200` |',
  '| C2 | Scenes | 11 of 12 | 2026-11-07 | `evals/judge.md` | `11 / 12` |',
].join('\n');

const FILES: Record<string, string> = {
  'evals/run.json': '{ "playable": 200, "medianMs": 1800 }',
  'evals/judge.md': '# Judge\n\nNew wins 11 / 12.\n',
  'README.md': '# Sayplay\n\n## Measured results\n',
  'docs/play': '',
};

const view = {
  isPublic: (path: string) => path in FILES,
  read: (path: string) => FILES[path] ?? '',
};

function readmeProblems(text: string): string[] {
  const claimKeys = new Set(parseClaims(CLAIMS).flatMap((claim) => [...claim.keys]));
  return documentProblems({ path: 'README.md', text, claimKeys, ...view });
}

describe('documentProblems: číslo bez zdroje a mrtvý odkaz', () => {
  it('projde, když každé číslo stojí v tabulce a každý odkaz vede do repa', () => {
    expect(readmeProblems('200 / 200 playable in a median 1.8 s ([run](evals/run.json)), 11 of 12 ([judge](evals/judge.md#judge)), [docs](docs/play/), [up](#measured-results).'))
      .toEqual([]);
  });

  it('číslo bez řádku v claims.md shodí kontrolu', () => {
    expect(readmeProblems('# Sayplay\n\nRobot wins 199 / 200.')).toEqual([
      'README.md:3 číslo „199 / 200“ nemá řádek v evals/play/p79/claims.md',
    ]);
  });

  it('odkaz na soubor, který v repu není, shodí kontrolu', () => {
    expect(readmeProblems('See [plan](plans/P79.md).')).toEqual([
      'README.md:1 odkaz „plans/P79.md“ vede na plans/P79.md, který ve veřejném repu není',
    ]);
  });

  it('kotva na nadpis, který neexistuje, shodí kontrolu', () => {
    expect(readmeProblems('See [issues](#known-issues).')).toEqual([
      'README.md:1 odkaz „#known-issues“: v README.md není nadpis #known-issues',
    ]);
  });

  it('obrázek přes HTML se kontroluje stejně', () => {
    expect(readmeProblems('<img src="docs/README-assets/missing.png" alt="">')).toHaveLength(1);
  });
});

describe('claimRowProblems: každý řádek má datum, soubor v repu a doslovný důkaz', () => {
  it('projde nad úplnou tabulkou', () => {
    expect(claimRowProblems(parseClaims(CLAIMS), view)).toEqual([]);
  });

  it('tvrzení bez souboru je nález', () => {
    const table = CLAIMS.replace('`evals/judge.md`', '');
    expect(claimRowProblems(parseClaims(table), view)).toEqual([
      'evals/play/p79/claims.md:4 C2: tvrzení bez souboru – vypadne, nebo dostane zdroj',
    ]);
  });

  it('soubor mimo veřejné repo je nález', () => {
    const table = CLAIMS.replace('`evals/judge.md`', '`plans/konkurence/x.md`');
    expect(claimRowProblems(parseClaims(table), view)[0]).toContain('plans/konkurence/x.md ve veřejném repu není');
  });

  it('důkaz, který v souboru není, je nález', () => {
    const table = CLAIMS.replace('`"playable": 200`', '`"playable": 201`');
    expect(claimRowProblems(parseClaims(table), view)).toEqual([
      'evals/play/p79/claims.md:3 C1: „"playable": 201“ v evals/run.json není',
    ]);
  });

  it('svislítko v důkazu zapsané jako \\| je část důkazu, ne hranice buňky', () => {
    const table = CLAIMS.replace('`11 / 12`', '`Judge \\| 11 / 12`');
    const files: Record<string, string> = { ...FILES, 'evals/judge.md': '| Judge | 11 / 12 |' };
    const claims = parseClaims(table);
    expect(claims[1].evidence).toEqual(['Judge | 11 / 12']);
    expect(claimRowProblems(claims, { ...view, read: (path: string) => files[path] ?? '' })).toEqual([]);
  });

  it('řádek bez data je nález', () => {
    const table = CLAIMS.replace('| 2026-11-07 | `evals/run.json`', '| 7 Nov | `evals/run.json`');
    expect(claimRowProblems(parseClaims(table), view)[0]).toContain('chybí datum');
  });

  it('soubor bez tabulky je nález, ne prázdná zelená', () => {
    expect(claimRowProblems(parseClaims('# Claims\n\nNothing yet.'), view)[0]).toContain('nemá tabulku');
  });
});

describe('headingSlugs: kotvy jako na GitHubu', () => {
  it('malá písmena, mezery na pomlčky, bez interpunkce, opakovaný nadpis s -1', () => {
    expect([...headingSlugs('# Try it in 30 seconds\n## Why – and how?\n## Notes\n## Notes')])
      .toEqual(['try-it-in-30-seconds', 'why--and-how', 'notes', 'notes-1']);
  });
});
