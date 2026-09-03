'use client';

/**
 * **`WorldstreamStage` — most z hrubého světa na plátno** (P15 T19b).
 *
 * Do 3. 9. 2026 tahle vrstva chyběla a byla to tatáž vada, jakou měl `src/geom/**`
 * do 25. 8.: hotová, otestovaná, a **nikdo ji nevolal**. `buildProxyWorld()` uměl
 * postavit sloty, `RepresentationRegistry` uměl vyměnit podobu, `RepresentationSlot`
 * uměl slot vykreslit — a mezi „hrubý svět" a „scéna" nevedla jediná čára. Tenhle
 * soubor je ta čára a nic jiného: bere `ProxyWorld`, vyrobí z každé příčky žebříku
 * uzel, **předá ho registry** a nechá `RepresentationSlots` vykreslit, co registry
 * drží.
 *
 * ## Registry je jediné dveře, i pro tu úplně první podobu
 *
 * Nabízí se hrubou podobu připojit rovnou — vždyť ještě není co vyměňovat. Bylo by
 * to špatně: obal se sockety a transformací slotu zakládá `open()`, a podoba
 * pověšená vedle něj by při prvním hot-swapu (`T20`) zůstala viset. Proto sem
 * `.add()` nepatří ani jednou; každý uzel jde do `registry.open(slot, rough)`.
 *
 * ## Materiál na každý slot vlastní, ne jeden sdílený
 *
 * `clayMaterial()` vrací novou instanci schválně a tady se to poprvé vyplácí:
 * `registry.offer()` odloží prohranou podobu přes `disposeSubtree()`, který
 * odloží i její materiál. Kdyby ho sdílelo všech pět slotů, sebral by první
 * hot-swap povrch zbylým čtyřem — a projevilo by se to až u druhé věty, tedy
 * o dvě úlohy dál.
 *
 * ## Co tenhle soubor nedělá
 *
 * Nevolá model, nemešuje a nedrží relaci. Dostane hotový `ProxyWorld` a vrátí
 * scénu. Kdo ten svět vyrobí — dev harness na `/dev/worldstream`, později hlavní
 * cesta (`T21b`) — je jeho věc.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { BoxGeometry, BufferAttribute, BufferGeometry, Group, Mesh, type Object3D } from 'three';

import { PALETTES, type Palette } from '@/kit';
import type { MeshResult } from '@/shape/mesh-client';
import type { AnchorSpec, Vec3 } from '@/shape/types';
import { admitMesh, type DetailLevel } from '@/worldstream/mesh-gate';
import type { ProxyRung, ProxySlot, ProxyWorld } from '@/worldstream/proxy';
import { boundsExtent, type SlotTransform } from '@/worldstream/slots';

import { clayMaterial } from './ClayMaterial';
import Materialize, { createRevealPlan, type RevealPlan } from './Materialize';
import { RepresentationSlots } from './RepresentationSlot';
import {
  createRepresentationRegistry,
  slotGroupName,
  type RepresentationRegistry,
  type SlotView,
} from './representation';
import { buildPlacementGroup } from './scenery';

/** Jméno skupiny kulisy. Sonda i testy ji hledají podle něj, ne podle pořadí. */
export const SCENERY_NAME = 'worldstream:scenery';

/** Jméno podoby uvnitř slotu. Předpona je společná, ať přišla z kterékoli příčky. */
export function formName(stableId: string): string {
  return `form:${stableId}`;
}

/**
 * Jméno kandidáta, který se právě odhaluje.
 *
 * **Jiné než `formName()` schválně.** Během odhalení stojí v jednom obalu obě
 * podoby (§13.3) a otázka „je jich tam víc, než má být?" se dá položit jedině
 * tehdy, když se ta dvojice dá od sebe rozeznat po jménu.
 */
export function detailName(stableId: string): string {
  return `detail:${stableId}`;
}

/* ------------------------------------------------------------------ *
 * Příčka žebříku → uzel scény.
 * ------------------------------------------------------------------ */

/** Uzel jedné podoby a účet za to, co si k němu stage drží. */
interface RoughBuild {
  /** `null` znamená slot bez podoby — hlína, která se schválně nekreslí. */
  readonly object: Object3D | null;
  readonly triangles: number;
  readonly dispose: () => void;
}

const NOTHING: RoughBuild = { object: null, triangles: 0, dispose: () => {} };

