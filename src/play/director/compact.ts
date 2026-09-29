/**
 * Kompaktní první odpověď režiséra (P27D T2, C2 z `plans/P27/04-create-and-remix.md`).
 *
 * Model nepíše celý GameSpec, jen výběr: ovládání, doplňky, sadu prostředí,
 * místo, titul, popisky rolí a řádek cíle. Hru z toho složí `composeCompact`
 * nad šablonou ovládání (`draftForControl`), takže mechaniky, parametry
 * a ověření jsou vždy ty, které runtime hraje. Menší odpověď je celý smysl –
 * naměřeno živě, ne předpokládáno (`evals/play/fidelity/README.md`).
 *
 * Co výběr pojmenuje a šablona nemá (neznámá role, doplněk mimo tabulku
 * schopností), se zahodí, ne opraví: kompozice nikdy nevymyslí nic, co model
 * neřekl, a nic, co by hra neukázala.
 */

import { z } from 'zod';

import { canonicalHash } from '@/ir/worlddoc';
import { EMISSION_MODEL, type UpstreamRequest } from '@/model/prompt';

import { LOOK_IDS, type LookId } from '../arcade/look';
import { THINGS_MAX, modelRulesSchema, thingsSchema } from '../arcade/rules/schema';
import { CAPABILITIES } from '../capabilities';
import { draftForControl } from '../draft';
import { ADDONS, CONTROLS, ROLE_KINDS, readGameSpec, type ControlId, type GameRole, type GameSpecV1 } from '../spec';

import { strictSchema } from './answer-schema';
import { rulesPromptLines } from './prompt';
import type { DirectorRead } from './read';
import { examplesBlock, nearestExamples } from './retrieval';

const strictOf = (schema: z.ZodType): Record<string, unknown> => strictSchema(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>);

/** Role, kterou potřebují jen pravidla (klíč, dveře, zvon) – šablona ovládání ji nemá. */
const RULE_ROLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'label', 'count'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ROLE_KINDS.filter((kind) => kind !== 'player') },
    label: { type: 'string' },
    count: { anyOf: [{ type: 'integer', minimum: 1, maximum: 50 }, { type: 'null' }] },
  },
};

export const COMPACT_ANSWER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['plan', 'control', 'addons', 'look', 'setting', 'title', 'labels', 'goal', 'ruleRoles', 'things', 'rules'],
  properties: {
    plan: { type: 'string' },
    control: { type: 'string', enum: [...CONTROLS] },
    addons: { type: 'array', items: { type: 'string', enum: [...ADDONS] } },
    look: { anyOf: [{ type: 'string', enum: [...LOOK_IDS] }, { type: 'null' }] },
    setting: { type: 'string' },
    title: { type: 'string' },
    labels: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['role', 'label'], properties: { role: { type: 'string' }, label: { type: 'string' } } },
    },
    goal: { type: 'string' },
    ruleRoles: { type: 'array', maxItems: THINGS_MAX, items: RULE_ROLE_SCHEMA },
    things: strictOf(thingsSchema),
    rules: strictOf(modelRulesSchema),
  },
};

function controlLines(): string {
  return CONTROLS.map((id) => {
    const c = CAPABILITIES[id];
    const roles = id === 'tap_go' ? 'role ids from the starting point' : ['player', ...c.roles].join(', ');
    const addons = c.addons.length === 0 ? '' : `; addons ${c.addons.join('/')}`;
    return `- "${id}" (${c.cues}): roles ${roles}${addons}`;
  }).join('\n');
}

/** Systémový text bez věty; stavěný při volání, aby změna tabulky schopností prošla ven. */
export function compactSystemPrompt(): string {
  return [
    "Choose how the user's sentence plays. Never output code. Answer one JSON object {plan, control, addons, look, setting, title, labels, goal, ruleRoles, things, rules}.",
    'control: the control whose cues fit the main verb; "tap_go" is the tap-to-move grid (walk, pick up, use) for anything the others do not fit.',
    'addons: a 2nd verb of the sentence from that control\'s addons ("jump and shoot" = platform ["shoot"]), else [].',
    `look: the scene set that best shows the setting, or null: ${LOOK_IDS.join('|')}.`,
    'setting: where it happens, English, <=80 chars. title: <=80 chars.',
    'labels: [{role, label}] for the control\'s roles; the label is the 1–3 word English noun from the sentence the screen draws for that role, never an instruction. Skip a role the sentence says nothing about.',
    'goal: one English line <=80 chars saying how to win this control, in the sentence\'s words.',
    "Keep the user's nouns, numbers and names. Improve the starting point, do not copy it blindly.",
    'CONTROLS:',
    controlLines(),
    rulesPromptLines(),
  ].join('\n');
}

