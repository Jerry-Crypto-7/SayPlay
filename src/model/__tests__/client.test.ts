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

import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Počítadlo skutečných čtení z disku.
 *
 * Musí to být obal nad `node:fs`, ne `vi.spyOn`: klient si `readFileSync`
 * importuje jmenovitě a vestavěné moduly jsou externalizované, takže špionáž
 * nad jmenným prostorem by se do něj nepromítla a test by byl zelený nad
 * čímkoli. Obal deleguje na skutečnou implementaci, takže zbytek souboru —
 * který `node:fs` používá taky — se chová beze změny.
 */
const disk = vi.hoisted(() => ({ reads: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      disk.reads.push(String(args[0]));
      return actual.readFileSync(...args);
    },
  };
});

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

/**
 * Přepíše zmrazený soubor **a dorovná mu hash v `MANIFEST.lock`**.
 *
 * Bez toho se za per-record kontroly v `emitWorld` vůbec nedá dostat: souborový
 * hash je zachytí dřív a test pak měří jen tu první vrstvu. Přesně na tom stálo
 * původní znění případu `RESPONSE_TAMPERED` — obě větve uvnitř `emitWorld`
 * (hlavička `synthetic` i per-record `sha256`) šlo smazat a sada zůstala zelená.
 *
 * Podvrh se tím **posiluje**, ne oslabuje: takhle vypadá útočník, který má
 * přístup i k manifestu, a jediné, co ho pak ještě zastaví, je per-record hash.
 */
function rewriteFrozen(root: string, name: string, next: string): void {
  writeFileSync(frozenFile(root, name), next, 'utf8');
  const manifestPath = frozenFile(root, 'MANIFEST.lock');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Record<string, string> };
  manifest.files[name] = createHash('sha256').update(Buffer.from(next.replace(/\r\n/g, '\n'), 'utf8')).digest('hex');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
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

  it('přepsaná odpověď se nedostane k volajícímu ani s dorovnaným manifestem', async () => {
    const root = corpusRoot();
    const original = readFileSync(frozenFile(root, 'responses/index.jsonl'), 'utf8');

    // **Vyměněné tělo uvnitř jinak nedotčeného souboru.** Manifest je dorovnaný,
    // takže tuhle vrstvu podvrh prošel — chytit to musí per-record `sha256`.
    const records = original.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const swapped = records.map((record) =>
      record.forPrompt === 'C01' && record.branch === 'create'
        ? { ...record, body: records.find((other) => other.forPrompt === 'C02')!.body }
        : record,
    );
    rewriteFrozen(root, 'responses/index.jsonl', `${swapped.map((r) => JSON.stringify(r)).join('\n')}\n`);

    const tamperedBody = await clientAt(root);
    const swappedResult = tamperedBody.emitWorld('C01', REQUEST);
    expect(swappedResult.ok).toBe(false);
    expect(!swappedResult.ok && swappedResult.reason).toBe('RESPONSE_TAMPERED');
    expect(!swappedResult.ok && swappedResult.detail).toContain('the record claims');
  });

  it('odpověď bez hlavičky `synthetic` se nevydá, i když jí hash sedí', async () => {
    // Hlavička není formalita: syntetický záznam neříká nic o kvalitě modelu.
    // Kdyby ji šlo shodit, dal by se offline běh vydávat za měření modelu.
    const root = corpusRoot();
    const original = readFileSync(frozenFile(root, 'responses/index.jsonl'), 'utf8');
    const records = original.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const stripped = records.map((record) =>
      record.forPrompt === 'C01' && record.branch === 'create' ? { ...record, synthetic: false } : record,
    );
    // Tělo se nemění, takže per-record `sha256` dál sedí — zbývá jen hlavička.
    rewriteFrozen(root, 'responses/index.jsonl', `${stripped.map((r) => JSON.stringify(r)).join('\n')}\n`);

    const client = await clientAt(root);
    const result = client.emitWorld('C01', REQUEST);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('RESPONSE_TAMPERED');
    expect(!result.ok && result.detail).toContain('synthetic: true');
  });

  it('souborový hash chytá podvrh, kterému se manifest nedorovnal', async () => {
    // Druhá vrstva zvlášť — jinak by se dvě nezávislé kontroly nedaly rozeznat.
    const root = corpusRoot();
    const file = frozenFile(root, 'responses/index.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"synthetic":true', '"synthetic":false'), 'utf8');

    const client = await clientAt(root);
    const emission = client.emitWorld('C01', REQUEST);
    expect(emission.ok).toBe(false);
    expect(!emission.ok && emission.reason).toBe('MANIFEST_MISMATCH');
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

  it('zmrazený protokol se čte jednou za proces, ne na každém požadavku', async () => {
    // **Hezký výsledek vypadá stejně s cachí i bez ní** — slovník je pokaždé
    // tentýž, ať se přečetl jednou nebo stokrát. Pozná to jedině počítadlo
    // čtení, a stojí to za měření: `frozenGrammar()` volají čtvery dveře, cena
    // je dva `readFileSync` plus sha256 nad 26 kB synchronně na smyčce
    // událostí, a platí se **před** stropem souběhu i na neplacené větvi.
    const root = corpusRoot();
    const client = await clientAt(root);
    const underRoot = (): string[] => disk.reads.filter((path) => path.startsWith(root));

    disk.reads.length = 0;
    expect(client.frozenGrammar().ok).toBe(true);
    expect(underRoot().length, 'první volání korpus vůbec nepřečetlo').toBeGreaterThan(0);

    disk.reads.length = 0;
    expect(client.frozenGrammar().ok).toBe(true);
    expect(underRoot(), 'druhé volání sáhlo znovu na disk').toEqual([]);

    // **Druhá půlka tvrzení, a bez ní by zelená znamenala jen „poprvé se to
    // přečetlo".** Cache musí umřít s modulem: klient si `FROZEN_DIR` počítá
    // z `process.cwd()` při importu, takže cache, která reload přežije, by
    // druhému kořeni vydala obsah prvního — a všechny podvrhové testy v tomhle
    // souboru by tím tiše přestaly měřit vlastní korpus.
    const other = corpusRoot();
    const reloaded = await clientAt(other);
    disk.reads.length = 0;
    expect(reloaded.frozenGrammar().ok).toBe(true);
    expect(
      disk.reads.filter((path) => path.startsWith(other)).length,
      'cache přežila reload modulu — druhý kořen četl z prvního',
    ).toBeGreaterThan(0);
  });

  it('neznámé id je prázdný výsledek, ne selhání korpusu', async () => {
    const root = corpusRoot();
    const client = await clientAt(root);

    const prompt = client.frozenPrompt('C99');
    expect(prompt.ok).toBe(true);
    expect(prompt.ok && prompt.value).toBeNull();
  });
});
