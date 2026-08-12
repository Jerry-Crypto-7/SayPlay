import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const frozenDir = join(repoRoot, 'evals', 'frozen');

type Verdict = 'FULFILLED' | 'ROBUST' | 'NO_FIT' | 'FAULT';

interface Response {
  synthetic: boolean;
  forPrompt: string;
  branch: 'create' | 'edit';
  baseWorld?: string;
  expectedVerdict: Verdict;
  sha256: string;
  body: unknown;
}

const responses = readFileSync(join(frozenDir, 'responses', 'index.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Response);

const prompts = readFileSync(join(frozenDir, 'prompts.v1.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as { id: string; kind: 'create' | 'edit' });

const protocol = JSON.parse(readFileSync(join(frozenDir, 'protocol.v1.json'), 'utf8')) as {
  syntheticResponses: { declaredDistribution: Record<string, number> };
};

describe('evals/frozen/responses — hlavička', () => {
  // Bez tohohle štítku by se syntetický záznam dal jednou vydat za důkaz
  // o kvalitě modelu. Phase 3 jím prokazuje POTRUBÍ, nic víc.
  it('každá odpověď je označená jako syntetická', () => {
    for (const r of responses) {
      expect(r.synthetic, `${r.forPrompt} není označená synthetic: true`).toBe(true);
    }
  });

  it('každá odpověď nese forPrompt a sha256', () => {
    for (const r of responses) {
      expect(r.forPrompt?.length, 'odpověď bez forPrompt').toBeGreaterThan(0);
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('sha256 sedí na tělo odpovědi', () => {
    for (const r of responses) {
      const actual = createHash('sha256').update(JSON.stringify(r.body), 'utf8').digest('hex');
      expect(actual, `${r.forPrompt}: sha256 neodpovídá tělu`).toBe(r.sha256);
    }
  });
});

describe('evals/frozen/responses — pokrytí zmrazené sady', () => {
  it('existuje odpověď pro KAŽDÝ zmrazený prompt a žádná navíc', () => {
    expect(responses.map((r) => r.forPrompt).sort()).toEqual(prompts.map((p) => p.id).sort());
  });

  it('branch odpovědi souhlasí s druhem promptu', () => {
    const kindById = new Map(prompts.map((p) => [p.id, p.kind]));
    for (const r of responses) {
      expect(r.branch, `${r.forPrompt}: branch neodpovídá druhu promptu`).toBe(kindById.get(r.forPrompt));
    }
  });

  // "Syntetické odpovědi pokrývají i patch větev, ne jen tvorbu světa."
  it('patch větev je pokrytá a její těla jsou RFC 6902 pole operací', () => {
    const edits = responses.filter((r) => r.branch === 'edit');
    expect(edits.length).toBeGreaterThan(0);
    for (const r of edits) {
      expect(Array.isArray(r.body), `${r.forPrompt}: patch není pole operací`).toBe(true);
      for (const op of r.body as Array<{ op: string; path: string }>) {
        expect(['add', 'remove', 'replace', 'move', 'copy', 'test']).toContain(op.op);
        expect(op.path.startsWith('/'), `${r.forPrompt}: cesta není JSON Pointer`).toBe(true);
      }
    }
  });

  it('každý editační záznam ukazuje na existující základní svět', () => {
    const createIds = new Set(prompts.filter((p) => p.kind === 'create').map((p) => p.id));
    for (const r of responses.filter((x) => x.branch === 'edit')) {
      expect(createIds.has(r.baseWorld ?? ''), `${r.forPrompt}: neznámý baseWorld`).toBe(true);
    }
  });
});

describe('evals/frozen/responses — deklarovaná distribuce', () => {
  // Kdyby všech 40 odpovědí kontrakt splnilo, byla by offline FULFILLED rate
  // 100 % konstrukcí a neprokázala by, že scorer umí verdikt PŘEKLOPIT.
  // T17 proto asertuje proti téhle distribuci, ne proti stu procent.
  it('skutečná distribuce verdiktů se PŘESNĚ rovná deklarované', () => {
    const actual: Record<string, number> = {};
    for (const r of responses) actual[r.expectedVerdict] = (actual[r.expectedVerdict] ?? 0) + 1;

    const declared = { ...protocol.syntheticResponses.declaredDistribution };
    delete declared.total;

    expect(actual).toEqual(declared);
  });

  it('každá ze čtyř tříd verdiktu je v sadě zastoupená', () => {
    const seen = new Set(responses.map((r) => r.expectedVerdict));
    expect([...seen].sort()).toEqual(['FAULT', 'FULFILLED', 'NO_FIT', 'ROBUST']);
  });

  // Selhání nasypaná do jediné třídy úprav by udělala z per-class reportu šum.
  it('nesplněné případy nejsou nacpané do jediné editační třídy', () => {
    const classById = new Map(
      readFileSync(join(frozenDir, 'prompts.v1.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { id: string; editClass?: string })
        .filter((p) => p.editClass)
        .map((p) => [p.id, p.editClass as string]),
    );
    const failedClasses = responses
      .filter((r) => r.branch === 'edit' && r.expectedVerdict !== 'FULFILLED')
      .map((r) => classById.get(r.forPrompt));
    expect(new Set(failedClasses).size).toBeGreaterThanOrEqual(4);
  });
});
