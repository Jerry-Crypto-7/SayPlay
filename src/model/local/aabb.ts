/** Jedna deklarovaná kolizní obálka ve tvaru `[x, y, width, height]`. */
type CollisionAabb = readonly [number, number, number, number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSocket(value: unknown): value is readonly [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((part) => typeof part === 'number' && Number.isFinite(part))
  );
}

function isCollisionAabb(value: unknown): value is CollisionAabb {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((part) => typeof part === 'number' && Number.isFinite(part)) &&
    value[2] > 0 &&
    value[3] > 0
  );
}

/**
 * Doplní odvoditelnou kolizní obálku, když ji model vynechal nebo rozbil.
 *
 * Každá entita s platným soketem dostane jednotkový box v souřadnici soketu.
 * Platnou úplnou mapu necháváme beze změny: model smí zvolit jinou šířku či
 * výšku, pokud pořád dodržel deklarovaný tvar a pokryl všechny odvoditelné
 * entity.
 */
export function deriveCollisionAabb(sim: Record<string, unknown>): Record<string, unknown> {
  const sockets = isRecord(sim.sockets) ? sim.sockets : {};
  const entities = isRecord(sim.entities) ? sim.entities : {};
  const boxes: Record<string, CollisionAabb> = {};

  for (const [name, rawEntity] of Object.entries(entities)) {
    if (!isRecord(rawEntity) || typeof rawEntity.socket !== 'string') continue;
    const at = sockets[rawEntity.socket];
    if (!isSocket(at)) continue;
    boxes[name] = [at[0], at[1], 1, 1];
  }

  const supplied = sim.collisionAabb;
  const suppliedIsValid =
    isRecord(supplied) &&
    Object.values(supplied).every(isCollisionAabb) &&
    Object.keys(boxes).every((name) => isCollisionAabb(supplied[name]));

  return suppliedIsValid ? sim : { ...sim, collisionAabb: boxes };
}
