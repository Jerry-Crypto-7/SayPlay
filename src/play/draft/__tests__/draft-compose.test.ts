import { describe, expect, it } from 'vitest';
import { draftGameSpecWithMeta } from '../draft';
import { sentenceChecklist } from '@/play/fidelity/checklist';
import { specFidelity } from '@/play/fidelity/score';

describe('quick draft follows the full intent', () => {
  it('drives, shoots and races without missing actions', () => {
    const draft = draftGameSpecWithMeta('game in a car with shooting and racing');
    expect(draft.spec.control).toBe('steer');
    expect(draft.composition?.unmet).toEqual([]);
    expect(draft.composition?.unmet.some(item => item.verb === 'drive')).toBe(false);
    expect(draft.intent?.hero).toBe('car');
  });

  it('checks all requested actions against effects, including unknown actions', () => {
    const sentence = 'game in a car with shooting and racing';
    const draft = draftGameSpecWithMeta(sentence);
    const checklist = sentenceChecklist(sentence).checklist;
    expect(checklist.filter(item => item.slot === 'verb').map(item => item.triple?.verb)).toEqual(['drive', 'shoot', 'race']);
    const measured = specFidelity(draft.spec, checklist);
    expect(measured.items.find(item => item.item === 'drive')?.read).toBe(true);
    expect(measured.items.find(item => item.item === 'race')?.read).toBe(true);
    expect(measured.items.find(item => item.item === 'shoot')?.read).toBe(true);
    expect(sentenceChecklist('a grandma knits a scarf').checklist.some(item => item.triple?.verb === 'knit')).toBe(true);
  });
});
