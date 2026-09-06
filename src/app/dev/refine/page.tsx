'use client';

/**
 * `/dev/refine` — vývojová adresa druhé věty (P15 T23).
 *
 * ## Proč vlastní adresa a ne `/dev/worldstream`
 *
 * Tři zelené sady (`worldstream-stage`, `worldstream-hot-swap`,
 * `worldstream-resilience`) stojí nad holým plátnem `/dev/worldstream` a soudí
 * **přechod podoby**. Tahle úloha potřebuje něco jiného: celou skořápku
 * `WorldstreamApp`, pole na větu a panel rozsahu. Nacpat obojí na jednu adresu
 * znamená, že červená z kterékoli z těch čtyř sad neřekne, co se rozbilo — a je
 * to přesně ten důvod, kvůli kterému `/dev/worldstream` vzniklo (`T19b`).
 *
 * ## Co je tady doopravdy a co je harness — a nic mezi tím
 *
 * **Doopravdy** je všechno, co soudí `T23`: svět, sloty, registry, výběr
 * paprskem, kotvený popisek, panel rozsahu, materializace jednoho slotu — a
 * hlavně **grounding**. `groundTarget()` je čistá funkce a běží tu skutečná,
 * ne opsaná: nabídku kandidátů tedy vyrábí tentýž kód jako v route.
 *
 * **Harness** je jediná věc: plán změny. V provozu ho píše model
 * (`planChange()` → placené volání), tady je scriptovaný a stránka to o sobě
 * říká ve stavové větě. Že model takový plán umí napsat, měří `T40` a `T14`.
 *
 * Scriptovaný plán je proto **jen tvarová změna** (`behavior: 0`,
 * `appearance: 0`). Ukázat v rozsahu operace do `/sim`, které by stránka
 * neuměla provést, by znamenalo panel, který tvrdí víc, než se stane — a to je
 * ta jediná vada, kterou tenhle panel existuje odstranit. Znění rozsahu nad
 * neprázdnými fasetami soudí jednotkový test `change-preview.test.ts`.
 *
 * ## Proč tu není `notFound()` v produkci
 *
 * Táž volba jako u `/dev/mesh-budget` a `/dev/worldstream`: e2e sada **je**
 * produkční build, takže schovaná stránka by se schovala i před vlastním testem.
 */

import { Canvas, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { UI_TOKENS } from '@/kit';
import { groundTarget } from '@/model/worldstream-refine';
import { createMeshClient, type MeshClient } from '@/shape/mesh-client';
import { shapeProgramSchema, validateShapeProgram } from '@/shape/schema';
import { MESH_DETAIL } from '@/shape/types';
import { shapeContentHash } from '@/worldstream/cache';
import { preservedBy } from '@/worldstream/preserved';
import { buildProxyWorld, type ProxyWorld } from '@/worldstream/proxy';

import WorldstreamLighting, {
  WORLDSTREAM_GL,
  WORLDSTREAM_SHADOWS,
} from '../../../components/viewer/WorldstreamLighting';
import WorldstreamStage, {
  type DetailUpgrade,
} from '../../../components/viewer/WorldstreamStage';
import ChangePreview, {
  type ChangeState,
} from '../../../components/worldstream/ChangePreview';
import ObjectLabel from '../../../components/worldstream/ObjectLabel';
import WorldstreamApp from '../../../components/worldstream/WorldstreamApp';

import { DEMO_BLUEPRINT, DEMO_CAMERA, DEMO_HERO_PROGRAM, DEMO_OUTCOME } from '../demo-world';

/**
 * Přepsaný tvar hrdiny — **výsledek scriptované druhé věty**.
 *
 * Mění se jeden uzel: kupole se protáhne a zúží. Je to schválně malý zásah do
 * existujícího programu, ne nový tvar od nuly, a má to dva důvody. Za prvé
 * zůstane uvnitř kvádru, který si tvar sám deklaroval, takže ho neodmítne
 * brána z důvodu, který s druhou větou nesouvisí. Za druhé se mění
 * `shapeContentHash`, takže se dá **naměřit**, že slot dostal jinou podobu — a
 * to je celá otázka commitu.
 *
 * ⚠ **Kužel je vycentrovaný, takže se výška počítá na obě strany.** Uzel stojí
 * na `y = 0,85` a `targetBounds` končí na `1,2`; výška 0,74 by dala vrchol na
 * 1,22, tedy dva centimetry ven — a mesher tvar odmítne celý. Naměřeno
 * 3. 9. 2026, projevilo se to jako „materializace nikdy nedoběhla".
 */
const SHARPENED_HERO = shapeProgramSchema.parse({
  ...DEMO_HERO_PROGRAM,
  nodes: DEMO_HERO_PROGRAM.nodes.map((node, index) =>
    index === 4 ? { kind: 'cone', height: 0.66, radius: 0.46 } : node,
  ),
});

/**
 * Brána nad scriptovaným tvarem, **na úrovni modulu**.
 *
 * `shapeProgramSchema.parse()` soudí jen tvar zápisu; přesah přes vlastní
 * `targetBounds` je strukturální kontrola a bydlí ve `validateShapeProgram()`.
 * Bez tohohle řádku se vadný tvar projeví až tím, že po kliknutí na `Apply`
 * prostě nic nenastane — a to je ta nejhorší možná zpětná vazba.
 */
const SHARPENED_ISSUES = validateShapeProgram(SHARPENED_HERO);
if (!SHARPENED_ISSUES.ok)
  throw new Error(`scripted refine shape is invalid: ${SHARPENED_ISSUES.issues[0]}`);

/** Věta, kterou scriptovaný plán popisuje. Musí sedět na to, co se doopravdy stane. */
const SCRIPTED_SUMMARY = 'the cap stretches into a narrow spire';

function DevCamera({ angle }: { readonly angle: number }): null {
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    const radius = Math.hypot(DEMO_CAMERA.position[0], DEMO_CAMERA.position[2]);
    camera.position.set(
      Math.sin(angle) * radius,
      DEMO_CAMERA.position[1],
      Math.cos(angle) * radius,
    );
    camera.lookAt(0, 0, 0);
  }, [angle, camera]);
  return null;
}

