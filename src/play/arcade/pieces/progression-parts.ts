/** Common final generator stage: real geometry and rules, before addons. */
import type { GameSpecV1 } from '../../spec';
import type { ArcadeParts } from '../addons';
import type { BodyInit } from '../contract';
import { addPhaseBodies, type Dependency, phaseSpeed } from '../../compose/progression';
import { centerAt, courseOf, checkSteerLevel } from './steer';
import { GLIDE, glidePathOf, checkGlideLevel } from './glide';
import { FLAP } from './flap';
import { PLATFORM } from './platform';
import { walkerMapSchema, walkerPath, WALKER_CELL } from './walker';
import type { ObjectiveNode } from './objective-order';

function ordered(graph: readonly Dependency[]): Dependency[] {
  const remaining = [...graph], done = new Set<string>(), result: Dependency[] = [];
  while (remaining.length) {
    const index = remaining.findIndex(node => node.prerequisites.every(id => done.has(id)));
    if (index < 0) throw new Error('Cyclic objective graph');
    const node = remaining.splice(index, 1)[0]!; done.add(node.goal); result.push(node);
  }
  return result;
}

/** `builtForPercent`: rychlost, pro kterou generátor trať postavil (průběh P45C ji předá za odebranou rampu žánru). */
export function progressionParts(parts: ArcadeParts, spec: Pick<GameSpecV1, 'phases' | 'dependsOn' | 'roles' | 'rules' | 'controlParams'>, builtForPercent = 100): ArcadeParts {
  if (spec.phases === undefined && spec.dependsOn === undefined) return parts;
  if (spec.dependsOn && spec.rules?.some(rule => rule.do.some(effect => 'win' in effect))) return { ...parts, issues: ['A custom win rule would bypass objective dependencies'] };
  const control = parts.control.id;
  // Plošinovka (P46B T6): robot plánuje skoky a hroty rychlostí běhu fáze (`speed`), ne plným `PLATFORM.maxRun` –
  // s tím s fázemi 90–125 % vyhrál 4/8 (P45C T11).
  if (!['steer', 'glide', 'runner', 'walker', 'flap', 'platform'].includes(control)) return { ...parts, issues: [`Progression is not implemented for ${control}`] };
  if (parts.control.params.land !== undefined) return { ...parts, issues: ['Pacing is not implemented for landing'] };
  // Poletování nemá bezpečný pruh vedle cesty: fáze mu mění jen rychlost.
  if (control === 'flap' && spec.phases?.some(phase => phase.add !== undefined)) return { ...parts, issues: ['Phase bodies are not implemented for flap'] };
  try {
    // Fáze škálují poletování základ rychlosti `speed` (P45C T11); robot ho čte taky.
    if (spec.phases !== undefined && control === 'flap') {
      parts = { ...parts, control: { ...parts.control, params: { ...parts.control.params, speed: FLAP.speed } }, bot: { ...parts.bot, params: { ...parts.bot.params, speed: FLAP.speed } } };
    }
    // Plošinovce škálují nejvyšší rychlost běhu `speed`; robot ji čte taky, takže skoky plánuje rychlostí úseku.
    if (spec.phases !== undefined && control === 'platform') {
      parts = { ...parts, control: { ...parts.control, params: { ...parts.control.params, speed: PLATFORM.maxRun } }, bot: { ...parts.bot, params: { ...parts.bot.params, speed: PLATFORM.maxRun } } };
    }
    // Reserve longitudinal reaction/steering distance before adding faster phases.
    // Let drží kontrola úrovně (`checkGlideLevel`) na nejrychlejší fázi v každém bodě: natahuje se celý.
    // Řízení po odebrané rampě kontroluje každou zatáčku rychlostí její fáze (níže), takže stačí natažení nad vrchol rampy.
    const builtFor = control === 'glide' ? 100 : builtForPercent;
    const scale = Math.max(builtFor, ...(spec.phases?.map(phase => phase.speedPercent) ?? [])) / builtFor;
    // Plošinovka se nenatahuje: mezery staví generátor na dosah skoku a v pomalejším úseku by natažená byla za ním.
    if (control !== 'walker' && control !== 'platform' && scale > 1) {
      // Trať postavená na vrchol rampy (průběh P45C) se natáhne jen od první fáze rychlejší než ten vrchol:
      // pomalejší úseky si nechají hustotu, pro kterou je generátor postavil (celé natažení dělalo závod i běžce snadnými).
      const fast = builtFor > 100 ? spec.phases?.find(phase => phase.speedPercent > builtFor) : undefined;
      const from = fast === undefined ? 0 : Math.floor(parts.level.length * fast.start / 1000);
      const at = (n: number) => (from === 0 ? n * scale : n <= from ? n : from + (n - from) * scale);
      const stretch = (n: number) => Math.ceil(at(n));
      const level = { ...parts.level, length: stretch(parts.level.length), bodies: parts.level.bodies.map(body => {
        if (control === 'steer' && ['tire-barrier','island','rock','building'].includes(body.kind)) {
          const near = 2 * Math.floor(at(body.z - body.d / 2) / 2), far = 2 * Math.floor(at(body.z + body.d / 2) / 2);
          return { ...body, z: (near + far) / 2, d: far - near };
        }
        return { ...body, z: stretch(body.z), d: from === 0 || body.z > from ? Math.ceil(body.d * scale) : body.d };
      }), ...(parts.level.sectionStarts ? { sectionStarts: parts.level.sectionStarts.map(stretch) as [number, number] } : {}) };
      // Jen okruh ze vzorů (P46D T4) si po natažení nechá šířky úseků a pruh soupeřů; uložené hry bez `patterns` staví tentýž svět.
      const keepCourse = control === 'steer' && (spec.controlParams as { patterns?: number } | undefined)?.patterns === 1;
      const params = { ...parts.control.params, ...(control === 'steer' ? { course: keepCourse ? { ...(parts.control.params.course as object | undefined), ...courseOf(level) } : courseOf(level) } : {}), ...(control === 'glide' ? { path: glidePathOf(level) } : {}), ...(Array.isArray(parts.control.params.ramp) ? { ramp: parts.control.params.ramp.map(stretch) } : {}) };
      parts = { ...parts, level, control: { ...parts.control, params }, bot: { ...parts.bot, params: { ...parts.bot.params, ...(control === 'steer' || control === 'glide' ? params : {}), ...(control === 'flap' && Array.isArray(params.ramp) ? { ramp: params.ramp } : {}) } }, rules: parts.rules.map(rule => typeof rule.params.atZ === 'number' ? { ...rule, params: { ...rule.params, atZ: stretch(rule.params.atZ) } } : rule) };
    }
    const length = parts.level.length, course = control === 'steer' ? courseOf(parts.level) : undefined;
    const path = control === 'glide' ? glidePathOf(parts.level) : [];
    const map = control === 'walker' ? walkerMapSchema.parse({ size: parts.control.params.size, open: parts.control.params.open }) : undefined;
    const walkPath = map ? walkerPath(map, map.size + 1, (map.size - 2) * map.size + map.size - 2) : [];
    const point = (z: number) => {
      if (map) {
        const cell = walkPath.reduce((best, cell) => Math.abs(Math.floor(cell / map.size) * WALKER_CELL - z) < Math.abs(Math.floor(best / map.size) * WALKER_CELL - z) ? cell : best, walkPath[0]!);
        return { x: cell % map.size * WALKER_CELL, y: 0, z: Math.floor(cell / map.size) * WALKER_CELL };
      }
      const next = path.find(node => node.z >= z) ?? path.at(-1);
      return { x: course ? centerAt(course, z) : next?.x ?? 0, y: next ? next.y - GLIDE.size / 2 : 0, z };
    };
    let level = addPhaseBodies(parts.level, spec.phases, (_phase, role, ordinal, from, to) => {
      const z = Math.floor(from + (to - from) * (ordinal + 1) / 4), position = point(z);
      if (map && (position.z < from || position.z >= to)) throw new Error('Walker phase has no reachable cell; widen its section');
      // Obstacles flank the safe native path; they are real collision hazards.
      const body: BodyInit = { ...position, role, kind: role === 'collectible' ? 'coin' : 'crate', w: role === 'collectible' && !map ? 2 * (course?.halfWidth ?? GLIDE.bound) : 800, h: role === 'collectible' && control === 'glide' ? GLIDE.ceiling : 900, d: 500, solid: role === 'obstacle' };
      return role === 'obstacle' ? { ...body, x: position.x + (map ? 1400 : control === 'runner' ? 2000 : 4000) } : control === 'glide' ? { ...body, y: 0 } : body;
    });
    const rules = [...parts.rules];
    if (spec.phases?.some(phase => phase.add?.some(add => add.role === 'collectible')) && !rules.some(rule => rule.id === 'pickup')) rules.unshift({ id: 'pickup', params: {} });
    let bot = parts.bot;
    if (spec.dependsOn !== undefined || (map && level.bodies.some(body => body.role === 'collectible'))) {
      const sorted = ordered(spec.dependsOn ?? []), bodies = [...level.bodies], nodes: ObjectiveNode[] = [];
      const exitIndex = bodies.findIndex(body => body.role === 'goal');
      if (exitIndex < 0) throw new Error('Dependencies need a physical exit');
      for (const [index, dependency] of sorted.entries()) {
        const role = spec.roles.find(role => role.id === dependency.goal);
        if (!role || !['key', 'collectible', 'door', 'checkpoint'].includes(role.kind)) throw new Error(`Dependency ${dependency.goal} must name a key, collectible, door or checkpoint role`);
        const action = role.kind === 'door' ? 'open' : role.kind === 'checkpoint' ? 'reach' : 'collect';
        if (dependency.action !== undefined && dependency.action !== action) throw new Error(`Dependency ${dependency.goal} action conflicts with its physical role`);
        let position = point(Math.floor(length * (index + 1) / (sorted.length + 2)));
        if (map) {
          // Keep physical key locations independent of edge order: reversing the graph
          // really changes traversal, rather than merely renaming checkpoints.
          const original = spec.dependsOn!.findIndex(node => node.goal === dependency.goal);
          const cell = walkPath[Math.max(1, Math.floor((walkPath.length - 2) * (original + 1) / (sorted.length + 1)))]!;
          position = { x: cell % map.size * WALKER_CELL, y: 0, z: Math.floor(cell / map.size) * WALKER_CELL };
        }
        const body = bodies.length;
        // A walker gate is an openable object beside the route: it cannot wall off
        // a prerequisite after reversing the graph. Forward tracks span the route.
        bodies.push({ ...position, role: 'thing', kind: role.id, w: map ? 1000 : 2 * (course?.halfWidth ?? GLIDE.bound), h: control === 'glide' ? GLIDE.ceiling : 1800, d: 500, solid: action === 'open' && !map });
        nodes.push({ goal: dependency.goal, prerequisites: dependency.prerequisites, body, action });
      }
      if (map) for (let body = 0; body < bodies.length; body++) if (bodies[body]!.role === 'collectible') {
        bodies[body] = { ...bodies[body]!, role: 'thing' };
        nodes.push({ goal: '__item' + body, body, action: 'collect', prerequisites: [] });
      }
      nodes.push({ goal: '__finish', body: exitIndex, action: 'reach', prerequisites: nodes.map(node => node.goal) });
      const requireAll = rules.some(rule => rule.id === 'finish' && rule.params.allItems === true);
      const retained = rules.filter(rule => rule.id !== 'finish');
      retained.push({ id: 'objective_order', params: { nodes, ...(requireAll ? { allItems: true } : {}) } });
      rules.splice(0, rules.length, ...retained);
      level = { ...level, bodies };
      if (map) bot = { id: 'objective_walker_bot', params: { ...map, speed: parts.control.params.speed, nodes, ...(spec.phases ? { phases: spec.phases, phaseLength: length } : {}) } };
    }
    if (level.bodies.length + (level.spawnSlots ?? 0) > 256) throw new Error('Progression exceeds body budget');
    const maxScale = Math.max(...(spec.phases?.map(phase => phase.speedPercent) ?? [100])) / 100;
    const top = Number(parts.control.params.topSpeed);
    // Bez rampy (průběh P45C, `builtForPercent` > 100) jede zatáčka rychlostí své fáze; jinak nejrychlejší fáze přes výchozí rampu jako dřív.
    const phased = builtForPercent > 100 ? (z: number) => phaseSpeed(top, z, length, spec.phases) : undefined;
    const issues = control === 'steer' ? checkSteerLevel(level, Math.ceil(top * maxScale), phased) : control === 'glide' ? checkGlideLevel(level, Math.ceil(Number(parts.control.params.topSpeed) * maxScale)) : [];
    // Native runner spacing is designed for the fastest speed+existing ramp.
    // Reject faster pacing if its native verifier cannot establish enough reserve.
    const pacing = spec.phases ? { phases: spec.phases, length } : undefined;
    return { ...parts, level, rules, issues,
      control: pacing ? { id: 'phase_control', params: { base: parts.control, ...pacing } } : parts.control,
      bot: pacing && bot.id !== 'objective_walker_bot' ? { id: 'phase_bot', params: { base: bot, ...pacing } } : bot };
  } catch (error) { return { ...parts, issues: [error instanceof Error ? error.message : String(error)] }; }
}
