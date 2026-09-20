import type { SceneSpec } from './spec';

/** Independent, human-authored prompt oracle. Never derive this from planner output. */
export interface RequirementExpectation {
  readonly quote: string;
  readonly count: number;
  readonly polarity: 'required' | 'forbidden';
  readonly attributes?: readonly { name: string; value: string }[];
}

/** Semantic ledger coverage, explicitly not visual recognizability. */
export function auditRequirements(spec: SceneSpec, expected: readonly RequirementExpectation[]): string[] {
  const failures: string[] = [];
  for (const oracle of expected) {
    const matches = spec.requirements.filter((r) => r.provenance.kind === 'requested' && r.provenance.quote === oracle.quote && r.polarity === oracle.polarity);
    if (matches.length !== 1) { failures.push(`Expected one requirement for: ${oracle.quote}`); continue; }
    const requirement = matches[0];
    if (requirement.count !== oracle.count) failures.push(`Expected ${oracle.count} instances for: ${oracle.quote}`);
    for (const instanceId of requirement.instanceIds) {
      const instance = spec.instances.find((i) => i.stableId === instanceId);
      for (const attribute of oracle.attributes ?? [])
        if (!instance?.attributes.some((a) => a.name === attribute.name && a.value === attribute.value)) failures.push(`Missing ${attribute.name}=${attribute.value} on ${instanceId}`);
    }
  }
  return failures;
}

/**
 * **Orákulum porotcovského korpusu (P22 T2)** — citáty jsou doslovné podřetězce
 * věty (`evals/worldstream/gauntlet/oracles.json`), takže se srovnávají
 * s `provenance.quote` požadavků, ne s tím, co model „myslel".
 */
export const ORACLE_RELATIONS = ['on', 'under', 'inside', 'behind', 'over', 'beside'] as const;
export type OracleRelation = (typeof ORACLE_RELATIONS)[number];

export interface SemanticRelationExpectation {
  readonly subject: string;
  readonly relation: OracleRelation;
  readonly object: string;
}

export interface SemanticOracle {
  readonly required: readonly { readonly quote: string; readonly count: number }[];
  readonly forbidden?: readonly string[];
  readonly relations?: readonly SemanticRelationExpectation[];
}

export interface SemanticScore {
  readonly presence: number;
  readonly counts: number;
  readonly relations: number;
  readonly forbidden: number;
  readonly score: number;
  readonly failures: string[];
}

type SpecRelation = SceneSpec['relations'][number]['relation'];

/**
 * Jak se orákulum mapuje na to, co `SceneSpec` umí říct. `under` je obrácené
 * `on`; `over` totéž co `on`. `beside` a `behind` spec nemá — obojí se bere
 * jako blízkost v libovolném směru, protože `near`/`against` směr nenesou;
 * směr proto měří jen `on`/`under`/`over`/`inside`.
 */
const RELATION_MAP: Record<OracleRelation, readonly { readonly relation: SpecRelation; readonly reversed: boolean }[]> = {
  on: [{ relation: 'on', reversed: false }],
  over: [{ relation: 'on', reversed: false }],
  under: [{ relation: 'on', reversed: true }],
  inside: [{ relation: 'inside', reversed: false }],
  beside: [{ relation: 'near', reversed: false }, { relation: 'near', reversed: true }, { relation: 'against', reversed: false }, { relation: 'against', reversed: true }],
  behind: [{ relation: 'near', reversed: false }, { relation: 'near', reversed: true }, { relation: 'against', reversed: false }, { relation: 'against', reversed: true }],
};

const normalize = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

type Requirement = SceneSpec['requirements'][number];

/**
 * Citát orákula je kratší než citát plánovače („lanterns" proti „exactly three
 * lanterns"), takže rozhoduje obsažení — a vyhrává nejbližší text, který citát
 * obsahuje: „table" patří k „A table", ne k „a cat under the table".
 */
