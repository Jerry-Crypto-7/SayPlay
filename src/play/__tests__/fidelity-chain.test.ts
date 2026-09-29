/**
 * Řetěz věrnosti (P27A T1): měřidlo, které ignoruje doplněk nebo počítá
 * popisek bez modelu jako vidět, dává čísla, která vypadají dobře a jsou špatně.
 */

import { describe, expect, it } from 'vitest';

import { draftGameSpec } from '@/play/draft';
import { type ChecklistEntry, fidelityChain } from '@/play/fidelity/chain';
import type { GameSpecV1 } from '@/play/spec';

import shooterFixture from '../arcade/__fixtures__/shooter.json';

import { legacyDraft } from './legacy-draft';

const stages = (items: ReturnType<typeof fidelityChain>) => items.map((item) => [item.item, item.inSpec, item.read, item.drawn, item.why]);

describe('fidelityChain', () => {
  it('counts a verb fulfilled by an addon as read', () => {
    const shoot: ChecklistEntry = { item: 'shoot', slot: 'verb', controls: ['shooter'] };
    // Doplňky („+shoot“) přidává jen šablona remixu (P32B T2); žánr dvě slovesa nesčítá.
    const spec = legacyDraft('jump and shoot the zombies');
    expect(spec.control).toBe('platform');
    expect(spec.addons).toEqual(['shoot']);
    expect(stages(fidelityChain(spec, [shoot]))).toEqual([['shoot', true, true, true, 'ok']]);
    // Nepřítel `+shoot` (role `enemy`) se kreslí modelem z popisku, i když plošinovka popisky nepřátel nečte.
    const named = { ...spec, roles: [...spec.roles.filter((role) => role.id !== 'coin'), { id: 'enemy', kind: 'hazard', label: 'zombie' }] } as GameSpecV1;
    expect(stages(fidelityChain(named, [{ item: 'zombie', slot: 'role', match: ['zombie'] }, shoot]))).toEqual([
      ['zombie', true, true, true, 'ok'],
      ['shoot', true, true, true, 'ok'],
    ]);
    // Bez doplňku stejná role nic nekreslí – plošinovka ji nečte.
    expect(fidelityChain({ ...named, addons: undefined }, [shoot, { item: 'zombie', slot: 'role', match: ['zombie'] }]).map((item) => item.why)).toEqual(['not-in-spec', 'not-read-by-control']);
  });

  it('does not count a role label without a model as drawn', () => {
    const spec = { ...shooterFixture, roles: shooterFixture.roles.map((role) => (role.id === 'enemy' ? { ...role, label: 'kettle' } : role)) } as GameSpecV1;
    const [kettle] = fidelityChain(spec, [{ item: 'kettle', slot: 'role', match: ['kettle'] }]);
    expect(kettle).toMatchObject({ inSpec: true, read: true, drawn: false, why: 'no-model' });
    const [robot] = fidelityChain(shooterFixture as GameSpecV1, [{ item: 'robot', slot: 'role', match: ['robot'] }]);
    expect(robot).toMatchObject({ drawn: true, why: 'ok' });
  });

  // P27A T4: soupeř souboje z věty; model jen ten, který popisek jmenuje.
  it('names the duel rival from the sentence and draws it only with its own model', () => {
    const kangaroo = draftGameSpec('boxing a kangaroo in the australian outback');
    expect(kangaroo.control).toBe('duel');
    // Klokan má od P30B T4 vlastní model; vombat žádný – liška za něj se jako nakreslený nepočítá.
    expect(fidelityChain(kangaroo, [{ item: 'kangaroo', slot: 'role', match: ['kangaroo'] }, { item: 'outback', slot: 'setting', match: ['outback'] }])).toMatchObject([
      { inSpec: true, read: true, drawn: true, why: 'ok' },
      { drawn: true, why: 'ok' },
    ]);
    const wombat: GameSpecV1 = { ...kangaroo, roles: kangaroo.roles.map((role) => (role.id === 'rival' ? { ...role, label: 'wombat' } : role)) };
    expect(fidelityChain(wombat, [{ item: 'wombat', slot: 'role', match: ['wombat'] }])[0]).toMatchObject({ inSpec: true, read: true, drawn: false, why: 'no-model' });
    const pigeons = draftGameSpec('A grandma karate fights a gang of pigeons in the park');
    expect(fidelityChain(pigeons, [{ item: 'pigeon', slot: 'role', match: ['pigeon'] }])[0]).toMatchObject({ drawn: true, why: 'ok' });
  });

  it('names the first stage where an item is lost', () => {
    const spec = shooterFixture as GameSpecV1;
    const items = fidelityChain(spec, [
      { item: 'dragon', slot: 'role', match: ['dragon'] },
      { item: 'race', slot: 'verb', controls: ['steer'] },
    ]);
    expect(items.map((item) => item.why)).toEqual(['not-in-spec', 'not-in-spec']);
  });

  // Tři specy sady věrnosti z P26: `inSpec` a `read` se řetězem nezměnily.
  describe('keeps inSpec and read of the golden specs', () => {
    const checklist: ChecklistEntry[] = [
      { item: 'zombie', slot: 'role', match: ['zombie'] },
      { item: 'mall', slot: 'setting', match: ['mall'] },
      { item: 'shoot', slot: 'verb', controls: ['shooter'] },
    ];
    const spec = (control: string, enemyLabel: string) =>
      ({
        control,
        roles: [
          { id: 'hero', kind: 'player', label: 'Survivor', count: 1 },
          { id: 'enemy', kind: 'target', label: enemyLabel, count: 3 },
        ],
        mechanics: [],
        theme: { setting: 'abandoned mall', mood: 'tense' },
      }) as unknown as GameSpecV1;
    const readStages = (value: GameSpecV1) => fidelityChain(value, checklist).map((item) => [item.item, item.inSpec, item.read]);

    it('shooter', () => {
      expect(readStages(spec('shooter', 'Zombie'))).toEqual([
        ['zombie', true, true],
        ['mall', true, true],
        ['shoot', true, true],
      ]);
    });
    it('tap_go', () => {
      expect(readStages({ ...spec('tap_go', 'Zombies'), control: undefined } as unknown as GameSpecV1)).toEqual([
        ['zombie', true, true],
        ['mall', true, true],
        ['shoot', false, false],
      ]);
    });
    // P27A T3: závod kreslí sadu prostředí, `mall` je od té doby čtené.
    it('steer', () => {
      expect(readStages(spec('steer', 'Zombie'))).toEqual([
        ['zombie', true, false],
        ['mall', true, true],
        ['shoot', false, false],
      ]);
    });
  });
});