export const COMPACT_PROMPT_VERSION = canonicalHash(compactSystemPrompt());

/** Návrh ze slov ve tvaru kompaktní odpovědi – výchozí bod pro model. */
function startingPoint(draft: GameSpecV1): Record<string, unknown> {
  return {
    control: draft.control ?? 'tap_go',
    addons: draft.addons ?? [],
    look: draft.theme.look ?? null,
    setting: draft.theme.setting,
    title: draft.title,
    labels: draft.roles.map((role) => ({ role: role.id, label: role.label })),
    goal: draft.tutorial.goalLine,
  };
}

/** `examples` (P30A T8): za výchozí bod 3–5 ověřených her k podobným větám; bez nich je zpráva jako dřív. */
export function buildCompactRequest(sentence: string, draft: GameSpecV1, examples = false): UpstreamRequest {
  const user = `${sentence.trim()}\n\nStarting point (keep or improve): ${JSON.stringify(startingPoint(draft))}`;
  return {
    model: EMISSION_MODEL,
    system: compactSystemPrompt(),
    user: examples ? `${user}\n\n${examplesBlock(nearestExamples(sentence, draft.control ?? 'tap_go'))}` : user,
    outputSchema: COMPACT_ANSWER_SCHEMA,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Neprázdný řetězec oříznutý na `max`, jinak `null`. */
function textOf(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max).trim();
}

/** Přísný režim píše chybějící volitelné pole jako `null`; spec ho chce vynechané. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, withoutNulls(item)]));
}

/** Kompaktní odpověď → hratelný spec nad šablonou ovládání. */
export function composeCompact(sentence: string, body: unknown, seed = 1): DirectorRead {
  if (!isRecord(body)) return { ok: false, reason: 'NOT_AN_OBJECT', detail: `answer is ${Array.isArray(body) ? 'an array' : typeof body}` };
  const control = body.control;
  if (typeof control !== 'string' || !(CONTROLS as readonly string[]).includes(control)) {
    return { ok: false, reason: 'MALFORMED_SPEC', detail: `unknown control: ${String(control)}` };
  }
  const base = draftForControl(sentence, control as ControlId, seed);
  if (base === null) return { ok: false, reason: 'MALFORMED_SPEC', detail: `no template for ${control} with this sentence` };
  const spec = JSON.parse(JSON.stringify(base)) as GameSpecV1;

  const title = textOf(body.title, 80);
  if (title !== null) spec.title = title;
  const setting = textOf(body.setting, 80);
  if (setting !== null) spec.theme.setting = setting;
  if (typeof body.look === 'string' && (LOOK_IDS as readonly string[]).includes(body.look)) spec.theme.look = body.look as LookId;

  const allowed = CAPABILITIES[control as ControlId].addons;
  const addons = Array.isArray(body.addons) ? ADDONS.filter((addon) => allowed.includes(addon) && (body.addons as unknown[]).includes(addon)) : [];
  if (addons.length > 0) spec.addons = addons;
  else delete spec.addons;

  if (Array.isArray(body.labels)) {
    for (const entry of body.labels) {
      if (!isRecord(entry)) continue;
      const role = spec.roles.find((candidate) => candidate.id === entry.role);
      const label = textOf(entry.label, 60);
      if (role !== undefined && label !== null) role.label = label;
    }
  }

  const goal = textOf(body.goal, 80);
  if (goal !== null) {
    spec.tutorial.goalLine = goal;
    spec.objective.description = goal;
  }

  // Pravidla (P29A T7): přísný tvar nese volitelná pole jako null. Role jen pro
  // pravidla se přidají ke šabloně; co nesedí, odmítne `readGameSpec` – pravidlo
  // se nezahodí potichu, aby opravné kolo vědělo proč.
  const rules = Array.isArray(body.rules) ? body.rules : [];
  const things = Array.isArray(body.things) ? body.things : [];
  // Role zůstanou i bez pravidel: když se pravidla nedají složit (T8), opravné
  // kolo je dopíše nad specem, který jejich role už má.
  for (const entry of Array.isArray(body.ruleRoles) ? body.ruleRoles : []) {
    if (!isRecord(entry) || spec.roles.some((role) => role.id === entry.id)) continue;
    spec.roles.push({ ...(withoutNulls(entry) as GameRole), count: typeof entry.count === 'number' ? entry.count : 1 });
  }
  if (rules.length > 0) spec.rules = withoutNulls(rules) as GameSpecV1['rules'];
  if (things.length > 0) spec.things = withoutNulls(things) as GameSpecV1['things'];

  const result = readGameSpec(spec);
  if (!result.ok) return { ok: false, reason: result.reason, detail: result.issues.join('; ') };
  return { ok: true, spec: result.value };
}
