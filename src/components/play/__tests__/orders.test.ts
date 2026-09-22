/**
 * Přání zákazníků (P25E T4): bublina za každého zákazníka, obsloužený ji
 * ztratí; hra bez objednávek nemá žádnou.
 */

import { describe, expect, it } from 'vitest';

import collectExit from '@/play/__fixtures__/collect_exit.json';
import deliveryOrders from '@/play/__fixtures__/delivery_orders.json';
import { compileGame } from '@/play/compile';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import { openOrders, readOrders } from '../orders';

function compiled(fixture: unknown): { spec: GameSpecV1; sim: { rules: unknown; entities: Record<string, unknown> } } {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.reason);
  const result = compileGame(spec.value, 1);
  if (!result.ok || result.value.blueprint === null) throw new Error('fixture did not compile');
  return { spec: spec.value, sim: result.value.blueprint.world.sim as unknown as { rules: unknown; entities: Record<string, unknown> } };
}

describe('readOrders', () => {
  it('gives one order per customer, naming the dish the compiler asks for', () => {
    const { spec, sim } = compiled(deliveryOrders);
    const orders = readOrders(sim, spec.roles);
    const customers = Object.keys(sim.entities).filter((id) => id.startsWith('customer'));
    expect(customers.length).toBeGreaterThan(1);
    expect(orders.map((order) => order.customer).sort()).toEqual(customers.sort());
    // Menu je [burger, fries] a i-tý zákazník chce menu[i mod 2].
    expect(new Set(orders.map((order) => order.label))).toEqual(new Set(['burger', 'fries']));
  });

  it('finds no orders in a game without them', () => {
    const { spec, sim } = compiled(collectExit);
    expect(readOrders(sim, spec.roles)).toEqual([]);
  });
});

describe('openOrders', () => {
  it('drops a bubble for each customer served', () => {
    const { spec, sim } = compiled(deliveryOrders);
    const orders = readOrders(sim, spec.roles);
    const [first, second] = orders;
    expect(openOrders(orders, { values: {} })).toHaveLength(orders.length);
    expect(openOrders(orders, { values: { [`c:${first!.customer}_served`]: 1 } })).toHaveLength(orders.length - 1);
    const both = { [`c:${first!.customer}_served`]: 1, [`c:${second!.customer}_served`]: 1 };
    expect(openOrders(orders, { values: both }).map((order) => order.customer)).not.toContain(second!.customer);
    expect(openOrders(orders, { values: both })).toHaveLength(orders.length - 2);
  });
});
