/**
 * **Demo svět pro sady nad worldstreamovými route.**
 *
 * Fixtura je sdílená schválně: relace (`sessions.test.ts`) i druhá věta
 * (`changes.test.ts`) mluví o **témž** světě, a dvě kopie by se rozešly hned,
 * jak se pohne kontrakt compileru — jedna sada by pak zelenala nad světem,
 * který druhá už neumí postavit.
 *
 * ## Malá schválně
 *
 * Tři objekty, ne pět. Nesoudí se jí geometrie — jen to, že generace dojde na
 * konec a vydá po cestě tři rámce ve správném pořadí. Kdyby fixtura rostla,
 * začnou tyhle soubory červenat na změnách compileru, které se route netýkají.
 *
 * Svět projde **skutečným** compilerem a jeho certifikací, takže
 * `stored.blueprint.world` nese vyřešeného svědka a zapečetěný `simHash` —
 * tedy přesně to, co potřebuje patch řetěz v commitu druhé věty.
 */

import { GEOM_VERSION } from '@/geom/program';
import type { UpstreamRequest } from '@/model/prompt';
import type { PlannerEmission } from '@/model/worldstream-intent';
import {
  newSessionSeed,
  openSession,
  runGeneration,
  serverGrammar,
  type StoredSession,
} from '@/worldstream/sessions';

export const PLAN: PlannerEmission = {
  intent: {
    setting: 'a salt flat with one iron mast standing in the middle of it',
    mood: 'bright, flat, wind-scoured',
    spatialThesis:
      'Nothing interrupts the ground for a kilometre except the mast, so the flat reads as one plane and the mast as the only measure of its size.',
    actors: ['the surveyor'],
    heroObjects: ['the iron mast'],
    interactions: ['the surveyor walks to the mast and the horizon does not change'],
    unsupported: ['the salt crust is a surface, not a material that breaks underfoot'],
  },
  objects: [
    {
      stableId: 'saltFlat',
      label: 'the salt flat',
      synonyms: ['the flat', 'the ground', 'the salt'],
      role: 'terrain',
      importance: 2,
    },
    {
      stableId: 'ironMast',
      label: 'the iron mast',
      synonyms: ['the mast', 'the tower', 'the pole'],
      role: 'hero',
      importance: 3,
    },
    {
      stableId: 'saltWind',
      label: 'the wind off the salt',
      synonyms: ['the wind', 'the haze'],
      role: 'effect',
      importance: 0,
    },
  ],
};

export const ANSWER: Record<string, unknown> = {
  geometry: {
    version: GEOM_VERSION,
    nodes: [
      { kind: 'terrain', variant: 'plateau', extent: [40, 40], amplitude: 0.1, seed: 11 },
      { kind: 'group', children: [0] },
    ],
    root: 1,
  },
  shapes: [
    {
      shapeId: 'mastPost',
      stableId: 'ironMast',
      nodes: [
        { kind: 'prism', sides: 4, radius: 0.24, height: 3.2 },
        { kind: 'taper', child: 0, axis: 'y', amount: 0.35 },
      ],
      root: 1,
      targetBounds: { min: [-0.3, -1.7, -0.3], max: [0.3, 1.7, 0.3] },
      anchors: [{ name: 'tip', at: [0, 1.6, 0], normal: [0, 1, 0] }],
      materialIntent: 'metal',
      priority: 9,
    },
  ],
  placements: [
    {
      stableId: 'saltFlat',
      source: { kind: 'geom', node: 0 },
      targetBounds: { min: [-20, -0.2, -20], max: [20, 0.2, 20] },
    },
    {
      stableId: 'ironMast',
      source: { kind: 'shape', shapeId: 'mastPost' },
      targetBounds: { min: [-0.3, 0, -0.3], max: [0.3, 3.4, 0.3] },
    },
  ],
  world: {
    irVersion: 'v1',
    simRevision: 0,
    lookRevision: 0,
    sim: {
      layout: { width: 12, height: 8 },
      grid: { cell: 1 },
      // ⚠ **`saltPad` a `sparePad` jsou tu kvůli `T35-preservedattr` a jsou to
      // dva různé případy, ne jeden.** `saltPad` si **nárokuje** entita
      // `saltFlat`, tedy objekt, takže zápis na ten socket ten objekt jmenuje,
      // aniž ho cesta obsahuje. `sparePad` si nenárokuje **nikdo** — a to je
      // ve skutečném skladu častější, než by se čekalo: `c04` má takové dva
      // ze šesti. Nepřiřaditelný zápis seznam schválně nevyprazdňuje.
      sockets: { startPad: [1, 4], mastPad: [10, 4], saltPad: [4, 2], sparePad: [6, 6] },
      collisionAabb: { surveyor: [1, 4, 1, 1], mastBase: [10, 4, 1, 1] },
      entities: {
        surveyor: { role: 'actor', socket: 'startPad', state: 'idle' },
        mastBase: { role: 'goal', socket: 'mastPad', state: 'shut' },
        saltFlat: { role: 'terrain', socket: 'saltPad', state: 'dry' },
      },
      state: { counters: {}, flags: {}, timers: {}, zones: {}, slots: 0 },
      rules: {
        reach: {
          phase: 0,
          priority: 0,
          event: { kind: 'onEnterZone', entity: 'surveyor', zone: 'mastPad' },
          condition: null,
          actions: [{ kind: 'win' }],
        },
        // Pravidlo, jehož **uložené tělo** jmenuje objekt, kterého se cesta
        // `remove /sim/rules/guard` nedotkne ani slovem (`T35-preservedattr`).
        guard: {
          phase: 0,
          priority: 1,
          event: { kind: 'onEnterZone', entity: 'surveyor', zone: 'saltPad' },
          condition: null,
          actions: [{ kind: 'setState', target: 'saltFlat', state: 'disturbed' }],
        },
      },
    },
    look: {
      modules: { mastBase: { family: 'panel', params: { thickness: 0.18 } } },
      palette: 'moss',
      lightRig: 'rim',
      atmosphere: 'clear',
      materialRoles: {},
      camera: { kind: 'orbit' },
      audio: {},
    },
  },
};

/**
 * Emitor, který odpovídá **z ruky, ne od poskytovatele**.
 *
 * První volání je záměr, druhé blueprint — pořadím, ne obsahem požadavku:
 * kdyby se rozlišovalo podle textu, sada by červenala pokaždé, když někdo
 * přepíše systémovou zprávu, což je práce planneru, ne relace.
 */
export function scripted(): { emit: (request: UpstreamRequest) => Promise<unknown>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    emit: async () => {
      calls += 1;
      return calls === 1 ? { intent: PLAN.intent, objects: PLAN.objects } : ANSWER;
    },
  };
}

export function grammar() {
  const read = serverGrammar();
  if (typeof read === 'string') throw new Error(`the frozen protocol could not be read: ${read}`);
  return read;
}

/** Relace naplněná scriptovaným emitorem, tedy bez peněz a bez `.env`. */
export async function generated(): Promise<StoredSession> {
  // Vlastní `sessionId` je i vlastní kbelík, takže kvóta tu kousnout nemůže.
  const stored = openSession(`test-${newSessionSeed()}`, 4021)!;
  await runGeneration(stored, PLAN.intent.setting, { emit: scripted().emit, grammar: grammar() });
  return stored;
}
