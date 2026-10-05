import { describe, expect, it } from 'vitest';

import type { LivePatch } from '@/play/arcade/live';
import { applyRemix, remixPatch } from '@/play/director/remix';
import { draftGameSpec } from '@/play/draft/draft';
import type { GameSpecV1 } from '@/play/spec';

import { liveLabel, MAX_CHIPS, plural, remixChips } from '../remix-diff';

/**
 * Co remix změnil (P37C T7): čipy „+dragons“ / „faster“ vypadají dobře, i
 * když lžou – „faster“ u zpomalené hry nebo nový čip u hry, která se
 * nezměnila, nikdo na snímku nepozná. Pět párů specu: dva ručně složené
 * s přesným výsledkem a tři ze skutečných čipů remixu (`remixPatch`).
 */

const base = draftGameSpec('Collect five glowing mushrooms then open a portal.');

function chip(parent: GameSpecV1, name: 'harder' | 'swap_enemy' | 'reskin'): GameSpecV1 {
  const applied = applyRemix(parent, remixPatch(name, parent));
  if (!applied.ok) throw new Error(`${name}: ${applied.reason} ${applied.detail}`);
  return applied.spec;
}

describe('remixChips', () => {
  it('1. a new enemy, a faster pace and rain, in the order a player sees them', () => {
    const parent: GameSpecV1 = { ...base, controlParams: { speed: 'normal' } as GameSpecV1['controlParams'] };
    const enemy = base.roles.find((role) => role.kind !== 'player')!;
    const child: GameSpecV1 = {
      ...parent,
      controlParams: { speed: 'fast' } as GameSpecV1['controlParams'],
      roles: [...base.roles, { ...enemy, id: 'dragon', label: 'dragon', count: 3 }],
      theme: { ...base.theme, weather: 'rain' },
    };
    expect(remixChips(parent, child)).toEqual(['+dragons', 'faster', 'rain']);
    // Opačný směr: pomalejší hra nikdy neřekne „faster“.
    expect(remixChips(child, parent)).toEqual(['slower', 'no dragons']);
  });

  it('2. a new world and night, never more than three chips', () => {
    const child: GameSpecV1 = { ...base, theme: { ...base.theme, setting: 'lava floor', timeOfDay: 'night' }, addons: ['lives'] };
    expect(remixChips(base, child)).toEqual(['lava floor', 'night', '+lives']);
    const busy: GameSpecV1 = { ...child, theme: { ...child.theme, weather: 'snow' } };
    expect(remixChips(base, busy)).toHaveLength(MAX_CHIPS);
  });

  it('3. the reskin chip leads with the new world, cut to fit a phone', () => {
    const child = chip(base, 'reskin');
    const chips = remixChips(base, child);
    expect(child.theme.setting).not.toBe(base.theme.setting);
    expect(chips[0]!.replace(/…$/, '')).toBe(child.theme.setting.slice(0, chips[0]!.replace(/…$/, '').length));
    expect(chips.every((text) => text.length <= 24)).toBe(true);
    expect(chips).toHaveLength(MAX_CHIPS);
  });

  it('4. the swap-enemy chip names the new obstacle and the one it replaced', () => {
    const parent = draftGameSpec('dodge the falling rocks');
    const child = chip(parent, 'swap_enemy');
    const fresh = child.roles.find((role) => role.kind !== 'player' && !parent.roles.some((old) => old.label === role.label))!;
    const gone = parent.roles.find((role) => role.kind !== 'player' && !child.roles.some((now) => now.label === role.label))!;
    expect(remixChips(parent, child)).toEqual([`+${plural(fresh.label, fresh.count)}`, `no ${plural(gone.label, 2)}`]);
  });

  it('5. the harder chip says faster when the pace moves from its default, new rules when only tuning numbers move', () => {
    const runner = draftGameSpec('dodge the falling rocks');
    expect(remixChips(runner, chip(runner, 'harder'))).toEqual(['faster']);
    const chase = draftGameSpec('a dog chases a cat through the park');
    expect(remixChips(chase, chip(chase, 'harder'))).toEqual(['new rules']);
    const mushrooms = remixChips(base, chip(base, 'harder'));
    expect(mushrooms).toContain('new rules');
    expect(mushrooms.some((text) => text.startsWith('+') || text === 'easier' || text === 'slower' || text.startsWith('fewer'))).toBe(false);
  });

  it('the same game shows no chips at all', () => {
    expect(remixChips(base, structuredClone(base))).toEqual([]);
  });
});

describe('liveLabel', () => {
  it('says what the running game got, not what was asked', () => {
    const patches: LivePatch[] = [
      { kind: 'spawn', role: 'chaser', count: 3 },
      { kind: 'visual', weather: 'rain' },
      { kind: 'count', counter: 'health', amount: 1 },
      { kind: 'count', counter: 'time', amount: 10 },
    ];
    expect(liveLabel(patches, base)).toBe('+3 chasers · rain · +1 life · +10s');
    expect(liveLabel([{ kind: 'count', counter: 'health', amount: 2 }, { kind: 'visual', timeOfDay: 'night', weather: 'clear' }], base)).toBe('+2 lives · clear sky · night');
  });

  it('names an added role by the label the game gave it', () => {
    const labelled = base.roles.find((role) => role.kind === 'collectible')!;
    expect(liveLabel([{ kind: 'spawn', role: 'collectible', count: 2 }], base)).toBe(`+2 ${plural(labelled.label, 2)}`);
  });
});

describe('plural', () => {
  it('handles the label endings games use', () => {
    expect([plural('dragon', 3), plural('fox', 2), plural('puppy', 2), plural('day', 2), plural('bee', 1)]).toEqual(['dragons', 'foxes', 'puppies', 'days', 'bee']);
  });
});
