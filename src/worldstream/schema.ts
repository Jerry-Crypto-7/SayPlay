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

import { GEOM_LIMITS, geomProgramSchema } from '@/geom/program';
import { worldDocSchema } from '@/ir/worlddoc';
import { INTENT_ROLES, readIntent, type IntentSummary } from '@/model/worldstream-intent';
import { shapeProgramSchema } from '@/shape/schema';

export const BLUEPRINT_VERSION = 'worldstream-v1';

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
 * Odkud objekt bere svoji hmotu. Buď je to řádek kompozice, nebo hrdinský tvar
 * — třetí možnost neexistuje a `discriminatedUnion` to drží tvarem.
 */
export const semanticSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('geom'), node: z.int().min(0).max(GEOM_LIMITS.maxNodes - 1) })
    .strict(),
  z.object({ kind: z.literal('shape'), shapeId: identifier }).strict(),
]);

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
    targetBounds: worldBoundsSchema,
    importance: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  })
  .strict();

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

/* ------------------------------------------------------------------ *
 * Obálka.
 * ------------------------------------------------------------------ */

export const blueprintSchema = z
  .object({
    version: z.literal(BLUEPRINT_VERSION),
    /**
     * Semínko relace. Píše ho **systém**, ne model: jediná PRNG projektu je
     * `pure-rand` a bere celé číslo, takže rozsah je kladný 32bitový, aby se
     * v Node a v prohlížeči nezaokrouhlilo jinak.
     */
    sessionSeed: z.int().min(0).max(2_147_483_647),
    title: z.string().min(1).max(120),
    intent: intentSummarySchema,
    world: worldDocSchema,
    geometry: geomProgramSchema,
    objects: z.array(semanticObjectSchema).min(1).max(64),
    shapes: z.array(shapeProgramSchema).max(MAX_HERO_SHAPES),
  })
  .strict();

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
