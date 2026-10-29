'use client';

/**
 * Vinětace při pohybu světa (P67 T7). Na pódiu tratí jede svět k hráči a hlava stojí; pohyb v okraji zorného pole
 * bez pohybu těla dělá části hráčů nevolno (doporučení Mety). Ztmavený okraj obrazu ho skryje, střed zůstane čistý.
 * Síla roste s rychlostí světa (m/s skutečného prostoru) a plynule doběhne, když svět stojí (výsledek, náhled).
 *
 * Kreslí se jako obdélník přes celý obraz každého oka – souřadnice jsou rovnou v NDC, kamera se nepoužije – po
 * scéně a pod panely HUD (`PANEL_ORDER`), takže text panelů neztmaví. Jen kresba: do hry nejde nic.
 *
 * Vypínač (`setVignetteOn`) patří komfortnímu panelu (T9), jen v paměti stránky; výchozí je zapnuto. Je tady, v kódu
 * XR, ne v `xr-context.ts`: ten je v prvním JS telefonu.
 */

import { useFrame } from '@react-three/fiber';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { Color, type Mesh, ShaderMaterial } from 'three';

import { colorHex } from '@/brand/tokens';

import { PANEL_ORDER } from './XrPanel';

let on = true;

/** Vinětace zapnutá? */
export const vignetteOn = (): boolean => on;

export function setVignetteOn(value: boolean): void {
  on = value;
}

/**
 * - `from`, `full` – rychlost světa (m/s), od které vinětace začíná a od které je plná. Běžec na pódiu 1:4 jede
 *   ~2,5 m/s, závod 1:8 ~2,6 m/s, flap ~0,7 m/s, plošinovka ~0,5 m/s, hop ~0,2 m/s;
 * - `opacity` – nejtmavší okraj;
 * - `inner`, `outer` – poloměr v obraze oka (NDC), kde ztmavení začíná a kde je plné;
 * - `ease` – časová konstanta náběhu a doběhu (s): krátké zastavení hrdiny okrajem neblikne.
 */
export const VIGNETTE = { from: 0.2, full: 1.5, opacity: 0.85, inner: 0.55, outer: 1, ease: 0.3 } as const;

/** Cílová síla 0–1 pro rychlost světa; s vypnutou vinětací 0. */
export const vignetteOf = (speed: number): number => (on ? Math.min(1, Math.max(0, (speed - VIGNETTE.from) / (VIGNETTE.full - VIGNETTE.from))) : 0);

const VERTEX = /* glsl */ `
varying vec2 vAt;
void main() {
  vAt = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float strength;
varying vec2 vAt;
void main() {
  gl_FragColor = vec4(color, strength * smoothstep(${VIGNETTE.inner.toFixed(2)}, ${VIGNETTE.outer.toFixed(2)}, length(vAt)));
  #include <colorspace_fragment>
}
`;

/** `speed` = rychlost světa v posledním snímku (m/s), píše ji `Diorama`. */
export function XrVignette({ speed }: { readonly speed: RefObject<number> }) {
  const mesh = useRef<Mesh>(null);
  const strength = useRef(0);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: { color: { value: new Color(colorHex.ink) }, strength: { value: 0 } },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  useFrame((_, delta) => {
    const node = mesh.current;
    if (node === null) return;
    strength.current += (vignetteOf(speed.current) - strength.current) * (1 - Math.exp(-delta / VIGNETTE.ease));
    material.uniforms.strength!.value = strength.current * VIGNETTE.opacity;
    // Bez ztmavení se nekreslí: dvě volání (oči) navíc jen při pohybu.
    node.visible = strength.current > 0.005;
    node.userData.xrVignette = strength.current;
  });

  return (
    <mesh ref={mesh} material={material} frustumCulled={false} renderOrder={PANEL_ORDER - 1} visible={false}>
      <planeGeometry args={[2, 2]} />
    </mesh>
  );
}
