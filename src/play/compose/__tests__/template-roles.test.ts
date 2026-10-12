import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

// Návrh ověřuje i hry s fyzikálními tělesy (koule panelu).
beforeAll(async () => { await loadRapier(); });

/**
 * Šablona pravidel bere jen role, které ve hře opravdu jsou (P46B T2): vlna sbíraných věcí nese věc
 * z věty (mrkev, žalud), minci jen tam, kde věta ani její čtení žádnou věc nenese, a hra bez sbírané
 * věci vlnu věcí nedostane. Vlna ve hře o žaludech, ze které padají mince, by vypadala hratelně
 * a přitom by byla mimo větu.
 */

const ITEM_KINDS: readonly string[] = ['item', 'key', 'collectible'];

interface Wave {
  readonly role: string;
}

const wavesOf = (spec: GameSpecV1): Wave[] =>
  (spec.rules ?? []).flatMap((rule) => ((rule as { do?: readonly unknown[] }).do ?? []).flatMap((effect) => {
    const wave = (effect as { wave?: Wave }).wave;
    return wave === undefined ? [] : [wave];
  }));

const roleOf = (spec: GameSpecV1, id: string) => spec.roles.find((role) => role.id === id);

/** Sbíraná věc, kterou šablona vysype: popisek role její vlny; `null` = hra vlnu věcí nemá. */
function showered(text: string): string | null {
  const { spec } = draftGameSpecWithMeta(text, 1);
  const items = wavesOf(spec).map((wave) => roleOf(spec, wave.role)).filter((role) => role !== undefined && ITEM_KINDS.includes(role.kind));
  return items[0]?.label ?? null;
}

const read = (path: string): { sentences: { id: string; text: string }[] } => JSON.parse(readFileSync(path, 'utf8')) as { sentences: { id: string; text: string }[] };
const SENTENCES = [...read('evals/play/p45/panel.json').sentences, ...read('evals/play/p46b/sentences.json').sentences];

describe('rule templates use only roles the game really has', () => {
  it('showers the item of the sentence, not coins', () => {
    expect(showered('A rabbit steals carrots and runs from a fox')).toBe('carrot');
    expect(showered('A squirrel runs through the forest grabbing acorns')).toBe('acorn');
    // Věta nese jen houby a býky; žalud je věc jejich lesa z čtení věty, ne mince.
    expect(showered('Amanita mushrooms fight bulls, flee and shoot them')).toBe('acorn');
  });

  it('showers coins only when the sentence carries no item of its own', () => {
    expect(showered('a pengiun tht slides down a mountin')).toBe('coin');
  });

  it('never sends a wave of a role the spec does not declare, over the P45 panel and the P46B sentences', () => {
    expect(SENTENCES.length).toBe(52);
    for (const sentence of SENTENCES) {
      const { spec } = draftGameSpecWithMeta(sentence.text, 1);
      for (const wave of wavesOf(spec)) expect(roleOf(spec, wave.role), `${sentence.id}: wave of ${wave.role}`).toBeDefined();
    }
  });

  it('gives a game without anything to collect no wave of items', () => {
    let without = 0;
    for (const sentence of SENTENCES) {
      const { spec } = draftGameSpecWithMeta(sentence.text, 1);
      if (spec.roles.some((role) => ITEM_KINDS.includes(role.kind))) continue;
      without += 1;
      expect(showered(sentence.text), sentence.id).toBeNull();
    }
    // Panel má hry bez sbírané věci (souboj, střelnice, úkol); bez nich by test nic neověřil.
    expect(without).toBeGreaterThanOrEqual(10);
  });
});
