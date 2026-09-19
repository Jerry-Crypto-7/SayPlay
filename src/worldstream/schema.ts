/**
 * **`WorldstreamBlueprint` — obálka jednoho světa (design book §9.2).**
 *
 * Tohle je jediné místo, kde se rozhoduje, jestli to, co model napsal o jednom
 * světě, drží pohromadě jako celek: zapečetěný `WorldDoc`, program kompozice,
 * hrdinské tvary a sémantické objekty, které je spojují.
 *
 * ## Skládá se importem, nikdy kopií
 *
 * `worldDocSchema`, `geomProgramSchema` a `shapeProgramSchema` se sem
 * **importují**. Kořen `WorldDoc v1` je zmrazený (§9.1) a jeho kopie by se s ním
 * rozešla tiše — přesně to se v tomhle repu už jednou stalo, když si schéma
 * představovalo `layout.type` a korpus nesl `layout.kind`, a **0 z 15**
 * zmrazených emisí prošlo, aniž si toho kterýkoli test všiml. Totéž platí
 * o `intent`: čte ho `readIntent()` z plannerovy fáze, ne druhé zod schéma
 * napsané tady.
 *
 * ## Co v obálce schválně NENÍ
 *
 * §9.2 jmenuje ještě `materials: MaterialSpec[]` a `presentation:
 * PresentationSpec`, §9.4 pak `interactionSockets: SocketBinding[]`. **Žádný
 * z těch tří typů nemá v repu definici** a T11 je nepotřebuje. Vymyslet je tady
 * by znamenalo tři kontrakty, které nikdo nevaliduje a nikdo nečte — a data
 * o socketech navíc už existují: sedí na `ShapeProgram.anchors`, v souřadnicích
 * tvaru, takže přežijí výměnu podoby. Až bude výtvarný systém potřebovat
 * materiál jako typ, přibude sem s tím, kdo ho čte.
 *
 * ## Proč `zod` a ne `ajv`
 *
 * `ajv` kompiluje validátory přes `new Function`, což pod striktním CSP
 * v prohlížeči padá (`CLAUDE.md`, Pasti). Zbytek repa mluví `zod`em taky.
 */

import { z } from 'zod';
import { assetReferenceSchema } from '@/assets/schema';

import { GEOM_LIMITS, geomProgramSchema } from '@/geom/program';
import { worldDocSchema, validateLook } from '@/ir/worlddoc';
import { INTENT_ROLES, readIntent, type IntentSummary } from '@/model/worldstream-intent';
import { sceneSpecSchema, readSceneSpec } from '@/scene/spec';
import { shapeProgramSchema } from '@/shape/schema';
import { LOOK_PRESETS } from './look';

export const BLUEPRINT_VERSION = 'worldstream-v1';
export const BLUEPRINT_VERSION_V2 = 'worldstream-v2';

/**
 * Meze světových souřadnic. **Táž hodnota jako `coordinate` v
 * `src/geom/program.ts` a v `src/shape/schema.ts`** — objekt se umisťuje do
 * téhož prostoru, ve kterém stojí kompozice, takže tři různá čísla by znamenala
 * blueprint, jehož objekt leží mimo vlastní geometrii.
 *
 * Ani jedno z těch dvou schémat svůj rozsah neexportuje, takže se tu opisuje
 * číslo. Drží to `__tests__/schema.test.ts`, který obě cizí schémata zkouší na
 * hraně: kdyby se kterékoli z nich pohnulo, zčervená to tam, ne až u porotce.
 */
export const WORLD_COORDINATE_LIMIT = 64;

/**
 * Nejmenší rozměr cílového kvádru na jedné ose.
 *
 * Není to vkus: potrubí do `targetBounds` tvar **normalizuje**, tedy dělí
 * rozpětím. Nulová osa dá `Infinity` a po vynásobení nulou `NaN` ve všech třech
 * kanálech naráz — objekt, který projde vším a v obraze po něm nezůstane nic.
 * Práh je týž jako nejmenší rozměr, který pustí `extent` u tvarů, takže
 * nezakazuje nic použitelného.
 */
export const MIN_TARGET_EXTENT = 0.01;

/**
 * Kolik hrdinských tvarů smí blueprint nést. **Naměřený rozpočet, ne kulaté
 * číslo:** `MESH_DETAIL.high` je 32 000 trojúhelníků na tvar, tři tvary tedy
 * 96 000 pod stropem scény 120 000, a fronta v `mesh-client.ts` je sériová
 * schválně, takže čtvrtý tvar se nedá schovat za paralelního pracovníka.
 *
 * Strop je v **schématu**, ne až ve fan-outu (§10.3), protože čtvrtý tvar by se
 * jinak přijal a pak tiše zahodil — a tiché zahození je přesně to, co se v tomhle
 * projektu nesmí stát.
 */
