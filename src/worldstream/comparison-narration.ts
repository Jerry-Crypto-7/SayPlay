import type { BranchComparison } from './branch-controller';
import type { RuntimeSnapshot } from './runtime-controller';

/**
 * Věta o rozdílu dvou budoucností, psaná ze stavového diffu, ne modelem.
 *
 * Model píše `summary` o tom, co *chtěl* změnit; tohle říká, co se doopravdy
 * stalo: výsledek obou větví s tikem, první tik rozchodu a až tři nejvýraznější
 * rozdíly slotů pojmenované jmény z blueprintu. Deterministické – stejné
 * porovnání dá stejné věty, a když se hashe stavů rovnají, žádný rozdíl
 * netvrdí, ať dokumenty vypadají jakkoli jinak.
 */

/** Jména entit z blueprintu (`stableId → label`); zdrojový projekt žádný nemá a zůstane u ID. */
export type EntityNames = Readonly<Record<string, string>>;

function outcome(snapshot: RuntimeSnapshot, observationTick: number): string {
  switch (snapshot.runState) {
    case 'won': return `won at tick ${snapshot.endedAtTick}`;
    case 'lost': return `lost at tick ${snapshot.endedAtTick}`;
    case 'runtimeFault': return `hit a runtime fault at tick ${snapshot.endedAtTick}`;
    case 'running': return `never won within ${observationTick} ticks`;
  }
}

/**
 * Stav se hýbe jen akcemi pravidel, takže první tik, kde se přechody liší,
 * je první tik, kde se mohly rozejít hashe. Když v obou větvích vystřelila
 * táž pravidla, rozchod začíná prvním výstřelem změněného pravidla – jeho
 * akce se liší, i když jméno je stejné.
 */
function firstDivergence(c: BranchComparison): number {
  const key = (t: RuntimeSnapshot['transitions'][number]) => `${t.tick}:${t.ruleIds.join(',')}`;
  const original = c.original.transitions.filter(t => t.tick >= c.forkTick);
  const changed = c.changed.transitions.filter(t => t.tick >= c.forkTick);
  const count = Math.max(original.length, changed.length);
  for (let i = 0; i < count; i++) {
    if (!original[i] || !changed[i] || key(original[i]) !== key(changed[i])) {
      return Math.min(original[i]?.tick ?? Infinity, changed[i]?.tick ?? Infinity);
    }
  }
  return changed.find(t => t.ruleIds.includes(c.ruleId))?.tick ?? c.observationTick;
}

function word(id: string, amount: number): string {
  if (id.endsWith(':locked')) return amount ? 'locked' : 'unlocked';
  if (id.startsWith('f:')) return amount ? 'on' : 'off';
  if (id.startsWith('t:')) return `${amount} ticks`;
  return String(amount);
}

/** `e:case:locked` → `Gate`, `f:lamp` → `lamp`, `e:guard:x` → `Guard x`; `word()` už říká locked/unlocked. */
function label(id: string, names: EntityNames): string {
  if (!id.startsWith('e:')) return id.slice(2);
  const [, stableId, field] = id.split(':');
  const name = names[stableId] ?? stableId;
  return field === 'locked' ? name : `${name} ${field}`;
}

export function narrateComparison(c: BranchComparison, names: EntityNames): string[] {
  const first = c.original.runState === c.changed.runState && c.original.endedAtTick === c.changed.endedAtTick
    ? `Both futures ${outcome(c.original, c.observationTick)}.`
    : `The original future ${outcome(c.original, c.observationTick)}; the changed future ${outcome(c.changed, c.observationTick)}.`;
  if (c.original.stateHash === c.changed.stateHash) {
    return [first, `No difference: both futures reach the same state at tick ${c.observationTick}.`];
  }
  // Odpočet lišící se o desítky tiků je míň vidět než odemčené dveře: časovače až za ostatní sloty.
  const diffs = Object.keys(c.original.values).filter(id => c.original.values[id] !== c.changed.values[id])
    .sort((a, b) => Number(a.startsWith('t:')) - Number(b.startsWith('t:'))
      || Math.abs(c.original.values[b] - c.changed.values[b]) - Math.abs(c.original.values[a] - c.changed.values[a])
      || a.localeCompare(b))
    .slice(0, 3)
    .map(id => `${label(id, names)} ${word(id, c.original.values[id])} → ${word(id, c.changed.values[id])}`);
  const lines = [first, `The futures first part at tick ${firstDivergence(c)}.`];
  if (diffs.length) lines.push(`Biggest differences at tick ${c.observationTick}: ${diffs.join('; ')}.`);
  return lines;
}
