/**
 * **Křížové odkazy uvnitř blueprintu.**
 *
 * Schéma (`./schema.ts`) umí soudit jeden řádek. Tenhle soubor soudí to, co je
 * vidět až z celku: jestli `SemanticObject.source` ukazuje na něco, co
 * doopravdy existuje, a jestli je ta vazba **oboustranná**.
 *
 * Rozdělení je stejné jako v `src/model/certify.ts`, kde schéma a
 * `findDanglingReferences()` stojí vedle sebe jako dva kroky řetězu, a ze
 * stejného důvodu: povrchová jména se do IR nedostanou, takže osiřelý odkaz se
 * za nimi už nedá najít.
 *
 * ## Proč se odkaz kontroluje na obě strany
 *
 * `shapes[i].stableId` říká „tenhle tvar patří tomuhle objektu" a
 * `objects[j].source` říká „tenhle objekt je z tamtoho tvaru". Obě věty mohou
 * být tvarově v pořádku a přitom si odporovat — objekt tvrdí, že je z kompozice,
 * zatímco tvar tvrdí, že je jeho. Vznikne mesh, který nikdo nevlastní: brána
 * §12 ho pustí, `RepresentationRegistry` pro něj nemá slot a **hot-swap na něj
 * nikdy nedojde**. Objekt pak zůstane navždy v hrubé podobě a nikde se to
 * neohlásí, protože formálně je všechno platné.
 *
 * V1 nevyžaduje entitu pro každý vizuální objekt (zdi a terén ji nemají).
 * V2 ověřuje explicitní binding.entityId, pokud jej objekt deklaruje.
 * Výchozí katalog je lokální allowlist; testy a import mohou předat vlastní.
 */

import { placedFrom, reachableFrom } from '@/geom/program';
import type { AssetManifest } from '@/assets/manifest';
import { WORLDSTREAM_ASSETS } from '@/assets/catalog';
import { assetObjectIssues } from '@/assets/binding';

import type { WorldstreamBlueprint } from './schema';

export interface BlueprintReference {
  /** Kde odkaz stojí, cestou do dokumentu — `objects/2/source`. */
  readonly where: string;
  readonly detail: string;
}

/**
 * Všechny vadné odkazy, ne první.
 *
 * Seznam jde do sebeopravy (T12), a ta z jedné věty umí opravit jednu věc.
 * Kdyby se vracel jen první nález, protočila by se smyčka třikrát na tomtéž
 * blueprintu a došla by k prázdnu s jednou vadou stále nedotčenou.
 */
export function findBlueprintReferenceIssues(
  blueprint: WorldstreamBlueprint,
  assets: AssetManifest = WORLDSTREAM_ASSETS,
): BlueprintReference[] {
  return findReferences(blueprint, assets, blueprint.world.sim);
}

export function findVisualReferenceIssues(
  visual: Pick<WorldstreamBlueprint, 'geometry' | 'objects' | 'shapes'>,
  assets: AssetManifest = WORLDSTREAM_ASSETS,
): BlueprintReference[] { return findReferences(visual, assets); }

