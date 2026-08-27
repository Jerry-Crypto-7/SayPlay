/**
 * Zmrazená sada 200 vět (P11 T3) se po zamčení nesmí hnout.
 *
 * Dvě věci se tu dokazují a jsou to různé věci:
 *
 *   1. **Strom sedí se zámkem.** Kdyby se kterýkoli prompt změnil, hash se
 *      rozejde a tenhle soubor zčervená.
 *   2. **Ten zámek doopravdy kouše.** Bod 1 sám o sobě je zelený i tehdy, když
 *      by ověřování nedělalo nic — proto se v dočasném adresáři korpus vědomě
 *      rozbije a čeká se červená. Bez tohohle je bod 1 dekorace, což je přesně
 *      ta vada, kterou `evals-frozen-v1` nesl rok: testy filtrovaly tak, že
 *      vlastní artefakt nikdy neprověřily.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ALL_KINDS,
  EXPECTED_DISTRIBUTION,
  EXPECTED_TOTAL,
  HOSTILE_BUCKETS,
  NON_DISCRIMINATING_KINDS,
  SCORE_AS_VALUES,
  computeFileHashes,
  readCorpus,
  readManifest,
  validateCorpus,
  verifyAgainstManifest,
  type Corpus,
} from '../corpus-v3/lock.mjs';

const corpusDir = fileURLToPath(new URL('../corpus-v3', import.meta.url));

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

/** Kopie zmrazeného adresáře, kterou smíme rozbít. Originál se nikdy nedotkne. */
function scratchCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-v3-'));
  scratchDirs.push(dir);
  cpSync(corpusDir, dir, { recursive: true });
  return dir;
}

function loadScratch(dir: string): Corpus {
  return JSON.parse(readFileSync(join(dir, 'prompts.json'), 'utf8')) as Corpus;
}

