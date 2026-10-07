import { describe, expect, it } from 'vitest';

import { arrivedAt, createControls, intentFromKey, phaseOf, type PlacedEntity } from '../flow';

describe('klávesa se překládá na záměr', () => {
  const targets = ['keyA', 'keyB', 'door'];

  it('číslice míří na cíl na své pozici', () => {
    expect(intentFromKey('1', targets, null)).toEqual({ actionId: 'moveTo', target: 'keyA' });
    expect(intentFromKey('3', targets, null)).toEqual({ actionId: 'moveTo', target: 'door' });
  });

  it('číslice mimo seznam nedělá nic', () => {
    expect(intentFromKey('4', targets, null)).toBeNull();
    expect(intentFromKey('0', targets, null)).toBeNull();
  });

  it('seber a použij míří na vybraný cíl', () => {
    expect(intentFromKey(' ', targets, 'keyB')).toEqual({ actionId: 'pickup', target: 'keyB' });
    expect(intentFromKey('e', targets, 'keyB')).toEqual({ actionId: 'use', target: 'keyB' });
    expect(intentFromKey('E', targets, 'keyB')).toEqual({ actionId: 'use', target: 'keyB' });
  });

  it('bez vybraného cíle nemá seber ani použij kam mířit', () => {
    expect(intentFromKey(' ', targets, null)).toBeNull();
    expect(intentFromKey('e', targets, null)).toBeNull();
  });

  it('neznámá klávesa je ticho, ne výjimka', () => {
    expect(intentFromKey('q', targets, 'keyB')).toBeNull();
    expect(intentFromKey('Enter', targets, 'keyB')).toBeNull();
  });
});

describe('fáze hry', () => {
  const base = { hasWorld: true, revealed: 4, total: 4, runState: 'running' } as const;

  it('bez světa se staví', () => {
    expect(phaseOf({ ...base, hasWorld: false })).toBe('building');
  });

  it('nedostavěný svět se staví, i když běh běží', () => {
    expect(phaseOf({ ...base, revealed: 3 })).toBe('building');
  });

  it('dostavěný a běžící svět se hraje', () => {
    expect(phaseOf(base)).toBe('playing');
  });

  it('výhra přebije i nedostavěnou scénu', () => {
    // Bez tohohle pořadí by svět, který vyhraje dřív, než dojede rozvrh stavby,
    // hlásil `building` a výhra by se ztratila.
    expect(phaseOf({ ...base, revealed: 0, runState: 'won' })).toBe('won');
  });

  it('svět bez běhu se čte jako building, i když ten předchozí skončil výhrou', () => {
    // Na téhle kombinaci stojí restart: `page.tsx` při něm uvolní odkaz na starý
    // vyhraný běh právě proto, aby se fáze nečetla z něj. Kdyby tohle vracelo
    // `won`, restart by se v záznamu fází neprojevil vůbec a `building` by se
    // podruhé nezapsalo — přesně ta vada, kterou měřila T23q.
    expect(phaseOf({ hasWorld: false, revealed: 0, total: 1, runState: 'running' })).toBe('building');
  });

  it('prohra i běhová vada jsou prohra', () => {
    expect(phaseOf({ ...base, runState: 'lost' })).toBe('lost');
    expect(phaseOf({ ...base, runState: 'runtimeFault' })).toBe('lost');
  });
});

describe('dojel jsem na cíl?', () => {
  const at = (stableId: string, cell: readonly [number, number]): PlacedEntity => ({ stableId, cell });

  it('shodná políčka znamenají dojezd', () => {
    expect(arrivedAt([at('player', [3, 4]), at('key', [3, 4])], 'player', 'key')).toBe(true);
  });

  it('rozdíl v jediné ose dojezd není', () => {
    expect(arrivedAt([at('player', [3, 4]), at('key', [3, 5])], 'player', 'key')).toBe(false);
    expect(arrivedAt([at('player', [2, 4]), at('key', [3, 4])], 'player', 'key')).toBe(false);
  });

  it('chybějící entita není dojezd', () => {
    expect(arrivedAt([at('player', [3, 4])], 'player', 'key')).toBe(false);
    expect(arrivedAt([at('key', [3, 4])], 'player', 'key')).toBe(false);
  });
});

describe('fronta stisků a stopa, která z ní vznikne', () => {
  it('razítko dostane tik, který si pro vstup přijde, ne tik stisku', () => {
    // Jádro věci: kdyby si stisk bral tik sám, trefil by tik, který smyčka právě
    // odkrokovala, a `inputsForTick` by ho zahodila. Fronta proto čeká.
    const controls = createControls();
    controls.press('1', ['keyA']);

    // Stisk padl kdykoli; razítko dá až tik, který si pro něj přijde — tady 41.
    expect(controls.take(41, 'player')).toEqual([{ tick: 41, actor: 'player', actionId: 'moveTo', target: 'keyA' }]);
    // A podruhé už nic: co se vzalo, je pryč z fronty.
    expect(controls.take(42, 'player')).toEqual([]);
  });

  it('prázdná fronta nezapíše do stopy nic', () => {
    const controls = createControls();
    expect(controls.take(7, 'player')).toEqual([]);
    expect(controls.log()).toEqual([]);
  });

  it('dva stisky mezi tiky vyjdou oba, v pořadí stisku', () => {
    const controls = createControls();
    controls.press('1', ['keyA', 'door']);
    controls.press(' ', ['keyA', 'door']);

    expect(controls.take(5, 'player').map((input) => input.actionId)).toEqual(['moveTo', 'pickup']);
  });

  it('co se vzalo, to je ve stopě — a jen jednou', () => {
    const controls = createControls();
    controls.press('1', ['keyA']);
    controls.take(3, 'player');
    controls.take(4, 'player');

    expect(controls.log()).toEqual([{ tick: 3, actor: 'player', actionId: 'moveTo', target: 'keyA' }]);
  });

  it('číslice vybere cíl, takže na něj míří i další seber', () => {
    const controls = createControls();
    expect(controls.selected()).toBeNull();
    controls.press('2', ['keyA', 'keyB']);
    expect(controls.selected()).toBe('keyB');
    expect(controls.press(' ', ['keyA', 'keyB'])).toEqual({ actionId: 'pickup', target: 'keyB' });
  });

  it('restart vysype frontu, stopu i výběr', () => {
    const controls = createControls();
    controls.press('1', ['keyA']);
    controls.take(2, 'player');
    controls.press('1', ['keyA']);
    controls.reset();

    expect(controls.log()).toEqual([]);
    expect(controls.selected()).toBeNull();
    expect(controls.take(9, 'player')).toEqual([]);
  });
});
