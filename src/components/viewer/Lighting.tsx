'use client';

/**
 * Světelný rig, tone mapping, stíny a mlha — jedno místo pro obě plátna.
 *
 * Do T6 si `Stage.tsx` i `Viewer.tsx` držely vlastní dvojici světel (ambientní
 * plus jedno směrové) a vlastní kopii toon rampy. Dvě kopie znamenaly dvě místa,
 * kde se vzhled rozejde, a scéna z nich vycházela plochá: jediné směrové světlo
 * nevrhalo stín, takže nic nesedělo na podlaze, a bez tone mappingu se světlá
 * místa slévala do bílé.
 *
 * **Co je tady a co je na plátně.** Rozděluje to jedna technická věc, ne vkus:
 * `antialias` je atribut kontextu a po jeho vytvoření se změnit nedá, takže
 * musí být u `<Canvas gl={...}>`. Proto se odsud vyváží `VIEWER_GL` — plátno
 * ho jen podá dál a nerozhoduje o něm. Stíny zapíná `<Canvas shadows>`, protože
 * tak si je R3F sám nastaví na měkkou variantu.
 *
 * **Žádný `<Environment preset>` z drei** (past #2 z `TOOLING.md`): stahoval by
 * HDRI z raw.githack.com za běhu a rozbil by „žádný loading screen" i service
 * worker. Všechna čtyři světla jsou ruční a nic se nenačítá ze sítě.
 */

import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { ACESFilmicToneMapping, DataTexture, Fog, LinearFilter, RedFormat, VSMShadowMap } from 'three';

import { VIEWER_BUDGETS } from '@/kit';

/**
 * Parametry kontextu a rendereru pro obě plátna.
 *
 * `antialias: true` je změna proti stavu do T6 a stojí výkon — na scéně
 * složené z hranatých kusů je ale schodovitá hrana to první, co je vidět, a
 * rozpočet snímku má pod stropem 300 volání dost rezervy.
 *
 * `toneMapping` se nastavuje tady, ne za běhu: je zapečený v shaderu, takže
 * změna po zkompilování materiálů si vynutí překlad všech programů znovu.
 */
export const VIEWER_GL = {
  antialias: true,
  powerPreference: 'high-performance',
  toneMapping: ACESFilmicToneMapping,
  // ACES stahuje střední tóny dolů. Bez korekce je scéna po zapnutí tmavší,
  // než byla předtím, což by z tone mappingu udělalo zhoršení.
  toneMappingExposure: 1.25,
} as const;

/**
 * Mlha.
 *
 * Barva je **schválně** barva stránky (`src/app/layout.tsx`), ne šedá: plátno
 * je průhledné a kreslí se na ni, takže vzdálený kus zmizí do pozadí místo aby
 * do něj byl zapatlaný světlejším oparem. Pásmo je psané na aréna-velikost
 * světů ze zmrazeného korpusu — blíž než 14 jednotek se nemlží nic, za 38
 * jednotkami už je jen pozadí.
 */
export const FOG = { color: '#0b1114', near: 14, far: 38 } as const;

/**
 * Druh stínové mapy pro obě plátna.
 *
 * **`PCFSoftShadowMap` tady být NEMŮŽE, i když to je jméno, které by člověk
 * čekal.** V three 0.185.1 je zastaralý a `WebGLShadowMap.render()` si ho při
 * prvním vykreslení sám přepíše zpátky na tvrdý `PCFShadowMap`
 * (`three/build/three.module.js:9147`, s varováním do konzole). Naměřeno:
 * `shadows` jako `true` i jako `'soft'` skončily obojí na typu 1, ne 2 — tedy
 * na nefiltrované hraně, o které krok úlohy nemluví.
 *
 * `'variance'` je v R3F jméno pro `VSMShadowMap`, jedinou neodloženou měkkou
 * variantu, kterou tahle verze three nabízí. Platí se za ni dvěma věcmi a obě
 * jsou vyřešené u světla níž: stín se rozmazává poloměrem (`shadow-radius`),
 * takže potřebuje víc vzorků, a je citlivý na rozsah stínové kamery, takže ta
 * je utažená na scénu místo aby sahala od nuly do nekonečna.
 */
export const VIEWER_SHADOWS = 'variance' as const;

/**
 * Číselný typ stínové mapy, který má renderer po nastavení doopravdy mít.
 *
 * Vyváží se schválně: `e2e/render-quality.spec.ts` se ptá rendereru a porovnává
 * s tímhle. Bez toho by test nezachytil právě tu vadu, která tuhle konstantu
 * vyrobila — že knihovna nastavení tiše přepíše na něco jiného.
 */
