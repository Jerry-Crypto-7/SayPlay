/**
 * Řetěz věrnosti (P27A T1): měřidlo, které ignoruje doplněk nebo počítá
 * popisek bez modelu jako vidět, dává čísla, která vypadají dobře a jsou špatně.
 */

import { describe, expect, it } from 'vitest';

import { draftGameSpec } from '@/play/draft';
import { type ChecklistEntry, fidelityChain } from '@/play/fidelity/chain';
import type { GameSpecV1 } from '@/play/spec';

import arenaFixture from '../arcade/__fixtures__/arena.json';
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
    const spec = { ...shooterFixture, roles: shooterFixture.roles.map((role) => (role.id === 'enemy' ? { ...role, label: 'stapler' } : role)) } as GameSpecV1;
    const [stapler] = fidelityChain(spec, [{ item: 'stapler', slot: 'role', match: ['stapler'] }]);
    expect(stapler).toMatchObject({ inSpec: true, read: true, drawn: false, why: 'no-model' });
    const [robot] = fidelityChain(shooterFixture as GameSpecV1, [{ item: 'robot', slot: 'role', match: ['robot'] }]);
    expect(robot).toMatchObject({ drawn: true, why: 'ok' });
  });

  // P27A T4: soupeř souboje z věty; model jen ten, který popisek jmenuje.
  // Ovládání `duel` staví od P32B T2 šablona remixu; nová hra je souboj arény (test níž).
  it('names the duel rival from the sentence and draws it only with its own model', () => {
    const kangaroo = legacyDraft('boxing a kangaroo in the australian outback');
    expect(kangaroo.control).toBe('duel');
    // Klokan má od P30B T4 vlastní model; vombat žádný – liška za něj se jako nakreslený nepočítá.
    expect(fidelityChain(kangaroo, [{ item: 'kangaroo', slot: 'role', match: ['kangaroo'] }, { item: 'outback', slot: 'setting', match: ['outback'] }])).toMatchObject([
      { inSpec: true, read: true, drawn: true, why: 'ok' },
      { drawn: true, why: 'ok' },
    ]);
    const wombat: GameSpecV1 = { ...kangaroo, roles: kangaroo.roles.map((role) => (role.id === 'rival' ? { ...role, label: 'wombat' } : role)) };
    expect(fidelityChain(wombat, [{ item: 'wombat', slot: 'role', match: ['wombat'] }])[0]).toMatchObject({ inSpec: true, read: true, drawn: false, why: 'no-model' });
    const pigeons = legacyDraft('A grandma karate fights a gang of pigeons in the park');
    expect(fidelityChain(pigeons, [{ item: 'pigeon', slot: 'role', match: ['pigeon'] }])[0]).toMatchObject({ drawn: true, why: 'ok' });
  });

  // P32B T5b: žánr arény je `move_free` s generátorem – popisky čte generátor, když z role postavil tělo (`StyledWorld`, P32E T5).
  it('reads the roles a genre arena builds bodies for and draws them only with the model the scene gives them', () => {
    const escape = draftGameSpec('a cat runs from dogs in a park');
    expect(stages(fidelityChain(escape, [{ item: 'cat', slot: 'hero', match: ['cat'] }, { item: 'dog', slot: 'role', match: ['dog'] }]))).toEqual([
      ['cat', true, true, true, 'ok'],
      ['dog', true, true, true, 'ok'],
    ]);
    // B-R9: soupeř souboje (`rival`) a věc sběru (`item`) berou model z vlastního popisku – klokan je klokan, sýr sýr.
    const fight = draftGameSpec('boxing a kangaroo in the australian outback');
    expect(fight.controlParams).toMatchObject({ generator: 'fight' });
    expect(stages(fidelityChain(fight, [{ item: 'kangaroo', slot: 'role', match: ['kangaroo'] }]))).toEqual([['kangaroo', true, true, true, 'ok']]);
    const robot: GameSpecV1 = { ...fight, roles: fight.roles.map((role) => (role.id === 'rival' ? { ...role, label: 'robot' } : role)) };
    expect(stages(fidelityChain(robot, [{ item: 'robot', slot: 'role', match: ['robot'] }]))).toEqual([['robot', true, true, true, 'ok']]);
    const collect = draftGameSpec('a mouse collects cheese in a kitchen');
    expect(stages(fidelityChain(collect, [{ item: 'cheese', slot: 'role', match: ['cheese'] }]))).toEqual([['cheese', true, true, true, 'ok']]);
    // Agar (`move_free` bez generátoru) kreslí kotouče – popisky dál nečte.
    const agar = arenaFixture as GameSpecV1;
    expect(fidelityChain(agar, [{ item: 'big fish', slot: 'role', match: ['big fish'] }])[0]).toMatchObject({ inSpec: true, read: false, why: 'not-read-by-control' });
  });

  // P32B T6: hra žánru nese sloveso režimem generátoru, ne ovládáním ze seznamu (`duel`, `throw`).
  it('counts a verb of a genre game when its mode is the one the verb plays', () => {
    const verb = (spec: GameSpecV1, item: string, controls: string[]) => fidelityChain(spec, [{ item, slot: 'verb', controls }])[0].why;
    const fight = draftGameSpec('boxing a kangaroo in the australian outback');
    expect(verb(fight, 'box', ['duel'])).toBe('ok');
    expect(verb(fight, 'throw', ['throw'])).toBe('not-in-spec');
    const quest = draftGameSpec('pop ten balloons at a birthday party');
    expect(quest.controlParams).toMatchObject({ generator: 'quest_spatial' });
    expect(verb(quest, 'pop', ['shooter'])).toBe('ok');
    expect(verb(quest, 'duel', ['duel'])).toBe('not-in-spec');
    // Sběr hraje každý režim, který má co sbírat – útěk s klíči ano, souboj bez věci ne.
    const escape = draftGameSpec('A knight must collect three keys in a haunted castle while dodging ghosts.');
    expect(verb(escape, 'collect', [])).toBe('ok');
    expect(verb(fight, 'collect', [])).toBe('not-in-spec');
    // Sloveso mimo tabulku klasifikátoru žádný režim nehraje.
    expect(verb(quest, 'launch', ['throw'])).toBe('not-in-spec');
  });

  // P39 T2: stupeň `role` – věc z věty dělá ve hře to, co o ní věta říká, a tělo, které to dělá, nese její model.
  describe('role stage', () => {
    const base = legacyDraft('jump and shoot the zombies');
    const player = base.roles.find((role) => role.kind === 'player')!;
    const finish = base.roles.find((role) => role.id === 'finish')!;
    // Spouštěč P39: vlk jako bodák plošinovky, střílí se do robotů (doplněk `shoot` bez role `enemy`).
    const wolfAsSpikes = { ...base, control: 'platform', addons: ['shoot'], roles: [player, { id: 'spikes', kind: 'hazard', label: 'wolf', count: 5 }, finish] } as GameSpecV1;
    const animal: ChecklistEntry = { item: 'animal', slot: 'role', match: ['animal', 'wolf'], does: 'shoot_at' };
    const shoot: ChecklistEntry = { item: 'shoot', slot: 'verb', controls: ['shooter'] };
    const roleStage = (spec: GameSpecV1, list: ChecklistEntry[]) => fidelityChain(spec, list).map((item) => [item.item, item.read, item.role]);

    it('fails a shoot-at noun that the platformer plays as spikes, and the shoot verb the addon alone plays', () => {
      expect(roleStage(wolfAsSpikes, [animal, shoot])).toEqual([
        ['animal', false, false],
        // Doplněk sloveso hraje (`read`), ale střílí se do robotů, ne do zvířat z věty.
        ['shoot', true, false],
      ]);
    });

    it('passes both when the shot enemy carries the named thing', () => {
      const wolfShot = { ...wolfAsSpikes, roles: [player, { id: 'enemy', kind: 'hazard', label: 'wolf', count: 5 }, finish] } as GameSpecV1;
      expect(roleStage(wolfShot, [animal, shoot])).toEqual([
        ['animal', true, true],
        ['shoot', true, true],
      ]);
      // Táž věc s jinou rolí ve větě („avoid“) střílenému nepříteli neodpovídá.
      expect(roleStage(wolfShot, [{ ...animal, does: 'avoid' }])).toEqual([['animal', true, false]]);
      // Sloveso bez jmenovaného terče doplněk splní sám – není čí model chtít.
      expect(roleStage(wolfAsSpikes, [shoot])).toEqual([['shoot', true, true]]);
    });

    it('reads chasers, collectibles and duel rivals as what they do', () => {
      const escape = draftGameSpec('a cat runs from dogs in a park');
      expect(roleStage(escape, [{ item: 'dog', slot: 'role', match: ['dog'], does: 'chase_me' }])).toEqual([['dog', true, true]]);
      expect(roleStage(escape, [{ item: 'dog', slot: 'role', match: ['dog'], does: 'collect' }])).toEqual([['dog', true, false]]);
      const fight = draftGameSpec('boxing a kangaroo in the australian outback');
      expect(roleStage(fight, [{ item: 'kangaroo', slot: 'role', match: ['kangaroo'], does: 'fight' }])).toEqual([['kangaroo', true, true]]);
      const collect = draftGameSpec('a mouse collects cheese in a kitchen');
      expect(roleStage(collect, [{ item: 'cheese', slot: 'role', match: ['cheese'], does: 'collect' }])).toEqual([['cheese', true, true]]);
    });
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