function findReferences(
  blueprint: Pick<WorldstreamBlueprint, 'geometry' | 'objects' | 'shapes'>,
  assets: AssetManifest, sim?: WorldstreamBlueprint['world']['sim'],
): BlueprintReference[] {
  const issues: BlueprintReference[] = [];
  const fail = (where: string, detail: string) => issues.push({ where, detail });

  const objectsById = new Map<string, number>();
  blueprint.objects.forEach((object, index) => {
    const first = objectsById.get(object.stableId);
    if (first === undefined) objectsById.set(object.stableId, index);
    else fail(`objects/${index}/stableId`, `${object.stableId} is already used by objects/${first}`);
  });

  const shapesById = new Map<string, number>();
  blueprint.shapes.forEach((shape, index) => {
    const first = shapesById.get(shape.shapeId);
    if (first === undefined) shapesById.set(shape.shapeId, index);
    else fail(`shapes/${index}/shapeId`, `${shape.shapeId} is already used by shapes/${first}`);
  });

  // Řádky, které se z kořene doopravdy staví. Objekt ukazující na nedosažitelný
  // řádek je objekt, který v obraze nikde není — a to je horší než chybějící
  // odkaz, protože se to nedá vidět.
  //
  // Soudí se `placedFrom`, ne `reachableFrom`, a je v tom celý rozdíl mezi
  // „dojde se tam" a „něco z toho je vidět": cíl `anchorTo` je dosažitelný,
  // ale kompilátor si z něj vezme kvádr a kusy zahodí. Objekt na takovém řádku
  // projde dosažitelností a přesto nedostane ani jeden trojúhelník — a tady je
  // jediné místo, kde se model dá ještě požádat, aby ukázal jinam.
  const placed = placedFrom(blueprint.geometry.nodes, blueprint.geometry.root);
  const reached = reachableFrom(blueprint.geometry.nodes, blueprint.geometry.root);

  /** Který objekt si nárokuje který tvar. Druhý nárok na týž tvar je vada. */
  const claimedBy = new Map<string, number>();

  /**
   * Který objekt si nárokuje který **řádek kompozice**.
   *
   * Druhý nárok na týž řádek je vada ze stejného důvodu jako u tvaru, jen se
   * projeví jinak: `buildProxyWorld()` dá kusy prvnímu a druhý skončí na hlíně
   * natrvalo. Kdyby se to hlásilo až tam, model se o tom nikdy nedozví —
   * potrubí je v tu chvíli za opravným kolem. Rozdělit jeden řádek mezi dva
   * objekty nejde: `repeat` ani `mirror` nedávají kopiím vlastní identitu,
   * takže „vem si druhou kopii" není co napsat.
   */
  const rowClaimedBy = new Map<number, number>();
  const entityClaimedBy = new Map<string, number>();

  blueprint.objects.forEach((object, index) => {
    const where = `objects/${index}/source`;
    const entityId = object.binding?.entityId;
    if (sim && object.binding?.signalFlag && !Object.hasOwn((sim.state as { flags?: object } | undefined)?.flags ?? {}, object.binding.signalFlag))
      fail(`objects/${index}/binding/signalFlag`, `names missing flag ${object.binding.signalFlag}`);
    if (sim && entityId !== undefined) {
      const entities = sim.entities;
      if (!entities || typeof entities !== 'object' || !Object.hasOwn(entities, entityId))
        fail(`objects/${index}/binding/entityId`, `names missing entity ${entityId}`);
      if (entityClaimedBy.has(entityId)) fail(`objects/${index}/binding/entityId`, `entity ${entityId} already has a visual object`);
      entityClaimedBy.set(entityId, index);
    }
    if (object.source.kind === 'asset') {
      const resolved = assets?.resolve(object.source);
      if (!resolved?.ok) {
        fail(where, resolved?.reason ?? 'Asset catalog is unavailable');
        return;
      }
      for (const issue of assetObjectIssues(object, resolved.asset)) fail(where, issue);
      return;
    }
    if (object.source.kind === 'geom') {
      const node = object.source.node;
      if (node >= blueprint.geometry.nodes.length) {
        fail(
          where,
          `names geometry node ${node} outside the table of ${blueprint.geometry.nodes.length}`,
        );
        return;
      }
      if (!placed.has(node)) {
        fail(
          where,
          reached.has(node)
            ? `names geometry node ${node}, which root ${blueprint.geometry.root} reaches only as an anchorTo target, so none of its pieces are ever placed`
            : `names geometry node ${node}, which cannot be reached from root ${blueprint.geometry.root} and is therefore never built`,
        );
        return;
      }
      const rowRival = rowClaimedBy.get(node);
      if (rowRival === undefined) rowClaimedBy.set(node, index);
      else fail(where, `names geometry node ${node}, already taken by objects/${rowRival}`);
      return;
    }

    const shapeIndex = shapesById.get(object.source.shapeId);
    if (shapeIndex === undefined) {
      fail(where, `names shape ${object.source.shapeId}, which no entry of shapes declares`);
      return;
    }

    const rival = claimedBy.get(object.source.shapeId);
    if (rival === undefined) claimedBy.set(object.source.shapeId, index);
    else fail(where, `names shape ${object.source.shapeId}, already taken by objects/${rival}`);

    const shape = blueprint.shapes[shapeIndex];
    if (shape.stableId !== object.stableId) {
      fail(
        where,
        `names shape ${shape.shapeId}, but that shape belongs to ${shape.stableId}, not to ${object.stableId}`,
      );
    }
  });

  blueprint.shapes.forEach((shape, index) => {
    if (!objectsById.has(shape.stableId)) {
      fail(
        `shapes/${index}/stableId`,
        `${shape.stableId} names no object, so the mesh it produces would belong to nobody`,
      );
      return;
    }
    if (claimedBy.get(shape.shapeId) === undefined) {
      fail(
        `shapes/${index}/shapeId`,
        `${shape.shapeId} is declared but no object sources from it, so it would be meshed and never shown`,
      );
    }
  });

  return issues;
}
