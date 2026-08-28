/**
 * Additivní materiály atmosféry — kužely světla, záře a plovoucí prach.
 *
 * Do P14 T1 patřily cílovému snímku a hlavička to tak i říkala. Teď je volá
 * `Atmosphere.tsx`, tedy vrstva, kterou používá **i produktový prohlížeč** —
 * barva a síla proto chodí parametrem a v tomhle souboru není jediná paleta.
 *
 * ## Proč ručně psaný shader a ne knihovna
 *
 * `@react-three/postprocessing` by dal bloom jedním řádkem a `CLAUDE.md` ho
 * zakazuje: má tvrdou závislost na `n8ao`, což je **90,9 kB gzip v jednom
 * netreeshakovatelném souboru**. Atmosféra má být důkaz, že produkt umí
 * vypadat dobře v rozpočtu, který si sám stanovil — dotáhnout ho balíkem, který
 * se do produktu stejně nesmí dostat, by ten důkaz zrušilo.
 *
 * Tři shadery níž mají dohromady pod čtyřicet řádků GLSL a stojí nula bajtů
 * navíc, protože `three` už v bundlu je.
 *
 * ## Proč jsou tady oba `#include`
 *
 * `ShaderMaterial` **nedostane** správu barevného prostoru zadarmo — na rozdíl
 * od `MeshStandardMaterial`, kam ji `three` vkládá sám. Bez
 * `<colorspace_fragment>` by se lineární hodnota z `new Color('#f1b24a')`
 * zapsala do sRGB framebufferu tak, jak je, a záře by vyšla znatelně tmavší,
 * než jakou barvu má v paletě. Naopak `toneMapped: false` je záměr: ACES sráží
 * jasy nad jedničku, a záře má být to jediné v obraze, co přepálí.
 *
 * ## Čím se počítá průhlednost
 *
 * `AdditiveBlending` v `three` je `srcAlpha * src + dst`, takže **rozhoduje
 * alfa, ne barva**. Všechny tři shadery proto drží barvu na plné hodnotě
 * a modelují tvar jen v alfě.
 */

import {
  AdditiveBlending,
  Color,
  type ColorRepresentation,
  ShaderMaterial,
  Vector3,
} from 'three';

/** Společný konec fragment shaderu. Pořadí je dané `three`, ne volbou. */
const OUTPUT = `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

/**
 * Kužel světla procházející vodou.
 *
 * Jas se řídí **facing ratio** — kolik objemu je v daném pixelu vidět skrz.
 * Uprostřed siluety míří normála do kamery (`dot ≈ 1`) a cesta paprsku skrz
 * kužel je nejdelší; na okraji je normála kolmá (`dot ≈ 0`) a objemu je málo.
 * Je to tentýž vztah, jaký dělá skutečný světelný sloup, jen spočítaný z jedné
 * plochy místo z integrálu.
 */
export function shaftMaterial(color: ColorRepresentation, intensity: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(color) },
      uIntensity: { value: intensity },
    },
    vertexShader: `
      varying vec3 vNormalView;
      varying vec3 vViewDir;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vNormalView = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec3 vNormalView;
      varying vec3 vViewDir;
      varying vec2 vUv;
      void main() {
        float facing = abs(dot(normalize(vNormalView), normalize(vViewDir)));
        // Nahoře u zdroje plná síla, dolů se paprsek rozpouští ve vodě.
        float along = smoothstep(0.0, 0.28, vUv.y) * smoothstep(0.02, 0.55, vUv.y);
        gl_FragColor = vec4(uColor, uIntensity * facing * facing * along);
        ${OUTPUT}
      }
    `,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}

/**
 * Kruhová záře kolem světelného zdroje — náhrada bloomu.
 *
 * Kreslí se na čtverec, který se každý snímek otáčí čelem ke kameře. Spád je
 * `pow(1 - r, 3)`, tedy ostré jádro a dlouhý měkký doběh; lineární spád vypadá
 * jako nálepka, protože oko čte jeho hranu.
 */
export function haloMaterial(color: ColorRepresentation, intensity: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(color) },
      uIntensity: { value: intensity },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float fall = pow(max(0.0, 1.0 - r), 3.0);
        gl_FragColor = vec4(uColor, uIntensity * fall);
        ${OUTPUT}
      }
    `,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    // **`depthTest: false` je tady rozdíl mezi září a neviditelným čtvercem.**
    // Záře sedí na ose zdroje, takže ji těleso zdroje samo zakrývalo a v obraze
    // po ní nezbylo nic. Vypnutý hloubkový test navíc odpovídá tomu, co světlo
    // v kalné vodě dělá: rozptýlí se i kolem překážky, místo aby za ní ostře
    // skončilo. Platí jen pro záři — kužely i prach hloubku testují dál.
    depthTest: false,
    toneMapped: false,
  });
}

/**
 * Prach ve vodě.
 *
 * `Points` místo instancovaných čtverců: bod je vždycky čelem ke kameře zadarmo
 * a celé pole je **jedno kreslicí volání**. Velikost se zmenšuje se vzdáleností
 * ručně, protože `sizeAttenuation` je vlastnost `PointsMaterial`, ne shaderu.
 *
 * `uTime` posouvá zrnka po malé smyčce. Je to nástěnný čas a smí to tak být —
 * atmosféra stojí mimo hashovaný stav (`CLAUDE.md`), stejně jako částice,
 * zvuk, kamera a postprocessing.
 */
export function moteMaterial(color: ColorRepresentation, size: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(color) },
      uSize: { value: size },
      uTime: { value: 0 },
      uDrift: { value: new Vector3(0.35, 0.12, 0.2) },
    },
    vertexShader: `
      uniform float uSize;
      uniform float uTime;
      uniform vec3 uDrift;
      attribute float aPhase;
      varying float vFade;
      void main() {
        vec3 drift = vec3(
          sin(uTime * 0.21 + aPhase) * uDrift.x,
          sin(uTime * 0.13 + aPhase * 1.7) * uDrift.y,
          cos(uTime * 0.17 + aPhase * 0.9) * uDrift.z
        );
        vec4 mv = modelViewMatrix * vec4(position + drift, 1.0);
        // Zrnka blíž ke kameře jsou větší i jasnější; vzdálená se ztratí v mlze.
        gl_PointSize = uSize * (26.0 / max(1.0, -mv.z));
        vFade = clamp(1.0 - (-mv.z) / 95.0, 0.0, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vFade;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float fall = pow(max(0.0, 1.0 - r), 2.0);
        gl_FragColor = vec4(uColor, fall * vFade * 0.75);
        ${OUTPUT}
      }
    `,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}
