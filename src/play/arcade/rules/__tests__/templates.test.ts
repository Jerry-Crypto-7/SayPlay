/**
 * Knihovna šablon pravidel (P45B T8). Šablona, jejíž fáze nikdy nenastane, se rozbalí bez
 * chyby a projde i schématem – proto test každou šablonu rozbalí do referenčního světa
 * (dvorek pro `goal`, aréna na přežití pro `overlay`) a pustí na ni celé ověření včetně
 * `logic_proved`. Dál hlídá, že dnešních šest šablon se po rozbalení nezměnilo (zmrazený
 * JSON), že každý cíl slovníku má šablonu nebo jmenovaný důvod, proč ne, a že výběr podle
 * os jde v pořadí tabulky.
 */

import { describe, expect, it } from 'vitest';

import { type GameSpecV1, readGameSpec } from '@/play/spec';
import vocabulary from '@/play/vocab/verbs.json';

import arenaFixture from '../../__fixtures__/arena.json';
import collectGate from '../../__fixtures__/rules/collect-gate.json';
import { arcadeWorldOf } from '../../compile';
import { ARCADE_LIMITS } from '../../contract';
import { type ArcadeVerdict, verifyArcade } from '../../verify';
import { logicSchema, ruleIssues, rulesSchema, thingsSchema } from '../schema';
import { RULE_TEMPLATES, type RuleTemplate, TEMPLATE_NAMES, type TemplateName, type TemplateParts, type TemplateSlot, expandTemplate, templateParts, templatesFor } from '../templates';
import frozen from './__fixtures__/templates-v1.json';

/** Tři rozmístění na svět, jako u robota logiky. */
const SEEDS = [1, 2, 3];

const table = (name: TemplateName): RuleTemplate => RULE_TEMPLATES[name];

// ---------------------------------------------------------------------------
// Referenční světy

/** Role id = jméno slotu; druh a popisek podle slotu, počet a druh šablona přebije. */
const SLOT_ROLE: Readonly<Record<TemplateSlot, { readonly kind: string; readonly label: string }>> = {
  item: { kind: 'item', label: 'wooden crate' },
  goal: { kind: 'destination', label: 'old well' },
  target: { kind: 'target', label: 'straw dummy' },
  lever: { kind: 'switch', label: 'rusty lever' },
  door: { kind: 'door', label: 'oak gate' },
  enemy: { kind: 'patrol', label: 'grey goblin' },
  hazard: { kind: 'hazard', label: 'lava pool' },
  exit: { kind: 'exit', label: 'stone stairs' },
  zone: { kind: 'zone', label: 'chalk circle' },
};

type Override = Readonly<Partial<Record<TemplateSlot, { readonly kind?: string; readonly count?: number }>>>;

/** Kde šablona hraje a čím se role liší od `SLOT_ROLE` (mez „3“ šablony = tři těla role). */
const REFERENCE: Readonly<Record<TemplateName, { readonly host: 'yard' | 'arena'; readonly roles?: Override }>> = {
  carry: { host: 'yard' },
  throw: { host: 'yard' },
  push: { host: 'yard', roles: { item: { kind: 'prop' }, goal: { kind: 'switch' } } },
  open: { host: 'yard', roles: { goal: { kind: 'exit' } } },
  give: { host: 'yard' },
  stack: { host: 'yard', roles: { item: { count: 3 }, goal: { kind: 'zone' } } },
  collect_unlock: { host: 'yard', roles: { item: { kind: 'collectible', count: 3 } } },
  boss_finale: { host: 'yard', roles: { enemy: { count: 3 }, target: { kind: 'chaser' } } },
  escape_countdown: { host: 'yard' },
  race_clock: { host: 'yard', roles: { zone: { kind: 'checkpoint', count: 2 } } },
  rescue_then_flee: { host: 'yard', roles: { item: { kind: 'key' }, enemy: { kind: 'chaser' } } },
  defend_base: { host: 'yard' },
  combo_window: { host: 'yard', roles: { item: { kind: 'collectible', count: 3 } } },
  build_floors: { host: 'yard', roles: { item: { count: 3 } } },
  catch_count: { host: 'yard' },
  chores_rush: { host: 'yard', roles: { target: { count: 2 } } },
  waves_survive: { host: 'arena', roles: { enemy: { kind: 'hazard' } } },
  treasure_rush: { host: 'arena', roles: { item: { kind: 'collectible' } } },
  reinforcements: { host: 'arena' },
  coin_shower: { host: 'arena', roles: { item: { kind: 'collectible' } } },
};

