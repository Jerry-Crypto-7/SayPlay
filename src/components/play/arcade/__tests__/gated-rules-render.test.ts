import { describe, expect, it } from 'vitest';
import type { ArcadeWorld, PieceRef } from '@/play/arcade/contract';
import { actionsOf } from '../ActionButton';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { collectNeed, countsAmmo, limitOf, scoreUnit, survives } from '../ArcadePlay';
import { glideShoots } from '../glide/glide-input';
import { enterOpensLiveBox } from '../LiveBox';
import { questVerbOf } from '../quest/verbFx';
import { driveModeOf } from '../steer/SteerScene';
import { walkerCones } from '../walker/WalkerScene';

// Složená hra (P42) balí nativní pravidla do `assembly_gate_<trigger>`; HUD a scény je
// musí najít podle nativního id, jinak hra hodiny, munici, mezerník ani kužely neukáže.
const gate = (base: PieceRef, trigger = 'tick'): PieceRef => ({ id: `assembly_gate_${trigger}`, params: { keeper: 9, parts: [], base } });
const interact = { id: 'interact', params: { id: 'quest', verb: 'fix', when: { interact: { role: 'lamp', radius: 2, hold: 20, states: 2 } }, if: [], do: [] } };

function world(rules: PieceRef[], control: PieceRef = { id: 'steer', params: {} }): ArcadeWorld {
  return { control: { id: 'assembly_control', params: { base: control } }, rules } as unknown as ArcadeWorld;
}
const composed = world([
  gate({ id: 'blaster', params: { ammo: 5 } }, 'press'),
  gate({ id: 'time_limit', params: { seconds: 45 } }),
  gate(gate({ id: 'walker_caught', params: { body: 4, range: 3000 } }, 'tick'), 'tick'),
  gate(interact),
  { id: 'assembly_finish', params: {} },
]);

describe('render and HUD see gated native rules', () => {
  it('the HUD shows the clock and the ammo of a composed game', () => {
    expect(limitOf(composed)).toBe(45);
    expect(countsAmmo(composed)).toBe(true);
    expect(survives(world([gate({ id: 'survive_time', params: { seconds: 30 } })]))).toBe(true);
  });

  it('the HUD keeps the collect goal of a composed game with +collect', () => {
    expect(collectNeed(world([gate({ id: 'finish_collected', params: { need: 4 } })]))).toBe(4);
  });

  it('space fires in a composed flight and drive, and does not open the live box', () => {
    expect(glideShoots(composed)).toBe(true);
    expect(driveModeOf(composed)).toBe('shoot');
    expect(enterOpensLiveBox(composed)).toBe(false);
  });

  it('guard cones keep their body through nested gates', () => {
    expect(walkerCones(composed)).toEqual([{ body: 4, range: 3000 }]);
  });

  it('the quest verb and the use button find a gated interact', () => {
    expect(questVerbOf(composed)?.states).toBe(2);
    expect(actionsOf(composed)).toContain('use');
  });
});

describe('result unit of a catch game', () => {
  // P51 T4a: body nové hry chytání jsou mince tepu; uložená hra bez značky `segments` počítá snědené jako dřív.
  it('a new catch game counts coins, a stored one counts what was eaten', () => {
    const spec = compileRecipe(assemblyOfCell(liveCells().find((cell) => cell.id === 'roam.catch')!));
    const { tuning, ...params } = spec.controlParams as { tuning: Record<string, unknown> };
    const { segments, ...stored } = tuning;
    expect(segments).toBe(true);
    expect(scoreUnit(spec)).toBe('coins');
    expect(scoreUnit({ ...spec, controlParams: { ...params, tuning: stored } as typeof spec.controlParams })).toBe('eaten');
  });
});