export const MAX_HERO_SHAPES = 3;

/* ------------------------------------------------------------------ *
 * Stavební kameny.
 * ------------------------------------------------------------------ */

const coordinate = z.number().min(-WORLD_COORDINATE_LIMIT).max(WORLD_COORDINATE_LIMIT);
const vector3 = z.tuple([coordinate, coordinate, coordinate]);

/**
 * Identifikátor. Táž uzavřená abeceda jako v `src/shape/schema.ts`: `stableId`
 * končí ve vyrenderovaném HTML jako `data-line-id` a v klíči registru
 * reprezentací, takže věta zapsaná do tohohle pole se má odmítnout tady, ne v DOM.
 */
const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'identifier must start alphanumerically');

/**
 * Cílový kvádr ve světových souřadnicích.
 *
 * Dvě kontroly nad rámec rozsahu: pořadí os a nenulové rozpětí. Obojí je
 * vlastnost celé dvojice, ne jednoho čísla, takže je schéma z jednoho řádku
 * nevidí.
 */
export const worldBoundsSchema = z
  .object({ min: vector3, max: vector3 })
  .strict()
  .refine((box) => box.min.every((value, axis) => box.max[axis] - value >= MIN_TARGET_EXTENT), {
    message: `bounds must span at least ${MIN_TARGET_EXTENT} on every axis, with min below max`,
  });

/**
 * Zdroj reprezentace: kompozice, SDF nebo verzovaný katalogový asset (v2).
 */
export const semanticSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('geom'), node: z.int().min(0).max(GEOM_LIMITS.maxNodes - 1) })
    .strict(),
  z.object({ kind: z.literal('shape'), shapeId: identifier }).strict(),
  assetReferenceSchema,
]);

/** Pevný kontrakt objektu ve světových souřadnicích, nezávislý na LOD/modelu. */
export const objectBindingSchema = z.object({
  entityId: identifier.optional(),
  signalFlag: identifier.optional(),
  collider: worldBoundsSchema,
  sockets: z.array(z.object({ id: identifier, at: vector3,
    normal: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
      .refine(v => Math.abs(Math.hypot(...v) - 1) < 0.0001),
  }).strict()).max(64),
  parts: z.array(z.object({ id: identifier, sockets: z.array(identifier).max(32) }).strict()).max(64),
}).strict().superRefine((binding, ctx) => {
  for (const key of ['sockets', 'parts'] as const) {
    if (new Set(binding[key].map(item => item.id)).size !== binding[key].length)
      ctx.addIssue({ code: 'custom', path: [key], message: 'Duplicate binding identity' });
  }
  const sockets = new Set(binding.sockets.map(socket => socket.id));
  if (binding.parts.some(part => part.sockets.some(id => !sockets.has(id))))
    ctx.addIssue({ code: 'custom', path: ['parts'], message: 'Part references an undeclared socket' });
});

/**
 * `SemanticObject` (§9.4) — sémantická polovina od plannera plus geometrická
 * polovina od compileru.
 *
 * `importance` je uzavřená čtveřice literálů, ne `z.int().min(0).max(3)`, aby
 * odvozený typ byl `0 | 1 | 2 | 3` a seděl na `PlannedObject`. Kdyby to bylo
 * `number`, spojení obou polovin by překladač propustil i s pětkou.
 */
export const semanticObjectSchema = z
  .object({
    stableId: identifier,
    label: z.string().min(1).max(120),
    synonyms: z.array(z.string().min(1).max(120)).max(16),
    role: z.enum(INTENT_ROLES),
    source: semanticSourceSchema,
    binding: objectBindingSchema.optional(),
    stretchAxes: z.array(z.enum(['x', 'y', 'z'])).max(3).optional(),
    yaw: z.number().finite().min(-Math.PI).max(Math.PI).optional(),
    supportSocket: identifier.optional(),
    targetBounds: worldBoundsSchema,
    importance: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  })
  .strict();