function saveScratch(dir: string, doc: Corpus): void {
  writeFileSync(join(dir, 'prompts.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

describe('corpus-v3 je zmrazený', () => {
  it('strom sedí se zamčeným manifestem', () => {
    expect(verifyAgainstManifest(corpusDir)).toEqual([]);
  });

  it('manifest kryje každý soubor v adresáři kromě sebe sama', () => {
    const manifest = readManifest(corpusDir);
    expect(Object.keys(manifest.files).sort()).toEqual(Object.keys(computeFileHashes(corpusDir)).sort());
    expect(Object.keys(manifest.files)).not.toContain('MANIFEST.lock');
    expect(Object.keys(manifest.files)).toContain('prompts.json');
    expect(manifest.algorithm).toBe('sha256');
  });

  it('nese 200 vět v předepsaném rozdělení', () => {
    const corpus = readCorpus(corpusDir);
    expect(corpus.prompts).toHaveLength(EXPECTED_TOTAL);
    expect(EXPECTED_TOTAL).toBe(200);

    const byBucket: Record<string, number> = {};
    for (const p of corpus.prompts) byBucket[p.bucket] = (byBucket[p.bucket] ?? 0) + 1;
    expect(byBucket).toEqual(EXPECTED_DISTRIBUTION);
  });

  it('nepřátelská podmnožina pro T20 má 70 vět', () => {
    const corpus = readCorpus(corpusDir);
    const hostile = corpus.prompts.filter((p) => HOSTILE_BUCKETS.includes(p.bucket));
    expect(hostile).toHaveLength(70);
  });

  it('každý záznam nese id, text, contract a scoreAs', () => {
    for (const p of readCorpus(corpusDir).prompts) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.text).toBe('string');
      expect(SCORE_AS_VALUES).toContain(p.scoreAs);
      expect(p.contract.observations.length).toBeGreaterThan(0);
    }
  });

  it('kontrakt mluví jen o pozorovatelných faktech, nikdy o tvaru výstupu', () => {
    const corpus = readCorpus(corpusDir);
    for (const p of corpus.prompts) {
      for (const o of p.contract.observations) {
        expect(ALL_KINDS.has(o.kind), `${o.rid} má druh ${o.kind}`).toBe(true);
        // Tvarové požadavky z evals/frozen (requiresAction, requiresEvent,
        // requiresCounter, minEntitiesByRole) sem nesmějí proniknout ani omylem.
        expect(o.kind).not.toMatch(/^requires/);
      }
      // Slovník v hlavičce a slovník v zámku musí být tentýž seznam.
      expect(Object.keys(corpus.observationKinds).sort()).toEqual([...ALL_KINDS].sort());
    }
  });

  it('žádný FULFILLABLE kontrakt není vakuózní', () => {
    for (const p of readCorpus(corpusDir).prompts) {
      if (p.scoreAs !== 'FULFILLABLE') continue;
      const discriminating = p.contract.observations.filter((o) => !NON_DISCRIMINATING_KINDS.has(o.kind));
      expect(discriminating.length, `${p.id} nemá rozlišující observaci`).toBeGreaterThan(0);
    }
  });

  it('všechno mimo FULFILLABLE má zapsaný důvod', () => {
    for (const p of readCorpus(corpusDir).prompts) {
      if (p.scoreAs === 'FULFILLABLE') continue;
      expect(p.scoreAsReason?.trim(), `${p.id} nemá scoreAsReason`).toBeTruthy();
    }
  });

  it('korpus, jak je na disku, projde vlastní validací', () => {
    expect(validateCorpus(readCorpus(corpusDir))).toEqual([]);
  });
});

describe('zámek doopravdy kouše', () => {
  it('změna jediného znaku v jediném promptu shodí ověření', () => {
    const dir = scratchCopy();
    expect(verifyAgainstManifest(dir)).toEqual([]);

    const doc = loadScratch(dir);
    doc.prompts[0] = { ...doc.prompts[0], text: `${doc.prompts[0].text}.` };
    saveScratch(dir, doc);

    const drift = verifyAgainstManifest(dir);
    expect(drift).not.toEqual([]);
    expect(drift.join(' ')).toContain('prompts.json');
  });

  it('přidaný soubor do zmrazeného adresáře shodí ověření', () => {
    const dir = scratchCopy();
    writeFileSync(join(dir, 'podvrzeny.json'), '{}\n', 'utf8');
    expect(verifyAgainstManifest(dir).join(' ')).toContain('podvrzeny.json');
  });

  it('smazaný soubor ze zmrazeného adresáře shodí ověření', () => {
    const dir = scratchCopy();
    rmSync(join(dir, 'lock.d.mts'));
    expect(verifyAgainstManifest(dir).join(' ')).toContain('lock.d.mts');
  });
});

describe('validace odmítá vadný korpus', () => {
  it('odmítne jiný než předepsaný počet vět', () => {
    const doc = readCorpus(corpusDir);
    const short = { ...doc, prompts: doc.prompts.slice(0, 199) };
    expect(validateCorpus(short).join(' ')).toContain('199');
  });

  it('odmítne porušené rozdělení košů', () => {
    const doc = readCorpus(corpusDir);
    const prompts = doc.prompts.map((p, i) => (i === 0 ? { ...p, bucket: 'vague' } : p));
    expect(validateCorpus({ ...doc, prompts }).join(' ')).toContain('in_category');
  });

  it('odmítne vakuózní FULFILLABLE kontrakt', () => {
    const doc = readCorpus(corpusDir);
    const prompts = doc.prompts.map((p, i) =>
      i === 0
        ? { ...p, contract: { ...p.contract, observations: [{ rid: `${p.id}.o1`, kind: 'sceneNotEmpty', says: 'je vidět' }] } }
        : p,
    );
    expect(validateCorpus({ ...doc, prompts }).join(' ')).toContain('vakuózní');
  });

  it('odmítne ROBUST_ONLY bez důvodu', () => {
    const doc = readCorpus(corpusDir);
    const target = doc.prompts.findIndex((p) => p.scoreAs === 'ROBUST_ONLY');
    const prompts = doc.prompts.map((p, i) => (i === target ? { ...p, scoreAsReason: '   ' } : p));
    expect(validateCorpus({ ...doc, prompts }).join(' ')).toContain('scoreAsReason');
  });

  it('odmítne observaci s druhem mimo slovník', () => {
    const doc = readCorpus(corpusDir);
    const prompts = doc.prompts.map((p, i) =>
      i === 0
        ? { ...p, contract: { ...p.contract, observations: [{ ...p.contract.observations[0], kind: 'requiresAction' }] } }
        : p,
    );
    expect(validateCorpus({ ...doc, prompts }).join(' ')).toContain('mimo slovník');
  });

  it('odmítne duplicitní id', () => {
    const doc = readCorpus(corpusDir);
    const prompts = doc.prompts.map((p, i) => (i === 1 ? { ...p, id: doc.prompts[0].id } : p));
    expect(validateCorpus({ ...doc, prompts }).join(' ')).toContain('duplicitní id');
  });

  it('odmítne druh, který vyžaduje value, bez value', () => {
    const doc = readCorpus(corpusDir);
    const prompts = doc.prompts.map((p, i) =>
      i === 0
        ? {
            ...p,
            contract: {
              ...p.contract,
              observations: [{ rid: `${p.id}.o1`, kind: 'minPickables', says: 'aspoň něco jde vzít' }],
            },
          }
        : p,
    );
    expect(validateCorpus({ ...doc, prompts }).join(' ')).toContain('vyžaduje value');
  });
});