function matchDistance(requirement: Requirement, quote: string): number | null {
  const wanted = normalize(quote);
  const { provenance, description } = requirement;
  const candidates = [description, ...(provenance.kind === 'requested' ? [provenance.quote] : [])].map(normalize);
  const distances = candidates
    .filter((c) => ` ${c} `.includes(` ${wanted} `) || ` ${wanted} `.includes(` ${c} `))
    .map((c) => Math.abs(c.length - wanted.length));
  return distances.length === 0 ? null : Math.min(...distances);
}

function requiredMatches(spec: SceneSpec, quote: string): Requirement[] {
  const scored = spec.requirements
    .filter((r) => r.polarity === 'required')
    .map((r) => ({ r, distance: matchDistance(r, quote) }))
    .filter((entry): entry is { r: Requirement; distance: number } => entry.distance !== null);
  const best = Math.min(...scored.map((entry) => entry.distance));
  return scored.filter((entry) => entry.distance === best).map((entry) => entry.r);
}

function instancesFor(spec: SceneSpec, quote: string): Set<string> {
  return new Set(requiredMatches(spec, quote).flatMap((r) => r.instanceIds));
}

/** Vztah stojí mezi instancemi, jejichž požadavek cituje `subject`, a těmi, které cituje `object`. */
export function auditRelations(spec: SceneSpec, expected: readonly SemanticRelationExpectation[]): string[] {
  const failures: string[] = [];
  for (const wanted of expected) {
    const subjects = instancesFor(spec, wanted.subject);
    const objects = instancesFor(spec, wanted.object);
    const found = spec.relations.some((r) => RELATION_MAP[wanted.relation].some(({ relation, reversed }) => {
      const [from, to] = reversed ? [r.targetId, r.subjectId] : [r.subjectId, r.targetId];
      return r.relation === relation && subjects.has(from) && objects.has(to);
    }));
    if (!found) failures.push(`Missing relation: ${wanted.subject} ${wanted.relation} ${wanted.object}`);
  }
  return failures;
}

/** Zakázaný objekt je přítomný, když ho cituje požadavek s instancemi, nebo když jeho jméno nese `stableId`. */
export function auditForbidden(spec: SceneSpec, quotes: readonly string[]): string[] {
  const failures: string[] = [];
  for (const quote of quotes) {
    const compact = normalize(quote).replace(/ /g, '');
    const present = requiredMatches(spec, quote).some((r) => r.instanceIds.length > 0)
      || spec.instances.some((i) => i.stableId.toLowerCase().includes(compact));
    if (present) failures.push(`Forbidden object present: ${quote}`);
  }
  return failures;
}

const ratio = (passed: number, total: number): number => (total === 0 ? 1 : passed / total);

/** Čtyři složky se stejnou váhou; prázdná složka orákula je 1,0, protože nic nechtěla. */
export function scoreSemantics(spec: SceneSpec, oracle: SemanticOracle): SemanticScore {
  const failures: string[] = [];
  let present = 0;
  let counted = 0;
  for (const item of oracle.required) {
    const matches = requiredMatches(spec, item.quote);
    if (matches.length === 0) { failures.push(`Missing requirement for: ${item.quote}`); continue; }
    present += 1;
    const count = matches.reduce((sum, r) => sum + r.count, 0);
    if (count === item.count) counted += 1;
    else failures.push(`Expected ${item.count} instances for: ${item.quote}`);
  }
  const relationFailures = auditRelations(spec, oracle.relations ?? []);
  const forbiddenFailures = auditForbidden(spec, oracle.forbidden ?? []);
  failures.push(...relationFailures, ...forbiddenFailures);
  const presence = ratio(present, oracle.required.length);
  const counts = ratio(counted, oracle.required.length);
  const relations = ratio((oracle.relations?.length ?? 0) - relationFailures.length, oracle.relations?.length ?? 0);
  const forbidden = ratio((oracle.forbidden?.length ?? 0) - forbiddenFailures.length, oracle.forbidden?.length ?? 0);
  return { presence, counts, relations, forbidden, score: (presence + counts + relations + forbidden) / 4, failures };
}