/** Výchozí úhel je ten, ve kterém kamera stojí — jinak by `DevCamera` hnula scénou hned. */
const START_ANGLE = Math.atan2(DEMO_CAMERA.position[0], DEMO_CAMERA.position[2]);

export default function RefineDevPage() {
  const [world, setWorld] = useState<ProxyWorld | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sentence, setSentence] = useState('');
  const [change, setChange] = useState<ChangeState | null>(null);
  const [upgrade, setUpgrade] = useState<DetailUpgrade | null>(null);
  const [busy, setBusy] = useState(false);
  const [angle, setAngle] = useState(START_ANGLE);
  const mesher = useRef<MeshClient | null>(null);
  const anchor = useRef<HTMLDivElement | null>(null);
  /** Číslo plánu. Počítadlo, ne UUID: stránka je jednovláknová a test se ho chytá. */
  const changes = useRef(0);

  useEffect(() => {
    const client = createMeshClient();
    mesher.current = client;
    let live = true;

    buildProxyWorld(DEMO_OUTCOME, { mesh: (order) => client.mesh(order) })
      .then((built) => {
        if (live) setWorld(built);
      })
      .catch((error: unknown) => {
        if (live) setFailure(error instanceof Error ? error.message : String(error));
      });

    return () => {
      live = false;
      mesher.current = null;
      client.dispose();
    };
  }, []);

  const selectedObject = useMemo(
    () => DEMO_BLUEPRINT.objects.find((object) => object.stableId === selected) ?? null,
    [selected],
  );

  /**
   * Věta → plán, nebo nabídka kandidátů.
   *
   * `stableId` má přednost před textem, a je to celý smysl výběru klikem: když
   * porotce na objekt ukázal, o cíli rozhodl on, ne rozpoznávač. Rozhoduje se
   * to **před** plánem, takže nejasná věta nestojí nic.
   */
  const submit = useCallback(
    (target?: string) => {
      const chosen = target ?? selected ?? undefined;
      const grounding = groundTarget(sentence, DEMO_BLUEPRINT.objects, chosen);

      if (!grounding.ok) {
        setChange({
          kind: 'candidates',
          reason: grounding.reason,
          candidates: grounding.candidates,
        });
        return;
      }

      // Tahle větev je **skutečné** odmítnutí, ne harness: objekt kreslený
      // kompozicí nemá hrdinský tvar, takže mu ho druhá věta přepsat nemůže.
      // Táž podmínka a týž důvod jako `NO_SHAPE_SOURCE` v `readRefineEmission`.
      if (grounding.target.source.kind !== 'shape') {
        setChange({
          kind: 'refused',
          message: `${grounding.target.label} is drawn by the composition, not by a hero shape, so its shape cannot be rewritten`,
        });
        return;
      }

      changes.current += 1;
      setSelected(grounding.target.stableId);
      setChange({
        kind: 'preview',
        changeId: `change-${changes.current}`,
        summary: SCRIPTED_SUMMARY,
        target: { stableId: grounding.target.stableId, label: grounding.target.label },
        scope: { shape: true, behavior: 0, appearance: 0 },
        // **Týž výpočet jako v routě, ne druhý odhad** (`T35-preservedattr`).
        // Do 6. 9. 2026 tu stálo „všechno kromě cíle", tedy přesně ta věta,
        // kterou blokující nález nezávislé revize v routě zavřel: scénář
        // nepíše žádnou operaci, ale **píše nový tvar**, a jméno uvnitř tvaru
        // se smí rovnat `stableId` jiného objektu.
        preserved: preservedBy(
          DEMO_BLUEPRINT.objects,
          {
            stableId: grounding.target.stableId,
            behavior: [],
            appearance: [],
            shape: SHARPENED_HERO,
          },
          DEMO_BLUEPRINT.world,
        ),
      });
    },
    [selected, sentence],
  );

  /**
   * Potvrzení plánu — **jediné místo, kde se svět mění**.
   *
   * Meshuje se teprve tady, ne při preview: kdyby se mesh objednal už při
   * náhledu, zaplatil by porotce za výměnu, kterou ještě neodsouhlasil, a
   * zrušený náhled by po sobě nechal slot v cizí podobě. Táž hranice jako mezi
   * oběma routami v `T22`.
   */
  const apply = useCallback(async () => {
    if (change === null || change.kind !== 'preview') return;
    const client = mesher.current;
    if (client === null) return;

    setBusy(true);
    try {
      const resolution = MESH_DETAIL.high.resolution;
      const mesh = await client.mesh({
        program: SHARPENED_HERO,
        sessionSeed: DEMO_BLUEPRINT.sessionSeed,
        resolution,
        bounds: SHARPENED_HERO.targetBounds,
      });
      setUpgrade({
        stableId: change.target.stableId,
        contentHash: shapeContentHash(SHARPENED_HERO, resolution),
        level: 'high',
        mesh,
      });
      setChange(null);
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [change]);

  /** Zahození. Sahá **jen** na panel — svět, revize ani slot se nehnou. */
  const discard = useCallback(() => {
    setChange(null);
  }, []);

  const status =
    failure !== null
      ? `refine harness failed: ${failure}`
      : world === null
        ? 'building the rough world…'
        : world.kind === 'built'
          ? `${world.slots.length} slots — the plan is scripted, the grounding is real`
          : `declined: ${world.reason}`;

  return (
    <WorldstreamApp
      inspecting={false}
      onInspect={() => {}}
      inspect={null}
      stage={
        <Canvas
          gl={{ ...WORLDSTREAM_GL }}
          shadows={WORLDSTREAM_SHADOWS}
          camera={{ position: [...DEMO_CAMERA.position], fov: DEMO_CAMERA.fov }}
          data-testid="worldstream-stage-canvas"
        >
          <WorldstreamLighting />
          <DevCamera angle={angle} />
          {world !== null && (
            <WorldstreamStage
              world={world}
              upgrade={upgrade}
              selected={selected}
              onSelect={setSelected}
              labelAnchor={anchor}
            />
          )}
        </Canvas>
      }
      label={
        selectedObject === null ? null : (
          <ObjectLabel
            label={selectedObject.label}
            stableId={selectedObject.stableId}
            anchor={anchor}
          />
        )
      }
      prompt={
        <form
          data-testid="refine-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          style={{ display: 'flex', gap: 8 }}
        >
          <input
            data-testid="refine-input"
            aria-label="Change something in this world"
            placeholder="Change something in this world"
            value={sentence}
            onChange={(event) => setSentence(event.target.value)}
            style={{
              flex: 1,
              padding: '0.4rem 0.6rem',
              border: `1px solid ${UI_TOKENS.verdigris}`,
              borderRadius: 4,
              background: 'rgba(7, 20, 31, 0.88)',
              color: UI_TOKENS.nacre,
              font: 'inherit',
            }}
          />
          <button type="submit" data-testid="refine-submit" disabled={world === null}>
            Change it
          </button>
        </form>
      }
      status={
        <p className="ws-status" data-testid="refine-status">
          {status}
        </p>
      }
      change={
        change === null ? null : (
          <ChangePreview
            state={change}
            onChoose={(stableId) => submit(stableId)}
            onApply={() => void apply()}
            onDiscard={discard}
            busy={busy}
          />
        )
      }
      controls={
        <button
          type="button"
          data-testid="orbit-camera"
          onClick={() => setAngle((current) => current + 0.35)}
        >
          Orbit the camera
        </button>
      }
    />
  );
}
