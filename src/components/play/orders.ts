/**
 * Přání zákazníků (P25E T4): co který zákazník chce, jak to zapsal kompilátor
 * – pravidlo `carry.<zákazník>.serve` s podmínkou `hasItem` na jídlo a čítač
 * `<zákazník>_served` (adaptér `carry` s `menu`). Nic se nedopočítává z menu.
 *
 * Pole `sim` jsou ve schématu blueprintu `unknown`, proto se tvar čte tady.
 */

import type { GameSpecV1 } from '@/play/spec';
import { readVariable, type RuntimeSnapshot } from '@/worldstream/runtime-controller';

export interface Order {
  readonly customer: string;
  readonly dish: string;
  /** Popisek jídla pro hráče (`roles[].label`). */
  readonly label: string;
}

const SERVE = /^carry\.(.+)\.serve$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function dishOf(condition: unknown): string | null {
  if (!isRecord(condition) || !Array.isArray(condition.operands)) return null;
  const has = condition.operands.find((operand) => isRecord(operand) && operand.kind === 'hasItem');
  return isRecord(has) && typeof has.item === 'string' ? has.item : null;
}

/** Objednávky hry v pořadí pravidel; hra bez objednávek dá `[]`. */
export function readOrders(sim: { readonly rules: unknown }, roles: GameSpecV1['roles']): readonly Order[] {
  if (!isRecord(sim.rules)) return [];
  const orders: Order[] = [];
  for (const [id, rule] of Object.entries(sim.rules)) {
    const customer = SERVE.exec(id)?.[1];
    const dish = customer === undefined || !isRecord(rule) ? null : dishOf(rule.condition);
    if (customer === undefined || dish === null) continue;
    orders.push({ customer, dish, label: roles.find((role) => role.id === dish)?.label ?? dish });
  }
  return orders;
}

/** Objednávky, které ještě nikdo neobsloužil. */
export function openOrders(orders: readonly Order[], snapshot: Pick<RuntimeSnapshot, 'values'>): readonly Order[] {
  return orders.filter((order) => (readVariable(snapshot as RuntimeSnapshot, `${order.customer}_served`) ?? 0) < 1);
}
