/**
 * Kreslený vzhled (P56B T6): jeden shaderový patch nad `MeshStandardMaterial`, nasazený tam, kde
 * materiály už vznikají (`load.ts`). Dvě věci, žádná nová textura ani světlo:
 * - přímé světlo ve třech stupních (úzká hrana `smoothstep`), polokoule zůstává hladká a vyplní stíny;
 * - kulisy posunuté k odstínu nejbližší barvy palety sady (Oklab, světlost zůstane); hrdina, nepřátelé a záře věcí ne.
 * Paletu nesou sdílené uniformy (`setScenePalette` v rigu, vzor `setCharacterRim`): sada, nálada ani úroveň
 * kvality program nepřekládají.
 *
 * Kulisy nemají Fresnel okraj: modely s mnoha ploškami bokem k pohledu (koruny, kmeny, výplň hřbitova) a s
 * plochami otočenými od kamery jím zešedly – slepý soud T13 to dvakrát jmenoval („broken white materials“ v noci,
 * T13-R1; „grey, broken-looking tree textures“ ve dne, T13-R2). Obrys postav nese jejich svit (`setCharacterRim`).
 */
import { Color, ShaderChunk, Vector3, type WebGLProgramParametersWithUniforms } from 'three';

import type { Look } from '@/play/arcade/look';

/** Kotvy v `ShaderChunk` three 0.185.1; `toon.test.ts` hlídá, že každá existuje právě jednou. */
export const DOT_NL = 'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );';
export const LIGHTS = '#include <lights_physical_pars_fragment>';
export const COLOR = '#include <color_fragment>';
export const COMMON = '#include <common>';

/** Kolik barev palety sady shader porovnává: `ground`, `tint` ×2, `block`, `track`, `horizon`. */
export const PALETTE_SIZE = 6;
/** Kolik kulisy přimíchají z nejbližší barvy palety. */
export const PALETTE_MIX = 0.3;
/**
 * Lineární jas obzoru, pod kterým je scéna noční: noc `#172c45` ~0,024, strašidelný hřbitov ~0,03, vesmír a jeskyně
 * pod 0,03; podmořský svět (0,14), sopka (0,12) a strašidelný hrad (0,14) už ne.
 */
const DARK_HORIZON = [0.03, 0.1] as const;

/** Jak noční je obloha sady: 0 den, 1 noc (P56B T7) – podle ní sílí expozice rigu. */
export function darkness(look: Pick<Look, 'horizon'>): number {
  const { r, g, b } = new Color(look.horizon);
  const horizon = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return Math.min(Math.max((DARK_HORIZON[1] - horizon) / (DARK_HORIZON[1] - DARK_HORIZON[0]), 0), 1);
}

/** Paleta jde do shaderu už v Oklab (spočítaná jednou na sadu), barva pixelu se převádí tam a zpět. */
export const toon = {
  palette: { value: Array.from({ length: PALETTE_SIZE }, () => new Vector3()) },
  mix: { value: 0 },
};

const HEAD = `
uniform vec3 toonPalette[${PALETTE_SIZE}];
uniform float toonMix;
float toonBands( float x ) { return mix( 0.5 * smoothstep( 0.0, 0.06, x ), 1.0, smoothstep( 0.42, 0.48, x ) ); }
vec3 toonLab( vec3 c ) {
	vec3 lms = pow( max( mat3( 0.4122214708, 0.2119034982, 0.0883024619, 0.5363325363, 0.6806995451, 0.2817188376, 0.0514459929, 0.1073969566, 0.6299787005 ) * c, 0.0 ), vec3( 1.0 / 3.0 ) );
	return mat3( 0.2104542553, 1.9779984951, 0.0259040371, 0.7936177850, -2.4285922050, 0.7827717662, -0.0040720468, 0.4505937099, -0.8086757660 ) * lms;
}
vec3 toonRgb( vec3 lab ) {
	vec3 lms = mat3( 1.0, 1.0, 1.0, 0.3963377774, -0.1055613458, -0.0894841775, 0.2158037573, -0.0638541728, -1.2914855480 ) * lab;
	return max( mat3( 4.0767416621, -1.2684380046, -0.0041960863, -3.3077115913, 2.6097574011, -0.7034186147, 0.2309699292, -0.3413193965, 1.7076147010 ) * ( lms * lms * lms ), 0.0 );
}
vec3 toonPaletteMix( vec3 c ) {
	vec3 lab = toonLab( c );
	vec3 best = toonPalette[ 0 ];
	float bestGap = 1e9;
	for ( int i = 0; i < ${PALETTE_SIZE}; i ++ ) {
		vec3 d = toonPalette[ i ] - lab;
		float gap = dot( d, d );
		if ( gap < bestGap ) { bestGap = gap; best = toonPalette[ i ]; }
	}
	return toonRgb( vec3( lab.x, mix( lab.yz, best.yz, toonMix ) ) );
}`;
const BANDED = 'float dotNL = toonBands( saturate( dot( geometryNormal, directLight.direction ) ) );';
const PALETTE_LINE = '\n\tdiffuseColor.rgb = toonPaletteMix( diffuseColor.rgb );';