export const SHADOW_MAP_TYPE: number = VSMShadowMap;

/** Polovina hrany stínového ortho-boxu. Pokryje mřížku 40×40 buněk, tedy každý svět z korpusu. */
const SHADOW_EXTENT = 16;

/**
 * Hlavní světlo jako **data, ne jen jako atributy v JSX**.
 *
 * Vyváží se schválně. Do T25 si každé měření siluety psalo vlastní směr světla —
 * `e2e/divergence.spec.ts` má `Vector3(0.4, 0.85, 0.3)`, nikde neodvozený od
 * rigu — takže snímek, nad kterým se soudil vzhled rodin, byl nasvícený jinak
 * než produkt. Dvě čísla pro totéž rozhodnutí se rozejdou; tohle je to jedno.
 */
export const KEY_LIGHT = {
  position: [7, 12, 5],
  intensity: 1.55,
  color: '#ffeccd',
} as const;

/**
 * Stupně toon rampy. Vyváží se ze stejného důvodu jako `KEY_LIGHT` — měření,
 * které si stupně napíše po svém, soudí jiné stínování než produkt.
 */
export const TOON_LEVELS: readonly number[] = [40, 110, 190, 255];

/**
 * Toon rampa jako skutečná textura.
 *
 * Bydlí u rigu, protože je to druhá polovina téhož rozhodnutí: rampa říká, jak
 * se světlo láme do stupňů, a bez ní by `MeshToonMaterial` stínoval spojitě.
 * Do T6 byla zkopírovaná ve `Viewer.tsx` i `WorldScene.tsx` a komentář v obou
 * na tuhle úlohu odkazoval.
 *
 * Není to ozdoba ani z druhého důvodu: bez ní nese scéna nula textur a oracle
 * úklidu po padesátinásobném přepnutí by o jejich uvolnění netvrdil nic.
 */
export function toonRamp(): DataTexture {
  const levels = new Uint8Array(TOON_LEVELS);
  const texture = new DataTexture(levels, levels.length, 1, RedFormat);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Tři směrová světla a jedno polokulové ambientní.
 *
 * - **Hlavní** zprava shora, teplé, jediné vrhá stín. Stín je to, čím předmět
 *   dosedne na podlahu; bez něj se všechno vznáší.
 * - **Doplňkové** zleva a studené, zhruba třetinová síla. Vyplní stín tak, aby
 *   odvrácená strana nebyla černá plocha bez tvaru.
 * - **Obrysové** zezadu. Odděluje postavu od pozadí — na toon materiálu je to
 *   ta linka, po které se hráč v davu entit pozná.
 * - **Polokulové ambientní** místo rovnoměrného: obloha nad, země pod, takže i
 *   neosvětlená plocha nese informaci o tom, kudy je nahoru.
 */
export default function Lighting() {
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    scene.fog = new Fog(FOG.color, FOG.near, FOG.far);
    return () => {
      scene.fog = null;
    };
  }, [scene]);

  return (
    <>
      <hemisphereLight args={['#8fc9c2', '#12191c', 0.5]} />
      <directionalLight
        castShadow
        position={[...KEY_LIGHT.position]}
        intensity={KEY_LIGHT.intensity}
        color={KEY_LIGHT.color}
        shadow-mapSize={[VIEWER_BUDGETS.shadowMapSize, VIEWER_BUDGETS.shadowMapSize]}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
        // Utažené na scénu, ne od nuly do nekonečna: VSM ukládá hloubku a její
        // druhou mocninu, takže volný rozsah rozpustí přesnost a stín začne
        // prosakovat skrz stěny. Světlo stojí ~15 jednotek od počátku.
        shadow-camera-near={2}
        shadow-camera-far={34}
        // Rozmazání okraje. Tohle je ta „měkkost" — u VSM ji dělá poloměr, ne
        // druh filtru, takže bez něj by byl stín ostrý i s měkkou mapou.
        shadow-radius={2}
        shadow-blurSamples={10}
        // Bez posunu sedí na zaoblených kusech stínové proužky (shadow acne).
        // `normalBias` je proti `bias` lepší, protože neodlepí stín od paty.
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      />
      <directionalLight position={[-8, 5, -3]} intensity={0.45} color="#84b4c4" />
      <directionalLight position={[0, 4, -10]} intensity={0.7} color="#cdece4" />
    </>
  );
}
