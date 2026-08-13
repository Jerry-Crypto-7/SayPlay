/**
 * Zmrazený double na produkční cestě — co všechno musí sedět na `MANIFEST.lock`.
 *
 * **Testuje se nad KOPIÍ korpusu v dočasném adresáři, nikdy nad `evals/frozen/`.**
 * Ten adresář je zamčený (`FROZEN` marker, tag, kotva) a test, který do něj sáhne
 * a spadne mezi zápisem a obnovou, by zmrazení rozbil trvale. Klient si cestu
 * počítá z `process.cwd()`, takže stačí podvrhnout pracovní adresář a načíst
 * modul znovu — produkční kód kvůli testu nic navíc nevystavuje.
 *
 * Nález brány nad `be72c8b`: hash se ověřoval jen u `responses/index.jsonl`.
 * `protocol.v1.json` a `prompts.v1.jsonl` se četly bez kontroly — a přitom
 * právě z nich vzniká zaznamenaný upstream požadavek, na který se AC T13 ptá.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const REQUEST = { model: 'test', system: 'system', user: 'user' };

const roots: string[] = [];

/** Kopie zmrazeného korpusu v dočasném kořeni. Volat PŘED podvržením `cwd()`. */
function corpusRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'worldsmith-frozen-'));
  cpSync(join(process.cwd(), 'evals', 'frozen'), join(root, 'evals', 'frozen'), { recursive: true });
  roots.push(root);
  return root;
}

async function clientAt(root: string) {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.resetModules();
  return import('../client');
}

function frozenFile(root: string, name: string): string {
  return join(root, 'evals', 'frozen', name);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('zmrazený korpus na produkční cestě', () => {
  it('netknutá kopie projde všemi třemi čteními', async () => {
    // Bez téhle polarity by testy níž prošly i klientovi, který odmítá vždycky.
    const root = corpusRoot();
    const client = await clientAt(root);

    const prompt = client.frozenPrompt('C01');
    expect(prompt.ok).toBe(true);
    expect(prompt.ok && prompt.value?.prompt.length).toBeGreaterThan(0);
    expect(client.frozenGrammar().ok).toBe(true);
    expect(client.emitWorld('C01', REQUEST).ok).toBe(true);
  });

  it('přepsaný text promptu se nedostane do zaznamenaného požadavku', async () => {
    const root = corpusRoot();
    const file = frozenFile(root, 'prompts.v1.jsonl');
    // Podvrh zůstává platné JSONL — jinak by ho chytil parser a hash by se
    // nikdy neptal. Chytit to musí manifest, ne náhoda.
    const tampered = readFileSync(file, 'utf8').replace('three keys', 'nine keys');
    expect(tampered).not.toBe(readFileSync(file, 'utf8'));
    writeFileSync(file, tampered, 'utf8');

    const client = await clientAt(root);
    const prompt = client.frozenPrompt('C01');
    expect(prompt.ok).toBe(false);
    expect(!prompt.ok && prompt.reason).toBe('MANIFEST_MISMATCH');
  });

  it('přepsaný protokol se nedostane do slovníku promptu', async () => {
    const root = corpusRoot();
    const file = frozenFile(root, 'protocol.v1.json');
    const protocol = JSON.parse(readFileSync(file, 'utf8')) as {
      grammar: { actions: string[] };
    };
    protocol.grammar.actions.push('executeArbitraryCode');
    writeFileSync(file, JSON.stringify(protocol, null, 2), 'utf8');

    const client = await clientAt(root);
    const grammar = client.frozenGrammar();
    expect(grammar.ok).toBe(false);
    expect(!grammar.ok && grammar.reason).toBe('MANIFEST_MISMATCH');
  });

  it('přepsaná odpověď se nedostane k volajícímu', async () => {
    const root = corpusRoot();
    const file = frozenFile(root, 'responses/index.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()}\n`.replace('"synthetic":true', '"synthetic":false'), 'utf8');

    const client = await clientAt(root);
    const emission = client.emitWorld('C01', REQUEST);
    expect(emission.ok).toBe(false);
  });

  it('chybějící korpus je výsledek, ne vyhozená výjimka', async () => {
    // Start z jiného pracovního adresáře je rozbité prostředí. Kdyby to letělo
    // jako výjimka, endpoint by na ní spadl do 500 — tedy do signálu, který má
    // vyhrazený pro spadlé potrubí, a T17 by to nerozeznal od vadného světa.
    const root = mkdtempSync(join(tmpdir(), 'worldsmith-empty-'));
    roots.push(root);
    const client = await clientAt(root);

    const prompt = client.frozenPrompt('C01');
    const grammar = client.frozenGrammar();
    const emission = client.emitWorld('C01', REQUEST);

    expect([prompt.ok, grammar.ok, emission.ok]).toEqual([false, false, false]);
    // Jiná příčina, jiný kód: nečitelný korpus se nesmí schovat za podvrh ani
    // naopak, protože jedno je vada stroje a druhé útok na zmrazení.
    for (const result of [prompt, grammar, emission])
      expect(!result.ok && result.reason).toBe('CORPUS_UNREADABLE');
  });

  it('neznámé id je prázdný výsledek, ne selhání korpusu', async () => {
    const root = corpusRoot();
    const client = await clientAt(root);

    const prompt = client.frozenPrompt('C99');
    expect(prompt.ok).toBe(true);
    expect(prompt.ok && prompt.value).toBeNull();
  });
});
