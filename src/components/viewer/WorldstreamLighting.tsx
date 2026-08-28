'use client';

/**
 * Světelný rig WORLDSTREAM — „živá kartografie hmoty" (design book §15).
 *
 * Stojí vedle `Lighting.tsx`, nenahrazuje ho, a je to vědomé rozdělení: starý
 * rig svítí na scénu složenou z hranatých kusů kitu a je vyladěný na toon
 * stínování. Tenhle svítí na **hmotu** — organické tvary z hlíny a kamene nad
 * černou vodou. Kdyby to byl jeden rig s přepínačem, byla by to jedna sada
 * čísel, která nesedí ani jedné scéně.
 *
 * ## Čtyři světla, ani o jedno víc
 *
 * `VIEWER_BUDGETS.maxLights` je **4** a komentář u něj říká proč: páté světlo je
 * změna návrhu, kterou má někdo obhájit, ne věc, co přiteče mimochodem. Tři
 * varhany v cílovém snímku proto **nesvítí jako světla**, ale jako emisivní
 * materiál. Vypadá to stejně, stojí to nula a strop drží.
 *
 * ## Žádný `<Environment preset>` z drei
 *
 * Past #2 z `TOOLING.md`: stahuje HDRI z `raw.githack.com` za běhu, tedy rozbíjí
 * „žádný loading screen" i service worker. Všechna světla jsou ruční a ze sítě
 * se nenačítá nic.
 *
 * ## Mlha je barva pozadí, ne šedá
 *
 * Táž úvaha jako v `Lighting.tsx`, jiná čísla: svět cílového snímku je desítky
 * jednotek dlouhý, ne aréna 40×40. Mlha proto začíná dál a končí až za scénou —
 * má oddělit plány hloubky, ne schovat pozadí.
 */

import { useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { ACESFilmicToneMapping, Fog, VSMShadowMap } from 'three';

import { UI_TOKENS, VIEWER_BUDGETS } from '@/kit';

/**
 * Parametry kontextu a rendereru.
 *
 * Kopíruje `VIEWER_GL` v tom, co je technická nutnost (`antialias` je atribut
 * kontextu a po vytvoření se nemění, tone mapping je zapečený v shaderu), a liší
 * se v expozici: scéna je tmavší a stojí na mědi a jantaru, které ACES při 1,25
 * přepaluje do bílé.
 */
export const WORLDSTREAM_GL = {
  antialias: true,
  powerPreference: 'high-performance',
  toneMapping: ACESFilmicToneMapping,
  toneMappingExposure: 1.05,
} as const;

/** Měkká varianta stínů. Důvod, proč ne `PCFSoftShadowMap`, je v `Lighting.tsx`. */
export const WORLDSTREAM_SHADOWS = 'variance' as const;

/** Číselný typ stínové mapy, který má renderer po nastavení doopravdy mít. */
export const WORLDSTREAM_SHADOW_MAP_TYPE: number = VSMShadowMap;

/**
 * Mlha.
 *
 * `near` je za předním okrajem kompozice, takže hrdinský tvar zůstane ostrý;
 * `far` je až za nejzazším žebrem, takže se svět neztratí, jen ustoupí.
 *
 * **`far` je 120, ne 96, a je to důsledek měření.** Mlha má barvu pozadí, takže
 * `far` není „kde se věc ztratí v oparu", ale **kde přestane existovat** — za
 * ním se kreslí přesně barva pozadí. Při 96 spadly všechny skály z `Spires`
 * pod tu hranici a v obraze po nich nezbylo nic, dvakrát po sobě. Posun na 120
 * jim otevře pásmo, ve kterém z nich zůstane silueta, a nejzazší žebro to stojí
 * pár procent kontrastu.
 */
export const WORLDSTREAM_FOG = { color: UI_TOKENS.pelagic, near: 22, far: 120 } as const;

/**
 * Hlavní světlo. Zprava shora a zezadu, teplé — jantar (`amber`) je v paletě
 * barva hotové kotvy, takže hlavní světlo scény ladí s tím, co je v ní hotové.
 *
 * Vyváží se jako data, ne jen jako atributy v JSX: měření siluety, které si směr
 * napíše po svém, soudí jinak nasvícený snímek než produkt.
 */
export const WORLDSTREAM_KEY_LIGHT = {
  position: [26, 34, 18],
  intensity: 2.1,
  color: '#ffe4b5',
} as const;

/** Polovina hrany stínového ortho-boxu. Pokryje celou kompozici cílového snímku. */
const SHADOW_EXTENT = 40;

export default function WorldstreamLighting() {
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    scene.fog = new Fog(WORLDSTREAM_FOG.color, WORLDSTREAM_FOG.near, WORLDSTREAM_FOG.far);
    return () => {
      scene.fog = null;
    };
  }, [scene]);

  return (
    <>
      {/* Obloha měděná, dno pelagické. I neosvětlená plocha tak nese informaci
          o tom, kudy je nahoru — u organického tvaru je to jediné, co drží
          objem, když na něj nesvítí hlavní světlo. */}
      <hemisphereLight args={[UI_TOKENS.verdigris, UI_TOKENS.pelagic, 0.55]} />
      <directionalLight
        castShadow
        position={[...WORLDSTREAM_KEY_LIGHT.position]}
        intensity={WORLDSTREAM_KEY_LIGHT.intensity}
        color={WORLDSTREAM_KEY_LIGHT.color}
        shadow-mapSize={[VIEWER_BUDGETS.shadowMapSize, VIEWER_BUDGETS.shadowMapSize]}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
        // Utažené na scénu, ne od nuly do nekonečna: VSM ukládá hloubku a její
        // druhou mocninu, takže volný rozsah rozpustí přesnost a stín začne
        // prosakovat skrz žebra. Světlo stojí ~47 jednotek od počátku.
        shadow-camera-near={8}
        shadow-camera-far={110}
        shadow-radius={3}
        shadow-blurSamples={12}
        shadow-bias={-0.0006}
        shadow-normalBias={0.05}
      />
      {/* Výplň zleva, studená. Bez ní je odvrácená strana žeber černá plocha. */}
      <directionalLight position={[-30, 12, 10]} intensity={0.5} color="#7fb6c6" />
      {/* Obrys zezadu, měděný. Na tmavém pozadí je to jediné, čím se silueta
          hrdinského tvaru odlepí od mlhy.

          **Posunutý z osy, ne uprostřed.** Když stál na `x = -6`, jeho odlesk na
          hladině spadl přesně pod střed kompozice a stal se z něj svislý pruh
          přes celou dolní třetinu obrazu — tedy nejjasnější věc ve snímku byla
          prázdná voda. Odsazení odlesk odsune stranou, kde drží hloubku místo
          aby soupeřil s věží. */}
      <directionalLight position={[-24, 15, -32]} intensity={0.62} color={UI_TOKENS.verdigris} />
    </>
  );
}