const ROLES: Readonly<Record<TemplateSlot, string>> = Object.fromEntries(Object.keys(SLOT_ROLE).map((slot) => [slot, slot])) as Record<TemplateSlot, string>;

const { rules: _rules, roles: _roles, ...YARD_BASE } = collectGate;
/** Aréna na přežití 30 s: výhru drží hra (`survive_time`), šablona přidává jen průběh. */
const ARENA_BASE = {
  ...arenaFixture,
  controlParams: { density: 'sparse', goal: 'survive', seconds: 30 },
  objective: { ...arenaFixture.objective, seconds: 30 },
  mechanics: [],
};

function specOf(name: TemplateName, parts: TemplateParts): unknown {
  const reference = REFERENCE[name];
  const roles = table(name).slots.map((slot) => ({ id: ROLES[slot], label: SLOT_ROLE[slot].label, kind: SLOT_ROLE[slot].kind, ...reference.roles?.[slot] }));
  const base = reference.host === 'yard' ? YARD_BASE : ARENA_BASE;
  return {
    ...base,
    roles: [{ id: 'player', kind: 'player', label: 'scout' }, ...roles],
    rules: parts.rules,
    ...(parts.things.length === 0 ? {} : { things: parts.things }),
    ...(parts.logic === undefined ? {} : { logic: parts.logic }),
  };
}

function worldOf(name: TemplateName, parts: TemplateParts, seed: number) {
  const spec = readGameSpec(specOf(name, parts));
  if (!spec.ok) throw new Error(`${name}: ${spec.issues.join('; ')}`);
  const made = arcadeWorldOf(spec.value as GameSpecV1, seed);
  if (!made.ok) throw new Error(`${name}: ${made.issues.join('; ')}`);
  return made.world;
}

const partsOf = (name: TemplateName): TemplateParts => templateParts(name, ROLES) as TemplateParts;

function verified(name: TemplateName, seed: number): ArcadeVerdict {
  return verifyArcade(worldOf(name, partsOf(name), seed));
}

// ---------------------------------------------------------------------------
// Tabulka

/** Druhy kostek logiky, které šablona používá. */
function constructsOf(template: RuleTemplate): string[] {
  const logic = template.logic;
  const kinds = [
    (logic?.vars ?? []).length > 0 ? 'var' : null,
    (logic?.timers ?? []).length > 0 ? 'timer' : null,
    (logic?.phases ?? []).length > 0 ? 'phase' : null,
    (logic?.events ?? []).length > 0 ? 'event' : null,
    template.rules.some((rule) => rule.do.some((effect) => 'wave' in effect)) ? 'wave' : null,
  ];
  return kinds.filter((kind): kind is string => kind !== null);
}

