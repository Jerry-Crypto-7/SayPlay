/**
 * Co se změnilo (P37C T7): remix proti rodiči v 1–3 čipech („+dragons“,
 * „faster“, „lava floor“) a živá změna běhu jedním krátkým štítkem.
 *
 * Čipy se počítají ze specu, ne z věty remixu: věta říká, co hráč chtěl,
 * spec, co hra opravdu dostala. Pořadí je podle toho, co hráč na hře uvidí
 * nejdřív – prostředí, nové postavy, rychlost – a víc než tři se neukáže.
 */

import type { LivePatch } from '@/play/arcade/live';
import type { GameRole, GameSpecV1 } from '@/play/spec';

export const MAX_CHIPS = 3;

/** Čip delší než tohle se zkrátí – vejde se na telefonu do řádku. */
const CHIP_MAX = 24;

/** Pořadí stupňů rychlosti a obtížnosti napříč ovládáním (`RUNNER_SPEEDS`, `*_DIFFICULTIES`). */
const RANK: Readonly<Record<string, number>> = { slow: 0, easy: 0, normal: 1, fast: 2, hard: 2 };

const humanize = (id: string): string => id.replaceAll('_', ' ');

/** Množné číslo anglického podstatného jména – stačí na popisky rolí („dragon“, „glowing mushroom“, „fox“). */
export function plural(label: string, count: number): string {
  if (count === 1) return label;
  if (/(s|x|z|ch|sh)$/i.test(label)) return `${label}es`;
  if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}

function clip(chip: string): string {
  return chip.length <= CHIP_MAX ? chip : `${chip.slice(0, CHIP_MAX - 1).trimEnd()}…`;
}

const key = (role: GameRole): string => role.label.trim().toLowerCase();

/** Ne-hrdinské role podle popisku; táž postava ve dvou rolích se sečte. */
function cast(spec: GameSpecV1): Map<string, { readonly label: string; readonly count: number }> {
  const roles = new Map<string, { label: string; count: number }>();
  for (const role of spec.roles) {
    if (role.kind === 'player') continue;
    const seen = roles.get(key(role));
    if (seen === undefined) roles.set(key(role), { label: role.label.trim(), count: role.count });
    else seen.count += role.count;
  }
  return roles;
}

const hero = (spec: GameSpecV1): string | null => spec.roles.find((role) => role.kind === 'player')?.label.trim() ?? null;

type Params = Readonly<Record<string, unknown>>;

const PACE = { speed: ['slower', 'faster'], difficulty: ['easier', 'harder'] } as const;

/** Posun rychlosti nebo obtížnosti ovládání; chybějící stupeň je výchozí `normal` (tak ho čte jádro). */
function pace(was: Params, now: Params): string | null {
  for (const [field, [down, up]] of Object.entries(PACE)) {
    if (was[field] === undefined && now[field] === undefined) continue;
    const before = RANK[String(was[field] ?? 'normal')];
    const after = RANK[String(now[field] ?? 'normal')];
    if (before !== undefined && after !== undefined && before !== after) return after > before ? up : down;
  }
  return null;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Rozdíl remixu proti rodiči: nejvýš `MAX_CHIPS` čipů, `[]` = na hře není nic vidět. */
export function remixChips(parent: GameSpecV1, child: GameSpecV1): string[] {
  const chips: string[] = [];
  const before = cast(parent);
  const after = cast(child);

  // Nové prostředí první: „reskin“ přejmenuje i všechny role a jejich čipy by ho vytlačily.
  if (parent.theme.setting.trim().toLowerCase() !== child.theme.setting.trim().toLowerCase()) chips.push(child.theme.setting.trim());

  for (const [name, role] of after) if (!before.has(name)) chips.push(`+${plural(role.label, role.count)}`);

  const paramsBefore = (parent.controlParams ?? {}) as Params;
  const paramsAfter = (child.controlParams ?? {}) as Params;
  const shift = child.control === parent.control ? pace(paramsBefore, paramsAfter) : null;
  if (shift !== null) chips.push(shift);

  const heroNow = hero(child);
  if (heroNow !== null && heroNow.toLowerCase() !== hero(parent)?.toLowerCase()) chips.push(`play as ${heroNow}`);

  if (child.theme.weather !== undefined && child.theme.weather !== parent.theme.weather) chips.push(child.theme.weather === 'clear' ? 'clear sky' : child.theme.weather);
  if (child.theme.timeOfDay !== undefined && child.theme.timeOfDay !== parent.theme.timeOfDay) chips.push(child.theme.timeOfDay);

  for (const [name, role] of after) {
    const old = before.get(name);
    if (old !== undefined && old.count !== role.count) chips.push(`${role.count > old.count ? 'more' : 'fewer'} ${plural(role.label, 2)}`);
  }

  for (const addon of child.addons ?? []) if (!(parent.addons ?? []).includes(addon)) chips.push(`+${humanize(addon)}`);
  if (child.control !== undefined && child.control !== parent.control) chips.push(`${humanize(child.control)} controls`);

  const parentMechanics = new Set(parent.mechanics.map((mechanic) => mechanic.id));
  const added = child.mechanics.filter((mechanic) => !parentMechanics.has(mechanic.id));
  for (const mechanic of added) chips.push(`+${humanize(mechanic.id)}`);
  // Jiná čísla téhož pravidla („harder“ posune parametr mechaniky nebo ladění ovládání): směr z nich nejde poznat obecně.
  // Jen ladicí čísla (`tuning`); seznam překážek ovládání jsou postavy a ty už mají své čipy.
  const retuned = child.control === parent.control && !same(paramsBefore.tuning, paramsAfter.tuning);
  if (added.length === 0 && (retuned || !same(parent.mechanics, child.mechanics) || !same(parent.rules, child.rules) || !same(parent.objective, child.objective))) chips.push('new rules');

  for (const [name, role] of before) if (!after.has(name)) chips.push(`no ${plural(role.label, 2)}`);

  return [...new Set(chips.map(clip))].slice(0, MAX_CHIPS);
}

/** Štítek živé změny („+3 dogs · rain“); popisek přidané role bere ze specu hry, jinak jméno role jádra. */
export function liveLabel(patches: readonly LivePatch[], spec: GameSpecV1): string {
  const parts = patches.flatMap((patch): string[] => {
    if (patch.kind === 'spawn') {
      const label = spec.roles.find((role) => role.kind === patch.role)?.label.trim() ?? humanize(patch.role);
      return [`+${String(patch.count)} ${plural(label, patch.count)}`];
    }
    if (patch.kind === 'count') {
      if (patch.counter === 'health') return [`+${String(patch.amount)} ${patch.amount === 1 ? 'life' : 'lives'}`];
      if (patch.counter === 'time') return [`+${String(patch.amount)}s`];
      return [`+${String(patch.amount)} ammo`];
    }
    return [
      ...(patch.weather === undefined ? [] : [patch.weather === 'clear' ? 'clear sky' : patch.weather]),
      ...(patch.timeOfDay === undefined ? [] : [patch.timeOfDay]),
    ];
  });
  return parts.join(' · ');
}
