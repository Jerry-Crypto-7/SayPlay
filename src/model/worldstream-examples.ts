/**
 * **Few-shot ukázka pro planner (P13 T10).**
 *
 * Jedna ukázka, ne pět. Každá z pěti rolí je v ní zastoupená právě jednou,
 * takže model vidí rozdíl mezi `architecture` a `terrain` na jednom světě,
 * kde vedle sebe stojí — a ne na pěti oddělených, kde by si každou roli mohl
 * vyložit zvlášť.
 *
 * ## Proč zrovna observatoř na zamrzlém jezeře
 *
 * Ukázka musí být **sémanticky vzdálená celé zmrazené sadě**, jinak nejde
 * poznat opisování. `evals/worldstream/create.jsonl` má katedrálu z kontejnerů,
 * spirálovou knihovnu a další; nic z toho nestojí na ledu a nic z toho nemá
 * kopuli. Kdyby ukázka byla „nějaká budova", opsaná odpověď by se od poctivé
 * nedala odlišit a `EXAMPLE_ONLY_IDENTIFIERS` níž by nehlídalo nic.
 */

import type { IntentRole, PlannerEmission } from './worldstream-intent';

/**
 * Ukázková emise. Je `PlannerEmission`, ne volný literál — kdyby se kontrakt
 * změnil, tenhle soubor přestane překládat, místo aby tiše učil model starý tvar.
 */
export const EXAMPLE_PLAN: PlannerEmission = {
  intent: {
    setting: 'a glass observatory standing alone on a frozen lake',
    mood: 'still, cold, expectant',
    spatialThesis:
      'The dome sits at the centre of an unbroken ice plain, so every sightline runs flat to the horizon and then turns upward through the glass.',
    actors: ['the keeper'],
    heroObjects: ['the glass dome', 'the telescope mount'],
    interactions: ['the keeper cranks the mount and the dome shutter turns to follow it'],
    unsupported: [
      'the ice is one solid surface; it does not crack or bear weight differently in places',
      'dusk is a fixed light state, not a sun that keeps moving while you watch',
    ],
  },
  objects: [
    {
      stableId: 'observatoryShell',
      label: 'the glass dome',
      synonyms: ['the dome', 'the glass shell', 'the observatory'],
      role: 'architecture',
      importance: 3,
    },
    {
      stableId: 'telescopeMount',
      label: 'the telescope mount',
      synonyms: ['the telescope', 'the mount', 'the crank'],
      role: 'hero',
      importance: 3,
    },
    {
      stableId: 'keeperStool',
      label: "the keeper's stool",
      synonyms: ['the stool', 'the seat'],
      role: 'prop',
      importance: 1,
    },
    {
      stableId: 'frozenLake',
      label: 'the frozen lake',
      synonyms: ['the ice', 'the lake', 'the ice plain'],
      role: 'terrain',
      importance: 2,
    },
    {
      stableId: 'duskHaze',
      label: 'the dusk haze',
      synonyms: ['the haze', 'the cold air'],
      role: 'effect',
      importance: 0,
    },
  ],
};

/**
 * Jména, která patří výhradně ukázce.
 *
 * Táž doktrína jako `EXAMPLE_ONLY_IDENTIFIERS` v `./prompt.ts`, jen o patro
 * výš: strukturálně platný plán, který vrátí kopuli na ledě pro větu
 * o tržnici, je **strukturálně platný a věcně špatný**. Kontrolovat se to dá
 * jedině proti jménům, protože význam nikdo neuhlídá.
 *
 * Jsou tu `stableId` i `label` — model umí opsat obojí a stačí jedno.
 */
export const EXAMPLE_ONLY_IDENTIFIERS: readonly string[] = [
  ...EXAMPLE_PLAN.objects.map((object) => object.stableId),
  ...EXAMPLE_PLAN.objects.map((object) => object.label),
];

/** Pět rolí, jak je ukázka předvádí. Slouží i systémové zprávě jako slovník. */
export const ROLE_HINTS: Readonly<Record<IntentRole, string>> = {
  architecture: 'the built shell you stand inside or under',
  hero: 'the one or two things the sentence is really about',
  prop: 'smaller things that make the place inhabited',
  terrain: 'the ground and what the ground does',
  effect: 'air, light and weather; never a solid thing',
};