describe('the rule template table', () => {
  it('the six P29A templates come first and expand exactly as frozen before T8', () => {
    expect(TEMPLATE_NAMES.slice(0, 6)).toEqual(Object.keys(frozen.templates));
    for (const [key, entry] of Object.entries(frozen.templates)) {
      const name = key as TemplateName;
      expect({ verbs: table(name).verbs, slots: table(name).slots }).toEqual({ verbs: entry.verbs, slots: entry.slots });
      // Bajt po bajtu i pořadím klíčů: rozbalení jde do specu hry (`compose/drive.ts`).
      expect(JSON.stringify(expandTemplate(name, frozen.roles))).toBe(JSON.stringify(entry.rules));
      expect(templateParts(name, frozen.roles)).toEqual({ rules: entry.rules, things: [] });
    }
  });

  it('has at least 15 templates, 9 of them with logic, every logic construct in at least two', () => {
    const constructs = TEMPLATE_NAMES.map((name) => constructsOf(table(name)));
    expect(TEMPLATE_NAMES.length).toBeGreaterThanOrEqual(15);
    expect(constructs.filter((kinds) => kinds.length > 0).length).toBeGreaterThanOrEqual(9);
    for (const kind of ['var', 'timer', 'phase', 'event', 'wave']) expect(constructs.filter((kinds) => kinds.includes(kind)).length, kind).toBeGreaterThanOrEqual(2);
  });

  it.each(TEMPLATE_NAMES)('%s: budget, kind, axes and slots agree with its rules', (name) => {
    const template = table(name);
    expect(template.budget).toBe(template.rules.length);
    expect(template.verbs.length).toBeGreaterThan(0);
    for (const axis of template.axes) expect(vocabulary.targets).toContain(axis);
    const wins = template.rules.some((rule) => rule.do.some((effect) => 'win' in effect));
    const loses = template.rules.some((rule) => rule.do.some((effect) => 'lose' in effect));
    // Goal šablona hru vyhrává sama; overlay výhru ani prohru nesahá – přidává jen průběh.
    expect({ kind: template.kind, wins, loses: template.kind === 'overlay' ? loses : false }).toEqual({ kind: template.kind, wins: template.kind === 'goal', loses: false });
    const text = JSON.stringify([template.rules, template.things ?? []]);
    const used = [...new Set([...text.matchAll(/"\$([a-z]+)"/g)].map((match) => match[1]))].sort();
    expect(used).toEqual([...template.slots].sort());
  });

  it.each(TEMPLATE_NAMES)('%s expands into valid rules, logic and things for its roles', (name) => {
    const template = table(name);
    expect(templateParts(name, {})).toBeNull();
    const parts = partsOf(name);
    expect(JSON.stringify(parts)).not.toContain('$');
    expect(rulesSchema.safeParse(parts.rules).success).toBe(true);
    expect(thingsSchema.safeParse(parts.things).success).toBe(true);
    if (parts.logic !== undefined) expect(logicSchema.safeParse(parts.logic).success).toBe(true);
    expect((parts.logic === undefined) === (template.logic === undefined)).toBe(true);
    const game = { yard: template.kind === 'goal', ...(parts.logic === undefined ? {} : { logic: parts.logic }) };
    expect(ruleIssues(parts.rules, parts.things, new Set(template.slots.map((slot) => ROLES[slot])), game)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ověření v referenčním světě

describe('every template passes verification in its reference world', () => {
  it.each(TEMPLATE_NAMES)('%s', (name) => {
    const logic = constructsOf(table(name)).length > 0;
    for (const seed of SEEDS) {
      const verdict = verified(name, seed);
      expect({ seed, outcome: verdict.bot.outcome, failures: verdict.failures }).toEqual({ seed, outcome: 'won', failures: [] });
      expect(verdict.bot.tick).toBeLessThanOrEqual(ARCADE_LIMITS.maxTicks);
      expect(verdict.idle.outcome).not.toBe('won');
      // Šablona s logikou kostky opravdu dokazuje: každá deklarovaná i každá vlna má svědka změny.
      expect(verdict.logic.length > 0).toBe(logic);
      for (const proof of verdict.logic) expect({ seed, kind: proof.kind, id: proof.id, changed: proof.changed }).toEqual({ seed, kind: proof.kind, id: proof.id, changed: true });
      expect(verdict.verbs.every((proof) => proof.changed)).toBe(true);
    }
  });

  it('a template whose phase never comes expands and validates cleanly – only verification catches it', () => {
    // Klid by skončil až po 5000 tikách: aréna na přežití vyhraje dřív (30 s) a vlna nepřijde.
    const parts = partsOf('waves_survive');
    const late: TemplateParts = { ...parts, rules: parts.rules.map((rule, index) => (index === 0 ? { ...rule, when: { every: 5000 } } : rule)) };
    expect(ruleIssues(late.rules, late.things, new Set(['enemy']), { logic: late.logic })).toEqual([]);
    const verdict = verifyArcade(worldOf('waves_survive', late, 1));
    expect(verdict.bot.outcome).toBe('won');
    expect(verdict.failures).toEqual(expect.arrayContaining([expect.stringContaining('LOGIC_UNPROVED:phase:wave'), expect.stringContaining('LOGIC_UNPROVED:wave:swarm')]));
    expect(verdict.publishEligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Osy slovníku

/** Cíle slovníku, které žádná šablona nehraje, a proč. */
const NO_TEMPLATE: Readonly<Record<string, string>> = {
  'move:run': 'movement is the control the draft picks (runner); a rule cannot change how the hero moves',
  'move:jump': 'movement is the control the draft picks (platform); a rule cannot change how the hero moves',
  'move:flap': 'movement is the control the draft picks (flap); a rule cannot change how the hero moves',
  'move:drive': 'movement is the control the draft picks (steer); a rule cannot change how the hero moves',
  'move:roam': 'movement is the control the draft picks (move_free); a rule cannot change how the hero moves',
  'move:glide': 'movement is the control the draft picks (glide); a rule cannot change how the hero moves',
  'move:walk': 'movement is the control the draft picks (walker); a rule cannot change how the hero moves',
  'move:ball': 'movement is the control the draft picks (ball); a rule cannot change how the hero moves',
  'action:shoot': 'a hit needs a projectile, which only the shooter piece and +shoot fire; the yard of goal templates has none (a shooter overlay is left to the measured cells of T9)',
  'action:beat': 'the beat is the rhythm piece clock; rules see ticks, not the song',
  'action:duel': 'a one-on-one opponent needs the duel piece AI; a rule body does not fight back',
  'objective:land': 'touchdown is judged by the glide and voyage pieces; the rules language has no landing trigger',
};

describe('vocabulary axes', () => {
  it('every target of verbs.json has a template or a named reason why not', () => {
    const covered = new Set<string>(TEMPLATE_NAMES.flatMap((name) => table(name).axes));
    const missing = vocabulary.targets.filter((target) => !covered.has(target) && !(target in NO_TEMPLATE));
    expect(missing).toEqual([]);
    // Důvod u cíle, který šablona mezitím má, by lhal.
    expect(Object.keys(NO_TEMPLATE).filter((target) => covered.has(target) || !vocabulary.targets.includes(target))).toEqual([]);
  });

  it('templatesFor picks by any axis within the rule budget, in table order', () => {
    expect(templatesFor(['objective:survive'], ARCADE_LIMITS.maxRules)).toEqual(['defend_base', 'reinforcements', 'waves_survive']);
    expect(templatesFor(['objective:escape', 'action:deliver'], ARCADE_LIMITS.maxRules)).toEqual(['carry', 'give', 'escape_countdown', 'rescue_then_flee', 'coin_shower']);
    expect(templatesFor(['action:deliver', 'objective:escape'], ARCADE_LIMITS.maxRules)).toEqual(templatesFor(['objective:escape', 'action:deliver'], ARCADE_LIMITS.maxRules));
    // Rozpočet: šablona o čtyřech pravidlech se do tří nevejde, ta o třech ano.
    expect(templatesFor(['objective:survive', 'objective:escape'], 3)).toEqual(['reinforcements', 'coin_shower']);
    expect(templatesFor(['objective:collect'], 3)).toEqual(['collect_unlock', 'treasure_rush']);
    expect(templatesFor([], ARCADE_LIMITS.maxRules)).toEqual([]);
    expect(templatesFor(['move:run'], ARCADE_LIMITS.maxRules)).toEqual([]);
  });
});
