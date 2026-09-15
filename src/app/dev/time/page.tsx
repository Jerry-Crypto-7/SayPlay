'use client';

/**
 * `/dev/time` — vývojová adresa přetáčení času (P15 T24).
 *
 * ## Proč vlastní adresa
 *
 * Týž důvod jako u `/dev/worldstream` (`T19b`) a `/dev/refine` (`T23`): na
 * jedné adrese se soudí jedna věc. Tahle se ptá „přetočí se svět, odbočí se
 * z minulosti, a nechá to plátno na pokoji?". Kdyby k tomu byla potřeba relace,
 * proud a model, červená by neřekla, která z těch pěti věcí se rozbila.
 *
 * ## Co je tady doopravdy a co je harness
 *
 * **Doopravdy** je celá simulace: dokument vzniká `buildRuntimeWorld` — tímtéž
 * vstupním bodem, jakým prochází certifikát na hlavní cestě — a osa nad ním
 * krokuje skutečný interpret, ne přehrávku. Doopravdy jsou i reprezentace na
 * plátně: `WorldstreamStage` nad hrubým světem z `DEMO_OUTCOME`.
 *
 * **Harness** je jediná věc: **druhá věta**. V provozu ji píše porotce, model
 * z ní udělá plán a commit z něj nový dokument; tady je scriptovaná a stránka
 * to o sobě říká ve stavové větě. Že model takový plán umí napsat, měří `T40`
 * a `T14`, ne tahle adresa.
 *
 * ## Proč zrovna `calmHive`, a proč tik 20
 *
 * Vypnout se dá kterékoli pravidlo, jenže **většina z nich už spustila**, a
 * změna, která nemá kam zasáhnout, dá bitově tutéž budoucnost — osa by pak
 * tvrdila „přepočítáno" a nezměnilo by se nic. Ve zdejším světě spustí
 * `liftSmoker` na tiku 0, `calmHive` na 30 a `win` na 72 (naměřeno 3. 9. 2026),
 * takže odbočka na tiku 20 je jediné místo, odkud `calmHive` ještě leží
 * v budoucnosti.
 *
 * ⚠ **Vypnout `win` by nestačilo, a to je pro celou úlohu důležité:** běh pak
 * nikdy nevyhraje, a přesto skončí s **bitově týmž** zabaleným stavem
 * (`f5a593ab` obojí, naměřeno 3. 9. 2026), protože `runState` do hashe nepatří.
 * `calmHive` naproti tomu hýbe stavem úlu, zámkem brány i příznakem, takže se
 * rozdíl dvou budoucností dá doložit hashem, ne jen nápisem.
 *
 * ## Proč tu není `notFound()` v produkci
 *
 * Táž volba jako u ostatních `/dev` adres: e2e sada **je** produkční build,
 * takže schovaná stránka by se schovala i před vlastním testem.
 */

import { Canvas } from '@react-three/fiber';
import { useCallback, useEffect, useRef, useState } from 'react';

import { buildRuntimeWorld } from '@/ir/build';
import type { WorldDocRuntime } from '@/sim/interpreter';
import { createMeshClient, type MeshClient } from '@/shape/mesh-client';
import { buildProxyWorld, type ProxyWorld } from '@/worldstream/proxy';

import WorldstreamLighting, {
  WORLDSTREAM_GL,
  WORLDSTREAM_SHADOWS,
} from '../../../components/viewer/WorldstreamLighting';
import WorldstreamStage from '../../../components/viewer/WorldstreamStage';
import TimeAxis from '../../../components/worldstream/TimeAxis';
import WorldstreamApp from '../../../components/worldstream/WorldstreamApp';

import { DEMO_BLUEPRINT, DEMO_CAMERA, DEMO_OUTCOME } from '../demo-world';

/**
 * Běhový dokument ukázkového světa, **na úrovni modulu**.
 *
 * Táž volba jako u scriptovaného tvaru v `/dev/refine`: kdyby se snížení
 * nepovedlo, projeví se to jinak jako „osa se nikdy neobjevila", což je ta
 * nejhorší možná zpětná vazba.
 */
const BUILT = buildRuntimeWorld((DEMO_BLUEPRINT.world as { sim: unknown }).sim);
if (!BUILT.ok) throw new Error(`demo world does not lower: ${BUILT.issues[0]}`);

const DEMO_WORLD: WorldDocRuntime = BUILT.world;

/** Pravidlo, které scriptovaná druhá věta umlčí. */
const SILENCED = 'calmHive';

/** Věta, kterou ten zásah popisuje. Musí sedět na to, co se doopravdy stane. */
const SCRIPTED_SENTENCE = 'the smoke never calms the hive';

/**
 * Scriptovaná druhá věta jako dokument.
 *
 * Mění se **jen graf pravidel** — sloty, entity ani prostor ne. Je to jediná
 * změna, kterou `rebranchAt` z minulosti pustí, a taky jediná, která dává
 * smysl: přesadit zabalený stav do jinak rozvrženého runtimu znamená, že každé
 * číslo v něm začne znamenat něco jiného, a nic nespadne.
 */
function withoutTheCalm(current: WorldDocRuntime): { doc: WorldDocRuntime; ruleId: string } | null {
  const rules = current.ir.rules.filter((rule) => rule.ruleId !== SILENCED);
  if (rules.length === current.ir.rules.length) return null;
  return { doc: { ...current, ir: { ...current.ir, rules } }, ruleId: SILENCED };
}

export default function TimeDevPage() {
  const [world, setWorld] = useState<ProxyWorld | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const mesher = useRef<MeshClient | null>(null);

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

  const nextDocument = useCallback((current: WorldDocRuntime) => withoutTheCalm(current), []);

  const status =
    failure !== null
      ? `time harness failed: ${failure}`
      : world === null
        ? 'building the rough world…'
        : world.kind === 'built'
          ? `${world.slots.length} slots — the axis is real, the second sentence is scripted: “${SCRIPTED_SENTENCE}”`
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
          {world !== null && <WorldstreamStage world={world} />}
        </Canvas>
      }
      axis={<TimeAxis world={DEMO_WORLD} phase="change" nextDocument={nextDocument} />}
      prompt={
        <p data-testid="time-prompt" className="ws-status">
          Drag the axis back, then change one law and watch the future differ.
        </p>
      }
      status={
        <p className="ws-status" data-testid="time-status">
          {status}
        </p>
      }
    />
  );
}
