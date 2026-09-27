/**
 * SFT sada P30C T3: co vypadá jako dobrá data a přitom nesmí projít.
 *
 * - Každý řádek pochází z lokálního gpt-oss-20b (`source`, model, loopback),
 *   nikdy z astry ani jiného modelu OpenAI – podmínky předplatného.
 * - Trénovací věta se nepotká s korpusem věrnosti, `judge-10`, sadou poptávek
 *   ani testovací sadou P30A (normalizovaně); `test-200.json` jen když existuje.
 * - Věty vznikly ze šablon (`sentences.mjs`), ne jiným modelem: soubor je
 *   přesně to, co generátor vydá.
 * - Systémová zpráva je produkční kompaktní prompt té verze, kterou řádek hlásí.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

// @ts-expect-error – holý ES modul generátoru bez deklarací
import { generateSentences, sentencesJsonl } from '../sentences.mjs';

const ROOT = resolve(__dirname, '..', '..', '..');
const TRAIN = join(ROOT, 'evals', 'play', 'train');

interface Sentence {
  readonly id: string;
  readonly text: string;
  readonly checklist: readonly { readonly slot: string }[];
}
interface SftRow {
  readonly id: string;
  readonly source: string;
  readonly model: string;
  readonly endpoint: string;
  readonly seed: number;
  readonly promptVersion: string;
  readonly score: { readonly items: number; readonly read: number; readonly drawn: number };
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

const jsonl = <T>(file: string): T[] =>
  readFileSync(join(TRAIN, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T);

// Vlastní normalizace, nezávislá na generátoru: jeho chyba se tu nesmí schovat.
const norm = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function heldOut(): Map<string, string> {
  const sets = ['evals/play/fidelity/corpus.json', 'evals/play/fidelity/judge-10.json', 'evals/play/demand/corpus.json', 'evals/play/p30/test-200.json'];
  const texts = new Map<string, string>();
  for (const file of sets) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    const data = JSON.parse(readFileSync(path, 'utf8')) as { text: string }[] | { sentences: { text: string }[] };
    for (const entry of Array.isArray(data) ? data : data.sentences) texts.set(norm(entry.text), file);
  }
  return texts;
}

const sentences = jsonl<Sentence>('sentences.jsonl');
const rows = jsonl<SftRow>('sft.jsonl');
const held = heldOut();

describe('training sentences', () => {
  it('are at least 300, unique, and exactly what the template generator emits', () => {
    expect(sentences.length).toBeGreaterThanOrEqual(300);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(sentences.length);
    expect(new Set(sentences.map((s) => norm(s.text))).size).toBe(sentences.length);
    expect(readFileSync(join(TRAIN, 'sentences.jsonl'), 'utf8')).toBe(sentencesJsonl(generateSentences()));
  });

  it('carry a fidelity checklist of 2–4 nouns and exactly one verb', () => {
    for (const sentence of sentences) {
      const verbs = sentence.checklist.filter((entry) => entry.slot === 'verb').length;
      const nouns = sentence.checklist.length - verbs;
      expect(verbs, sentence.id).toBe(1);
      expect(nouns >= 2 && nouns <= 4, `${sentence.id}: ${String(nouns)} nouns`).toBe(true);
    }
  });

  it('never meet the fidelity corpus, judge-10, the demand set or the P30A test set', () => {
    // 200 poptávek + 10 nepřátelských vět korpusu + judge-10; 20 vět korpusu je z poptávek.
    expect(held.size).toBeGreaterThanOrEqual(220);
    const leaked = sentences.filter((s) => held.has(norm(s.text))).map((s) => `${s.id} = ${String(held.get(norm(s.text)))}`);
    expect(leaked).toEqual([]);
  });
});

describe('SFT set', () => {
  const byId = new Map(sentences.map((s) => [s.id, s]));

  it('is not empty and has one row per sentence at most', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it('comes only from the local gpt-oss-20b, never from astra or another OpenAI model', () => {
    const foreign = rows.filter(
      (row) => row.source !== 'gpt-oss-20b-local' || !/gpt-oss-20b/i.test(row.model) || !/^llamacpp:http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(row.endpoint),
    );
    expect(foreign.map((row) => `${row.id} ${row.source} ${row.model} ${row.endpoint}`)).toEqual([]);
  });

  it('trains only on training sentences, none of them held out', () => {
    for (const row of rows) {
      const sentence = byId.get(row.id);
      expect(sentence, row.id).toBeDefined();
      const user = row.messages.find((message) => message.role === 'user')?.content ?? '';
      expect(user.startsWith(`${String(sentence?.text)}\n`), row.id).toBe(true);
      expect(held.has(norm(user.split('\n')[0])), row.id).toBe(false);
    }
  });

  it('is chat-shaped with the production compact prompt, a seed and a fidelity score', () => {
    for (const row of rows) {
      expect(row.messages.map((message) => message.role), row.id).toEqual(['system', 'user', 'assistant']);
      expect(canonicalHash(row.messages[0].content), row.id).toBe(row.promptVersion);
      expect(Number.isInteger(row.seed), row.id).toBe(true);
      expect(row.score.items, row.id).toBeGreaterThan(0);
      const answer = JSON.parse(row.messages[2].content) as { control?: unknown };
      expect(typeof answer.control, row.id).toBe('string');
    }
  });
});

describe('collection report', () => {
  const report = JSON.parse(readFileSync(join(TRAIN, 'collect-report.json'), 'utf8')) as {
    k: number;
    sentences: { id: string; candidates: { fallbackReason: string | null }[] }[];
  };

  // Obsazená karta (27. 9.: 13 kandidátů po 120 s) vypadá v sadě jako věta, kterou model neumí.
  it('books only sentences the model answered in full: a timeout is unmeasured, not failed', () => {
    const unanswered = report.sentences.filter(
      (entry) => entry.candidates.length !== report.k || entry.candidates.some((row) => row.fallbackReason === 'MODEL_UNAVAILABLE'),
    );
    expect(unanswered.map((entry) => entry.id)).toEqual([]);
  });
});