/**
 * **Objekt, který zakládá druhá věta** (P21 T8) — sémantická polovina plus
 * cílový kvádr, **bez `source`**.
 *
 * Zdroj se dosazuje, ne píše: nový objekt kreslí vždycky hrdinský tvar, který
 * přijde ve stejné odpovědi, takže `source` je `{ kind: 'shape', shapeId }`
 * a jeho jediná možná hodnota stojí v tom tvaru. Nechat to model psát by
 * znamenalo druhé místo, kde se dá ukázat na cizí tvar nebo řádek kompozice,
 * který si už nárokuje někdo jiný. Vazby (`binding`, assety) sem nepatří —
 * jsou to v2 kontrakty katalogu, ne věta porotce.
 *
 * `.pick()` ze `semanticObjectSchema`, ne opis: kdyby se pohnula abeceda
 * identifikátoru nebo meze kvádru, pohnou se tady s ní.
 */
export const additionObjectSchema = semanticObjectSchema
  .pick({ stableId: true, label: true, synonyms: true, role: true, targetBounds: true, importance: true })
  .strict();

export type AdditionObject = z.infer<typeof additionObjectSchema>;

/**
 * `intent` — **jedna definice, ta plannerova**.
 *
 * `.nonoptional()` je pás vedle šlí a je to **naměřeně tak**, ne odhadem.
 * Past je skutečná: `z.object({ a: z.unknown().optional()... })` chybějící klíč
 * pustí, `nonoptional` ne (ověřeno 31. 8. 2026). Tady ji ale zavírá už
 * `.transform()` níž — pipe se v objektu jako volitelný neprojevuje, takže
 * chybějící `intent` se odmítne i bez `nonoptional`. Mutace to potvrdila:
 * `nonoptional` → `optional` sadu **nezčervená**.
 *
 * Zůstává schválně. Kdyby někdo `.transform()` odebral (třeba návratem
 * k `z.custom`), past se otevře zpátky a nic by to neohlásilo. Vlastnost, na
 * které záleží, hlídá test „rejects a missing intent" — chování, ne zápis.
 */
export const intentSummarySchema = z
  .unknown()
  .nonoptional()
  .superRefine((value, ctx) => {
    const read = readIntent(value);
    if (typeof read === 'string') ctx.addIssue({ code: 'custom', message: read });
  })
  .transform((value) => value as IntentSummary);

/**
 * **Vazba proměnné světa na předvolbu vzhledu** (P22 T12).
 *
 * `variable` je jméno příznaku nebo čítače v `world.sim.state`; že existuje,
 * soudí `findBlueprintReferenceIssues()`, ne schéma – táž dělba jako
 * u `signalFlag`. Klíče tabulky jsou celá čísla zapsaná jako řetězec: příznak
 * je 0/1, čítač celé číslo, a `"on"` by muselo mít druhou tabulku aliasů,
 * kterou by nikdo nečetl. Předvolby jsou uzavřený seznam z `look.ts`.
 *
 * Volitelné a **jen ve v2**: v1 blueprinty jsou zmrazené emise a nesmí začít
 * padat na poli, které nikdy nenesly.
 */
export const lookBindingSchema = z
  .object({
    variable: identifier,
    values: z
      .record(z.string().regex(/^-?\d{1,9}$/, 'value keys are integers written as strings'), z.enum(LOOK_PRESETS))
      .refine((values) => Object.keys(values).length > 0, { message: 'a binding needs at least one value' }),
  })
  .strict();

export const MAX_LOOK_BINDINGS = 8;

/* ------------------------------------------------------------------ *
 * Obálka.
 * ------------------------------------------------------------------ */

const blueprintEnvelopeSchema = z
  .object({
    version: z.enum([BLUEPRINT_VERSION, BLUEPRINT_VERSION_V2]),
    /**
     * Semínko relace. Píše ho **systém**, ne model: jediná PRNG projektu je
     * `pure-rand` a bere celé číslo, takže rozsah je kladný 32bitový, aby se
     * v Node a v prohlížeči nezaokrouhlilo jinak.
     */
    sessionSeed: z.int().min(0).max(2_147_483_647),
    title: z.string().min(1).max(120),
    intent: intentSummarySchema,
    sceneSpec: sceneSpecSchema.optional(),
    world: worldDocSchema,
    geometry: geomProgramSchema,
    objects: z.array(semanticObjectSchema).min(1).max(64),
    shapes: z.array(shapeProgramSchema).max(MAX_HERO_SHAPES),
    lookBindings: z.array(lookBindingSchema).max(MAX_LOOK_BINDINGS).optional(),
  })
  .strict();