/**
 * Vloží toon do programu, jednou; `palette` přimíchání palety zapne nebo (v kopii postavy či záře) vypne.
 * Kopie volají úpravu zdroje a pak tuto, proto opakované volání jen přepne paletu.
 */
export function toonPatch(shader: WebGLProgramParametersWithUniforms, palette: boolean): void {
  if (!shader.fragmentShader.includes('uniform float toonMix;')) {
    shader.uniforms.toonPalette = toon.palette;
    shader.uniforms.toonMix = toon.mix;
    shader.fragmentShader = shader.fragmentShader.replace(COMMON, `${COMMON}${HEAD}`).replace(LIGHTS, ShaderChunk.lights_physical_pars_fragment.replace(DOT_NL, BANDED));
  }
  const mixed = shader.fragmentShader.includes(PALETTE_LINE);
  if (palette && !mixed) shader.fragmentShader = shader.fragmentShader.replace(COLOR, `${COLOR}${PALETTE_LINE}`);
  if (!palette && mixed) shader.fragmentShader = shader.fragmentShader.replace(PALETTE_LINE, '');
}

/** Paleta sady pro shader: šest barev, chybějící `block` nahradí `track`. */
export function scenePaletteOf(look: Pick<Look, 'ground' | 'tint' | 'block' | 'track' | 'horizon'>): readonly string[] {
  return [look.ground, look.tint[0], look.tint[1], look.block?.[0] ?? look.track, look.track, look.horizon];
}

export type Rgb = readonly [number, number, number];

/** Lineární sRGB → Oklab (Ottosson), totéž co `toonLab` v shaderu. */
export function oklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(Math.max(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b, 0));
  const m = Math.cbrt(Math.max(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b, 0));
  const s = Math.cbrt(Math.max(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b, 0));
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** Oklab → lineární sRGB, záporné složky oříznuté – `toonRgb` v shaderu. */
function rgbOf([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [Math.max(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, 0), Math.max(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, 0), Math.max(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s, 0)];
}

/** Paleta (v Oklab) a přimíchání sady do sdílených uniform; `Color.set` převede hex z sRGB do lineární. */
export function setScenePalette(look: Pick<Look, 'ground' | 'tint' | 'block' | 'track' | 'horizon'>): void {
  const color = new Color();
  scenePaletteOf(look).forEach((hex, index) => {
    color.set(hex);
    toon.palette.value[index]!.fromArray(oklab([color.r, color.g, color.b]));
  });
  toon.mix.value = PALETTE_MIX;
}

/**
 * Referenční podoba `toonPaletteMix` (lineární RGB): nejbližší barva palety v Oklab, k jejímu odstínu
 * (a, b) se barva posune o `amount`, světlost L zůstane. Postava (`character`) paletu nedostane.
 */
export function paletteMix(color: Rgb, palette: readonly Rgb[], amount: number, role: 'scenery' | 'character'): Rgb {
  if (role === 'character') return color;
  const lab = oklab(color);
  let best = oklab(palette[0]!);
  let bestGap = Infinity;
  for (const entry of palette) {
    const other = oklab(entry);
    const gap = (other[0] - lab[0]) ** 2 + (other[1] - lab[1]) ** 2 + (other[2] - lab[2]) ** 2;
    if (gap < bestGap) {
      bestGap = gap;
      best = other;
    }
  }
  return rgbOf([lab[0], lab[1] + (best[1] - lab[1]) * amount, lab[2] + (best[2] - lab[2]) * amount]);
}