/**
 * Mesh z workeru → geometrie.
 *
 * Pole se **přebírají, nekopírují**: worker je posílá jako transferable, takže
 * kopie by zaplatila druhou paměť za data, která už nikdo jiný nedrží. Je to
 * tatáž úvaha jako v `normalize.ts`, kde se z téhož důvodu vracejí tatáž pole.
 */
function geometryFromMesh(mesh: MeshResult): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  return geometry;
}

/**
 * Hlína jako kvádr slotu.
 *
 * `localBounds` je u hlíny vycentrovaný kvádr (`slotFromWorldForm`), takže bedna
 * sedí v počátku prostoru slotu a do světa ji posadí `transform` — stejně jako
 * každou jinou podobu. Žádný posun navíc se tu proto nedělá.
 */
function clayBox(extent: Vec3): BufferGeometry {
  return new BoxGeometry(extent[0], extent[1], extent[2]);
}

function buildRough(entry: ProxySlot, palette: Palette): RoughBuild {
  const name = formName(entry.slot.stableId);

  if (entry.form.kind === 'mesh') {
    const geometry = geometryFromMesh(entry.form.mesh);
    const material = clayMaterial();
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return {
      object: mesh,
      triangles: entry.form.mesh.triangleCount,
      dispose: () => {
        geometry.dispose();
        material.dispose();
      },
    };
  }

  if (entry.form.kind === 'placements') {
    // Kusy kitu vezou odstín ve vrcholech a `repaint` je přebarvuje paletou,
    // takže základ musí být bílý s `vertexColors` — jinak se celý řádek
    // kompozice vykreslí jedním odstínem hlíny (past zapsaná u `ClayOverrides`).
    const material = clayMaterial({ color: '#ffffff', vertexColors: true });
    const built = buildPlacementGroup(entry.form.placements, palette, material, { name });
    built.object.castShadow = true;
    return {
      object: built.object,
      triangles: built.triangles,
      dispose: () => {
        // `built.dispose()` je tu **navíc** k úklidu registry, ne místo něj:
        // `disposeSubtree()` projde geometrie a materiály, ale `InstancedMesh`
        // drží ještě matici instancí, kterou uvolní jen `mesh.dispose()`.
        built.dispose();
        material.dispose();
      },
    };
  }

  if (!entry.form.drawn) return NOTHING;

  const geometry = clayBox(boundsExtent(entry.slot.localBounds));
  const material = clayMaterial();
  const box = new Mesh(geometry, material);
  box.name = name;
  box.castShadow = true;
  box.receiveShadow = true;
  return {
    object: box,
    triangles: 12,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Sonda — jediná cesta, jak se z prohlížeče zeptat, co scéna drží.
 * ------------------------------------------------------------------ */

/** Fakta o jednom slotu. **Syrová**, aby si závěr udělal ten, kdo se ptá. */
export interface StageSlotProbe {
  readonly stableId: string;
  readonly rung: ProxyRung;
  /** Kolik uzlů `slot:<id>` scéna doopravdy drží. Právě jeden je ta podmínka. */
  readonly groups: number;
  /**
   * Kolik uzlů `form:<id>` je ve scéně a kolik z nich visí **uvnitř vlastního
   * obalu**. Dvě čísla, ne jedno: podoba nakreslená dvakrát a podoba
   * nakreslená vedle svého slotu jsou různé vady a obě vypadají na jednom
   * snímku správně. Kdo obchází registry, se pozná právě tady.
   */
  readonly forms: { readonly total: number; readonly inGroup: number };
  /**
   * Totéž pro kandidáta vyššího detailu. **Během odhalení musí být `1` spolu
   * s `forms`** — §13.3 chce, aby hrubá podoba pod kandidátem zůstala; po
   * commitu je hrubá pryč a zbude sám.
   */
  readonly details: { readonly total: number; readonly inGroup: number };
  /** Má slot připojenou podobu? Nekreslená hlína ji nemá, a je to legitimní. */
  readonly attached: boolean;
  /** Čeká na tomhle slotu kandidát na odhalení? */
  readonly staged: boolean;
  /** Hash připojené podoby. Po commitu je to hash kandidáta, ne hrubé podoby. */
  readonly contentHash: string | null;
  /**
   * Proč se detail nepřipojil — kód brány nebo registry, nikdy volný text.
   * `null` znamená „nic se nepokazilo", ne „nic se nezkoušelo".
   */
  readonly failure: string | null;
  /**
   * Kolik trojúhelníků obal doopravdy kreslí — **čteno ze scény**, ne z účtu
   * pořízeného při stavbě. Během odhalení je to součet obou podob.
   */
  readonly triangles: number;
  readonly transform: SlotTransform;
  readonly anchors: readonly AnchorSpec[];
  /**
   * Kde sockety leží **podle scény** — `getWorldPosition()` na obalu, tedy tak,
   * jak je uvidí kamera. Kdo se ptá, si druhou stranu rovnice spočítá sám
   * z `transform` a `anchors` (`toWorld()` v `slots.ts`); počítat tady obě
   * strany by znamenalo porovnávat výpočet sám se sebou.
   */
  readonly sockets: readonly { readonly name: string; readonly at: Vec3 }[];
}

export interface StageSceneryProbe {
  readonly present: boolean;
  readonly triangles: number;
  readonly drawCalls: number;
  /** Kolik uzlů kulisy scéna drží. Jeden, nebo nula, když kompozici rozebraly sloty. */
  readonly groups: number;
  /**
   * Kolik uzlů slotu nebo podoby visí **uvnitř** kulisy. Musí být nula: kulisa
   * je zbytek kompozice, tedy to, co si nenárokoval nikdo. Kus nakreslený
   * v kulise **i** ve slotu je dvojobraz, který na snímku vypadá jen o něco
   * hustěji, a hot-swap by pak vyměnil polovinu objektu.
   */
  readonly slotNodes: number;
}

/** Co se právě odhaluje. `null` je stav, ve kterém scéna tráví většinu času. */
export interface StageRevealProbe {
  readonly stableId: string;
  readonly reducedMotion: boolean;
  readonly durationMs: number;
}

export interface StageProbe {
  /** Postavila se scéna z hrubého světa? Do té doby jsou ostatní odpovědi prázdné. */
  ready: () => boolean;
  slots: () => readonly StageSlotProbe[];
  scenery: () => StageSceneryProbe;
  /** Běžící odhalení, nebo `null`. */
  reveal: () => StageRevealProbe | null;
  /**
   * Rozvrh **posledního** odhalení, i když už doběhlo.
   *
   * Bez toho se tlumený pohyb nedá doložit: při `reduce` je odhalení hotové
   * v prvním snímku, takže okno, ve kterém `reveal()` něco vrací, nemusí
   * nastat vůbec — a ptát se na něj by byl závod, ne měření.
   */
  lastReveal: () => StageRevealProbe | null;
  /**
   * Kde stojí kamera. Materializace s ní nesmí hnout — detail se má objevit
   * tam, kam se porotce zrovna dívá, ne po přeletu, který mu vezme orientaci.
   */
  camera: () => Vec3;
  /** Kolik odhalení se uzavřelo commitem. Roste jen po úspěchu. */
  commits: () => number;
  /** Kolik snímků plátno vykreslilo. Bez toho se nepozná, že scéna došla na GPU. */
  frames: () => number;
  /**
   * Co renderer **doopravdy** drží — jediný oracle úklidu, jaký z prohlížeče
   * existuje. `disposeSubtree()` umí vrátit poctivý účet a přitom nechat zdroj
   * naživu, protože ho vedle registry drží ještě někdo jiný; tohle číslo čte
   * druhou stranu, tedy GPU.
   *
   * `programs` je tu kvůli **materiálům odhalení**. Každá výměna podoby si
   * vyrobí vlastní `clayMaterial()`, a zapomenutý materiál se v počtu geometrií
   * ani textur neprojeví vůbec — projeví se právě jen tady.
   */
  memory: () => { readonly geometries: number; readonly textures: number; readonly programs: number };
}

declare global {
  interface Window {
    __worldstreamStage?: StageProbe;
  }
}

/* ------------------------------------------------------------------ *
 * Stavba.
 * ------------------------------------------------------------------ */

interface StageBuild {
  /**
   * Registry, ne jen jeho snímek. Sonda i odhalení se ptají **živě**: `SlotView`
   * je hodnota pořízená v okamžiku stavby, takže po `stage()` a `commit()` už
   * o připojené podobě lhala.
   */
  readonly registry: RepresentationRegistry;
  /** Snímek pro vykreslení. Obaly se nemění, mění se jen jejich obsah. */
  readonly views: readonly SlotView[];
  readonly rungs: ReadonlyMap<string, ProxyRung>;
  readonly triangles: ReadonlyMap<string, number>;
  readonly slots: readonly ProxySlot[];
  readonly scenery: Group | null;
  /** Co kulisa stála. Zbytek sondy se čte ze scény, ne ze stavby. */
  readonly sceneryCost: Omit<StageSceneryProbe, 'groups' | 'slotNodes'>;
  readonly socketWorld: (stableId: string, name: string) => Vec3 | null;
  readonly dispose: () => void;
}

/**
 * Stavba odmítnutého světa (§27 příčka 6). **Funkce, ne sdílená konstanta:**
 * nese registry, a jedno sdílené registry napříč připojeními komponenty by
 * znamenalo, že dvě plátna píšou do jednoho vlastníka slotů.
 */
function emptyBuild(): StageBuild {
  return {
    registry: createRepresentationRegistry(),
    views: [],
    rungs: new Map(),
    triangles: new Map(),
    slots: [],
    scenery: null,
    sceneryCost: { present: false, triangles: 0, drawCalls: 0 },
    socketWorld: () => null,
    dispose: () => {},
  };
}

function buildStage(world: ProxyWorld, palette: Palette): StageBuild {
  if (world.kind !== 'built') return emptyBuild();

  const registry = createRepresentationRegistry();
  const rungs = new Map<string, ProxyRung>();
  const triangles = new Map<string, number>();
  const owned: (() => void)[] = [];

  for (const entry of world.slots) {
    const rough = buildRough(entry, palette);
    owned.push(rough.dispose);
    registry.open(entry.slot, rough.object);
    rungs.set(entry.slot.stableId, entry.form.rung);
    triangles.set(entry.slot.stableId, rough.triangles);
  }

  // Kulisa je zbytek kompozice — kusy, které si nenárokoval žádný slot. Kreslí
  // se **vedle** slotů a ve světových souřadnicích, takže žádnou transformaci
  // nedostává: `buildProxyWorld()` jí nechal přesně ty matice, které napsal model.
  let scenery: Group | null = null;
  let sceneryCost: StageBuild['sceneryCost'] = { present: false, triangles: 0, drawCalls: 0 };
  if (world.scenery.length > 0) {
    const material = clayMaterial({ color: '#ffffff', vertexColors: true });
    const built = buildPlacementGroup(world.scenery, palette, material, { name: SCENERY_NAME });
    scenery = built.object;
    sceneryCost = { present: true, triangles: built.triangles, drawCalls: built.drawCalls };
    owned.push(() => {
      built.dispose();
      material.dispose();
    });
  }

  return {
    registry,
    views: registry.slots,
    rungs,
    triangles,
    slots: world.slots,
    scenery,
    sceneryCost,
    socketWorld: (stableId, name) => registry.socketWorld(stableId, name),
    dispose: () => {
      registry.dispose();
      if (scenery !== null) scenery.removeFromParent();
      for (const release of owned) release();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Komponenta.
 * ------------------------------------------------------------------ */

/**
 * Vyšší detail pro jeden slot, hotový mesh.
 *
 * Nese `contentHash` **od volajícího**, ne spočítaný tady: hash se skládá
 * z programu a rozlišení (`shapeContentHash()`), a program má ten, kdo mesh
 * objednal. Kdyby si ho stage počítala z výsledku, nebyl by to otisk zadání,
 * ale otisk toho, co z něj vylezlo — a kontrolní přečtení §13.3 by pak
 * porovnávalo mesh sám se sebou.
 */
export interface DetailUpgrade {
  readonly stableId: string;
  readonly contentHash: string;
  readonly level: DetailLevel;
  readonly mesh: MeshResult;
}

interface Reveal {
  readonly stableId: string;
  readonly object: Object3D;
  readonly plan: RevealPlan;
}

export interface WorldstreamStageProps {
  readonly world: ProxyWorld;
  /**
   * Paleta kusů kompozice.
   *
   * Výchozí je `harbor` a je to **provizorium, ne volba**: barvu má nakonec
   * určit `world.look`, který popsal model, a to je práce výtvarného systému
   * (fáze 2). Do té doby je jedna deklarovaná paleta lepší než odstín napsaný
   * do materiálu, protože ji jde vyměnit na jednom místě.
   */
  readonly palette?: Palette;
  /**
   * Detail, který má nahradit hrubou podobu jednoho slotu.
   *
   * Je to **prop, ne callback**, aby zdroj detailu zůstal venku: dneska ho
   * vyrábí dev harness ze svého meshovače, po `T21b` poteče ze SSE proudu
   * relace. Stage se v obou případech chová stejně — projde branou, připojí
   * neviditelně, odhalí, commitne.
   */
  readonly upgrade?: DetailUpgrade | null;
}

export default function WorldstreamStage({
  world,
  palette = PALETTES.harbor,
  upgrade = null,
}: WorldstreamStageProps): React.ReactElement {
  const build = useMemo(() => buildStage(world, palette), [world, palette]);
  const frames = useRef(0);
  const commits = useRef(0);
  const failures = useRef(new Map<string, string>());
  /**
   * Slot, jehož odhalení běží a ještě se neuzavřelo. Jedna hodnota, kterou vidí
   * i `finishReveal` — bez ní by se commit dal spustit dvakrát, viz tam.
   */
  const pending = useRef<string | null>(null);
  const lastReveal = useRef<StageRevealProbe | null>(null);
  const [root, setRoot] = useState<Object3D | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);

  useEffect(() => build.dispose, [build]);

  useFrame(() => {
    frames.current += 1;
  });

  useEffect(() => {
    if (upgrade === null) return;

    const entry = build.slots.find((candidate) => candidate.slot.stableId === upgrade.stableId);
    const view = build.registry.view(upgrade.stableId);
    if (entry === undefined || view === null) {
      failures.current.set(upgrade.stableId, 'UNKNOWN_SLOT');
      return;
    }

    // **Brána první, uzel až potom.** Kdyby se mesh nejdřív zabalil do `Mesh`
    // a teprve pak soudil, drží odmítnutý artefakt geometrii na GPU po celou
    // dobu, než ho někdo odloží — a odmítnutých je na failure cestách většina.
    const verdict = admitMesh(upgrade.mesh, {
      bounds: entry.slot.localBounds,
      level: upgrade.level,
    });
    if (!verdict.ok) {
      failures.current.set(upgrade.stableId, verdict.rejection);
      return;
    }

    const geometry = geometryFromMesh(upgrade.mesh);
    const material = clayMaterial();
    const detail = new Mesh(geometry, material);
    detail.name = detailName(upgrade.stableId);
    detail.castShadow = true;
    detail.receiveShadow = true;

    // Odmítnutého kandidáta odloží `stage()` sama, na každé ze svých cest.
    const staged = build.registry.stage({
      stableId: upgrade.stableId,
      revision: view.revision,
      contentHash: upgrade.contentHash,
      bounds: verdict.bounds,
      object: detail,
    });
    if (!staged.ok) {
      failures.current.set(upgrade.stableId, staged.refusal);
      return;
    }

    failures.current.delete(upgrade.stableId);
    pending.current = upgrade.stableId;
    const plan = createRevealPlan();
    lastReveal.current = {
      stableId: upgrade.stableId,
      reducedMotion: plan.reducedMotion,
      durationMs: plan.durationMs,
    };
    setReveal({ stableId: upgrade.stableId, object: detail, plan });
  }, [upgrade, build]);

  /**
   * §13.3 bod 6. **Nezavírá se přes updater `setReveal`**, protože commit je
   * vedlejší účinek a React updater může proběhnout dvakrát (StrictMode) —
   * druhý commit by na tomtéž slotu nenašel kandidáta a zapsal by `failure`
   * o vadě, která se nestala. Rozhoduje `pending`, tedy jedna hodnota, kterou
   * vidí obě strany.
   */
  const finishReveal = useCallback(() => {
    const stableId = pending.current;
    if (stableId === null) return;
    pending.current = null;

    const outcome = build.registry.commit(stableId);
    if (outcome.ok) commits.current += 1;
    else failures.current.set(stableId, outcome.refusal);
    setReveal(null);
  }, [build]);

  useEffect(() => {
    /**
     * Kolikrát scéna drží uzel toho jména — a kolikrát pod daným předkem.
     *
     * Počítá se **procházením scény**, ne dotazem do registry: registry ví, co
     * vydal, a otázka zní, co je na plátně. Dvojí připojení téhož uzlu by se
     * z registry nepoznalo, protože ten drží jednu položku na slot.
     */
    const count = (name: string, under: Object3D | null): number => {
      let found = 0;
      under?.traverse((object) => {
        if (object.name === name) found += 1;
      });
      return found;
    };

    /**
     * Kolik trojúhelníků ten podstrom doopravdy kreslí.
     *
     * **Čte se ze scény, ne z účtu pořízeného při stavbě** — a je to oprava
     * naměřené vady: dokud se hlásilo číslo ze stavby, hlásil slot po výměně
     * podoby pořád počet **hrubé** podoby, takže `e2e` na jemnější mřížku
     * viděla stejné číslo a nemohla poznat, jestli se vyměnilo cokoli.
     *
     * Během odhalení je to součet obou podob a je to správně: v tu chvíli se
     * obě opravdu kreslí.
     */
    const trianglesUnder = (under: Object3D | null): number => {
      let total = 0;
      under?.traverse((object) => {
        const geometry = (object as { geometry?: BufferGeometry }).geometry;
        if (geometry === undefined) return;
        const count = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
        const instances = (object as { isInstancedMesh?: boolean; count?: number }).isInstancedMesh
          ? ((object as { count?: number }).count ?? 1)
          : 1;
        total += (count / 3) * instances;
      });
      return total;
    };

    const groupNamed = (name: string): Object3D | null => {
      let found: Object3D | null = null;
      root?.traverse((object) => {
        if (object.name === name && found === null) found = object;
      });
      return found;
    };

    window.__worldstreamStage = {
      ready: () => build.views.length > 0,
      frames: () => frames.current,
      memory: () => ({
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        // `programs` je u `WebGLRenderer` volitelné pole; když si ho renderer
        // nevede, je nula poctivější odpověď než výjimka uprostřed měření.
        programs: gl.info.programs?.length ?? 0,
      }),
      scenery: () => {
        // Jména se skládají ze **stejných funkcí** jako při stavbě, ne z předpony
        // opsané podruhé: kdyby se `slotGroupName()` někdy změnil, má tenhle
        // součet přestat počítat spolu s ním, ne tiše spadnout na nulu.
        const owned = new Set(
          build.slots.flatMap((entry) => [
            slotGroupName(entry.slot.stableId),
            formName(entry.slot.stableId),
          ]),
        );
        let slotNodes = 0;
        groupNamed(SCENERY_NAME)?.traverse((object) => {
          if (owned.has(object.name)) slotNodes += 1;
        });
        return { ...build.sceneryCost, groups: count(SCENERY_NAME, root), slotNodes };
      },
      reveal: () =>
        reveal === null
          ? null
          : {
              stableId: reveal.stableId,
              reducedMotion: reveal.plan.reducedMotion,
              durationMs: reveal.plan.durationMs,
            },
      lastReveal: () => lastReveal.current,
      commits: () => commits.current,
      camera: () => [camera.position.x, camera.position.y, camera.position.z],
      slots: () =>
        build.slots.map((entry) => {
          const { stableId, transform, anchors } = entry.slot;
          // **Živě z registry, ne ze snímku `views`.** Ten se pořídil při
          // stavbě a o `stage()` ani `commit()` nikdy neuslyší.
          const view = build.registry.view(stableId);
          const form = formName(stableId);
          const detail = detailName(stableId);
          const group = groupNamed(slotGroupName(stableId));
          return {
            stableId,
            rung: build.rungs.get(stableId)!,
            groups: count(slotGroupName(stableId), root),
            forms: { total: count(form, root), inGroup: count(form, group) },
            details: { total: count(detail, root), inGroup: count(detail, group) },
            staged: view?.staged != null,
            contentHash: view?.contentHash ?? null,
            failure: failures.current.get(stableId) ?? null,
            attached: view?.attached != null,
            triangles: trianglesUnder(group),
            transform,
            anchors,
            // Kotva slotu je socket obalu, takže `socketWorld` ho vždycky najde
            // — obojí zakládá `open()` z téhož pole `anchors`.
            sockets: anchors.map((anchor) => ({
              name: anchor.name,
              at: build.socketWorld(stableId, anchor.name)!,
            })),
          };
        }),
    };
    return () => {
      delete window.__worldstreamStage;
    };
  }, [build, root, reveal, camera, gl]);

  return (
    <group ref={setRoot} name="worldstream:stage">
      <RepresentationSlots views={build.views} />
      {build.scenery !== null && <primitive object={build.scenery} />}
      {reveal !== null && (
        // Odhalení je vždycky nejvýš jedno, takže `key` tu nic neřeší a není
        // tu. Naběhlý čas nuluje `Materialize` sám, na změně `object` a `plan`
        // — a ty jsou u druhého odhalení téhož slotu nové objekty.
        <Materialize object={reveal.object} plan={reveal.plan} onDone={finishReveal} />
      )}
    </group>
  );
}
