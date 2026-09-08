/**
 * Nepálená hlína — materiál hrubé hmoty.
 *
 * Design book §14 a §15.4: hrubá podoba objektu **není šedý placeholder**. Je to
 * první legitimní fáze světa a má vlastní výtvarný jazyk: hladký, světlý povrch
 * s jemnými konturami struktury. Šedý blok by říkal „tady něco chybí"; hlína
 * říká „tohle ještě neztvrdlo", a to je pravda o tom, co se zrovna děje.
 *
 * ## Proč `MeshStandardMaterial`, a ne toon jako zbytek scény
 *
 * Toon láme světlo do stupňů, což je čitelné u hranatých kusů kitu, ale na
 * organickém tvaru z toho jsou pruhy místo objemu. Hlína má být **hmota**, tedy
 * spojité stínování. Cena je jeden materiál navíc v shaderu, ne druhý rig.
 *
 * `MeshToonMaterial` navíc nemá `flatShading` (past v `CLAUDE.md`), takže by se
 * ploché normály musely zapékat do geometrie — u tvarů, které od vlny 1 přijdou
 * z meshovače, by to znamenalo přepisovat cizí buffer.
 *
 * ## Co ta čísla dělají
 *
 * - `roughness 0.82` — hlína není lesklá, ale ani úplně matná; zbytek lesku nese
 *   siluetu proti tmavému pozadí.
 * - `metalness 0` — hlína není kov, a i malá hodnota by z ní udělala keramiku.
 * - `emissive` na šest procent vlastní barvy — **odvrácená strana nesmí být
 *   černá plocha bez tvaru**. Není to svítící objekt; je to podlaha jasu, pod
 *   kterou se tvar ztrácí. Rig má jen čtyři světla (`VIEWER_BUDGETS.maxLights`),
 *   takže tohle je levnější než páté.
 *
 * Barva je token `clay` z palety (design book §15.1), ne hex napsaný tady:
 * jedna kopie, kterou hlídá `src/app/__tests__/theme.test.ts`.
 */

import { Color, type ColorRepresentation, MeshStandardMaterial } from 'three';

import { UI_TOKENS } from '@/kit';

/**
 * Naladění hlíny jako **data, ne jen jako atributy v JSX**.
 *
 * Vyváží se ze stejného důvodu jako `KEY_LIGHT` v `Lighting.tsx`: měření nebo
 * druhá scéna, která si čísla napíše po svém, soudí jiný materiál než produkt.
 */
export const CLAY = {
  color: UI_TOKENS.clay,
  roughness: 0.82,
  metalness: 0,
  /** Podíl vlastní barvy, který povrch vydá sám. Viz hlavička — podlaha jasu. */
  emissiveShare: 0.06,
} as const;

export interface ClayOverrides {
  /**
   * Jiný odstín téže hmoty. Výchozí je token `clay`.
   *
   * `ColorRepresentation`, ne `string`: volající často odstín teprve míchá
   * (`new Color(a).lerp(b, t)`) a převádět výsledek zpátky na hex jen kvůli
   * téhle signatuře znamená ztratit přesnost a připsat řádek, který nic neřeší.
   */
  readonly color?: ColorRepresentation;
  readonly roughness?: number;
  readonly emissiveShare?: number;
  /** Ploché normály pro fasetovaný, sekaný povrch. Výchozí je hladký. */
  readonly flatShading?: boolean;
  /**
   * Barvu nese geometrie, ne materiál.
   *
   * Kusy kitu si odstín vezou ve vrcholech a paleta je přebarvuje (`repaint`),
   * takže scéna složená z programu potřebuje **bílý** základ a `vertexColors`.
   * Bez toho se celá vykreslí jediným odstínem hlíny — naměřeno 28. 8. 2026 na
   * cílovém snímku, kde tím splynula skála se zdmi a obraz ztratil hodnotovou
   * stavbu.
   */
  readonly vertexColors?: boolean;
}

/**
 * Nový materiál hlíny.
 *
 * **Vrací pokaždé novou instanci a je to schválně.** Materiál je zdroj, který
 * drží renderer, a sdílená instance by znamenala, že jedno `dispose()` sebere
 * povrch všem, kdo si ji půjčili. Volající si ji uklidí sám — v R3F to dělá
 * `disposeSubtree()` z `./dispose`.
 */
export function clayMaterial(overrides: ClayOverrides = {}): MeshStandardMaterial {
  const color = new Color(overrides.color ?? CLAY.color);
  const share = overrides.emissiveShare ?? CLAY.emissiveShare;

  return new MeshStandardMaterial({
    color,
    roughness: overrides.roughness ?? CLAY.roughness,
    metalness: CLAY.metalness,
    emissive: color.clone().multiplyScalar(share),
    flatShading: overrides.flatShading ?? false,
    vertexColors: overrides.vertexColors ?? false,
  });
}
