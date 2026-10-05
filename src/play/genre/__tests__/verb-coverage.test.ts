/**
 * Pokrytí sloves na `dev-150` (P37A T4): hlavní sloveso věty patří rodině
 * (`families.ts`) nebo známému žánru tabulky `VERBS`. Na náhradu (sběr v Aréně
 * bez slovesa) smí padnout jen věta, ve které herní sloveso není – ty jsou
 * vypsané ručně, takže nová díra i ztracené sloveso test shodí.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';

import dev from '../../../../evals/play/p37a/dev-150.json';
import { measureSentence } from '../../../../evals/play/p36/depth';
import { classifyGenre } from '../classify';

/**
 * Věty bez herního slovesa: jen podstatná jména („toaster tornado“, „a long queue
 * at the pharmacy“), pocit nebo stav („that feeling when you remember…“,
 * „grieving my grandfather“) a rozhovor bez protivníka („call grandma“, „explain
 * to my parents…“). Ty patří absurdnímu přenosu (T5), ne tabulce sloves.
 */
const NO_VERB = ['n03', 'n07', 'n10', 'n14', 'n16', 'n17', 'n18', 'n19', 'n22', 'n25', 'n27', 'n29', 'n30', 'n33', 'm01', 'm02', 'm03', 'm05', 'm06'];

const rows = dev.sentences.map((sentence) => ({ id: sentence.id, text: sentence.text, pick: classifyGenre(sentence.text, null).pick }));

beforeAll(async () => {
  await loadRapier();
});

describe('verb coverage on dev-150', () => {
  it('hears a family or a known-genre verb in ≥ 85 % of the sentences', () => {
    const heard = rows.filter((row) => row.pick !== null);
    expect(heard.length).toBeGreaterThanOrEqual(Math.ceil(rows.length * 0.85));
  });

  it('falls back only on the sentences without a verb', () => {
    expect(rows.filter((row) => row.pick === null).map((row) => row.id)).toEqual(NO_VERB);
  });

  it('is won by the robot in ≥ 92 % and lost by an idle player in ≥ 95 % of the sentences', () => {
    const played = rows.map((row) => measureSentence({ set: 'dev', id: row.id, text: row.text }));
    const won = played.filter((row) => row.bot.end === 'won');
    const lost = played.filter((row) => row.idle.end === 'lost');
    expect(won.length, JSON.stringify(played.filter((row) => row.bot.end !== 'won').map((row) => row.id))).toBeGreaterThanOrEqual(Math.ceil(rows.length * 0.92));
    expect(lost.length, JSON.stringify(played.filter((row) => row.idle.end !== 'lost').map((row) => row.id))).toBeGreaterThanOrEqual(Math.ceil(rows.length * 0.95));
  }, 600_000);
});