function validateVisualEnvelope(blueprint: Pick<z.infer<typeof blueprintEnvelopeSchema>, 'version' | 'sceneSpec' | 'objects'> & { readonly lookBindings?: unknown }, ctx: z.RefinementCtx) {
    if (blueprint.version === BLUEPRINT_VERSION && blueprint.lookBindings !== undefined)
      ctx.addIssue({ code: 'custom', path: ['lookBindings'], message: 'Look bindings require worldstream-v2' });
    if (blueprint.sceneSpec) {
      const result = readSceneSpec(blueprint.sceneSpec);
      if (typeof result === 'string') ctx.addIssue({ code: 'custom', path: ['sceneSpec'], message: result });
      for (const instance of blueprint.sceneSpec.instances) {
        if (instance.role !== 'effect' && !blueprint.objects.some(object => object.stableId === instance.stableId))
          ctx.addIssue({ code: 'custom', path: ['sceneSpec'], message: `Missing semantic instance ${instance.stableId}` });
      }
    }
    blueprint.objects.forEach((object, index) => {
      if (blueprint.version === BLUEPRINT_VERSION &&
        (object.source.kind === 'asset' || object.binding !== undefined || object.stretchAxes !== undefined || object.yaw !== undefined || object.supportSocket !== undefined))
        ctx.addIssue({ code: 'custom', path: ['objects', index], message: 'Asset references and bindings require worldstream-v2' });
      if (object.source.kind === 'asset' && object.binding === undefined)
        ctx.addIssue({ code: 'custom', path: ['objects', index, 'binding'], message: 'Assets require a representation-independent binding' });
      if (object.stretchAxes && (object.source.kind !== 'asset' || new Set(object.stretchAxes).size !== object.stretchAxes.length))
        ctx.addIssue({ code: 'custom', path: ['objects', index, 'stretchAxes'], message: 'Stretch axes must be unique and apply only to assets' });
      if (object.yaw !== undefined && object.source.kind !== 'asset')
        ctx.addIssue({code:'custom',path:['objects',index,'yaw'],message:'Yaw applies only to normalized asset frames'});
      if (object.supportSocket && (object.source.kind!=='asset' || !object.binding?.sockets.some(socket=>socket.id===object.supportSocket)))
        ctx.addIssue({code:'custom',path:['objects',index,'supportSocket'],message:'Support socket must be an accepted asset binding socket'});
    });
  }

export const blueprintSchema = blueprintEnvelopeSchema.superRefine(validateVisualEnvelope);
/** A preview cannot carry a simulation, hash, revision or certificate. */
export const visualPreviewSchema = z.object({
  kind: z.literal('visual-preview'), interactive: z.literal(false),
  stage: z.enum(['intent-layout', 'compiler-visuals']).optional(),
  version: blueprintEnvelopeSchema.shape.version, sessionSeed: blueprintEnvelopeSchema.shape.sessionSeed,
  title: blueprintEnvelopeSchema.shape.title, intent: intentSummarySchema, sceneSpec: sceneSpecSchema.optional(),
  geometry: geomProgramSchema, objects: blueprintEnvelopeSchema.shape.objects, shapes: blueprintEnvelopeSchema.shape.shapes,
  look: worldDocSchema.shape.look,
  validation: z.object({ layout: z.enum(['checked', 'not-requested']), limitations: z.array(z.string().max(500)).max(128) }).strict(),
}).strict().superRefine((preview, ctx) => {
  validateVisualEnvelope(preview, ctx);
  for (const issue of validateLook(preview.look).issues) ctx.addIssue({ code: 'custom', path: ['look'], message: issue });
  preview.objects.forEach((object, i) => {
    if (object.binding?.entityId !== undefined || object.binding?.signalFlag !== undefined)
      ctx.addIssue({ code: 'custom', path: ['objects', i, 'binding'], message: 'Preview cannot bind simulation entities or flags' });
  });
});
export type VisualPreview = z.infer<typeof visualPreviewSchema>;

export type SemanticSource = z.infer<typeof semanticSourceSchema>;
export type SemanticObject = z.infer<typeof semanticObjectSchema>;
export type WorldstreamBlueprint = z.infer<typeof blueprintSchema>;

export interface BlueprintValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/**
 * Tvar obálky, **ne** křížové odkazy mezi jejími částmi.
 *
 * Rozdělení je totéž jako v `certify.ts`, kde schéma a
 * `findDanglingReferences()` stojí vedle sebe jako dva kroky: schéma umí soudit
 * jeden řádek, odkazy až celek. Kdo chce obojí, zavolá tohle a pak
 * `findBlueprintReferenceIssues()` ze `./references`.
 */
export function validateBlueprint(input: unknown): BlueprintValidation {
  const parsed = blueprintSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `blueprint:/${issue.path.join('/')}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, issues: [] };
}
