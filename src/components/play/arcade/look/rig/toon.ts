/**
 * Vzhled modelíny (P75 T2, dřív toon P56B T6): jeden shaderový patch nad `MeshStandardMaterial`, nasazený tam,
 * kde materiály už vznikají (`load.ts`). Žádná nová textura ani světlo:
 * - přímé rozptýlené světlo zabalené (half-Lambert, `clayWrap`): měkký přechod do stínu místo tří stupňů; odlesk
 *   dál počítá ze skutečného úhlu, aby se odvrácená strana neleskla;
 * - měkký odlesk: drsnost sevřená do pásma plastu (`CLAY_ROUGHNESS`), matný model dostane široký lesk, lesklý se
 *   nezrcadlí;
 * - kulisy posunuté k odstínu nejbližší barvy palety sady (Oklab, světlost zůstane); hrdina, nepřátelé a záře věcí ne;
 * - kulisy mají teplý okraj VLASTNÍ barvy (`toonRim`): Fresnel × barva povrchu × teplý tón, v noci nic.
 * Paletu a okraj nesou sdílené uniformy (`setScenePalette` v rigu, vzor `setCharacterRim`): sada, nálada ani úroveň
 * kvality program nepřekládají.
 *
 * Proč okraj jen barvou povrchu: okraj barvou oblohy nebo bílé modely s mnoha ploškami bokem k pohledu (koruny,
 * kmeny, výplň hřbitova) zešedil – slepý soud T13 to dvakrát jmenoval („broken white materials“ v noci, T13-R1;
 * „grey, broken-looking tree textures“ ve dne, T13-R2). Násobek barvy povrchu ji jen zjasní, šedou nepřimíchá.
 * Postavy nesou svůj svit (`setCharacterRim`), okraj kulis nedostanou.
 */
import { Color, ShaderChunk, Vector3, type WebGLProgramParametersWithUniforms } from 'three';

import { colorHex } from '@/brand/tokens';
import type { Look } from '@/play/arcade/look';

/** Kotvy v `ShaderChunk` three 0.185.1; `toon.test.ts` hlídá, že každá existuje právě jednou. */
export const DIFFUSE = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );';
export const LIGHTS = '#include <lights_physical_pars_fragment>';
export const COLOR = '#include <color_fragment>';
export const COMMON = '#include <common>';
export const EMISSIVE = '#include <emissivemap_fragment>';
export const PHYSICAL = '#include <lights_physical_fragment>';

/** Pásmo drsnosti plastové hračky: pod ním by se model zrcadlil, nad ním by lesk zmizel. */
export const CLAY_ROUGHNESS = [0.45, 0.75] as const;
/** Síla teplého okraje kulis ve dne (násobek barvy povrchu na samé hraně siluety; P77 0,3, P81 silnější lesk modelíny). */
export const CLAY_RIM = 0.45;
/** Tón okraje: světlo zlaté hodiny (kit `sun-soft`). */
const CLAY_RIM_TINT = new Color(colorHex['sun-soft']);

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
  rim: { value: new Color(0, 0, 0) },
};

const HEAD = `
uniform vec3 toonPalette[${PALETTE_SIZE}];
uniform float toonMix;
uniform vec3 toonRim;
float clayWrap( float x ) { return saturate( ( x + 0.5 ) / 1.5 ); }
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
const WRAPPED = 'reflectedLight.directDiffuse += clayWrap( dot( geometryNormal, directLight.direction ) ) * directLight.color * BRDF_Lambert( material.diffuseContribution );';
const SOFT_GLOSS = `\n\troughnessFactor = clamp( roughnessFactor, ${CLAY_ROUGHNESS[0]}, ${CLAY_ROUGHNESS[1]} );\n\t${PHYSICAL}`;
const PALETTE_LINE = '\n\tdiffuseColor.rgb = toonPaletteMix( diffuseColor.rgb );';
const RIM_LINE = '\n\ttotalEmissiveRadiance += diffuseColor.rgb * toonRim * pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 3.0 );';

/**
 * Vloží modelínu do programu, jednou; `palette` přimíchání palety a teplý okraj kulis zapne nebo (v kopii
 * postavy či záře) vypne. Kopie volají úpravu zdroje a pak tuto, proto opakované volání jen přepne paletu.
 */
export function toonPatch(shader: WebGLProgramParametersWithUniforms, palette: boolean, rim = palette): void {
  if (!shader.fragmentShader.includes('uniform float toonMix;')) {
    shader.uniforms.toonPalette = toon.palette;
    shader.uniforms.toonMix = toon.mix;
    shader.uniforms.toonRim = toon.rim;
    shader.fragmentShader = shader.fragmentShader
      .replace(COMMON, `${COMMON}${HEAD}`)
      .replace(LIGHTS, ShaderChunk.lights_physical_pars_fragment.replace(DIFFUSE, WRAPPED))
      .replace(PHYSICAL, SOFT_GLOSS.trimStart());
  }
  // Kulisa přebarvená do palety místa už při načtení (P77 T2) chce teplý okraj bez přimíchání palety ve shaderu.
  const mixed = shader.fragmentShader.includes(PALETTE_LINE);
  if (palette && !mixed) shader.fragmentShader = shader.fragmentShader.replace(COLOR, `${COLOR}${PALETTE_LINE}`);
  if (!palette && mixed) shader.fragmentShader = shader.fragmentShader.replace(PALETTE_LINE, '');
  const rimmed = shader.fragmentShader.includes(RIM_LINE);
  if (rim && !rimmed) shader.fragmentShader = shader.fragmentShader.replace(EMISSIVE, `${EMISSIVE}${RIM_LINE}`);
  if (!rim && rimmed) shader.fragmentShader = shader.fragmentShader.replace(RIM_LINE, '');
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
export function rgbOf([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [Math.max(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, 0), Math.max(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, 0), Math.max(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s, 0)];
}

/**
 * Paleta (v Oklab), přimíchání a teplý okraj sady do sdílených uniform; `Color.set` převede hex z sRGB do
 * lineární. Okraj slábne s nocí: v noci by kulisy na hranách svítily (T13-R1). Bouřka (P81 T5) okraj nemá: slunce
 * nesvítí, okraj je emisivní a v tmavém dešti přebil osvětlení – kulisy s9 vypadaly jako vybledlé žluté sklo.
 */
export function setScenePalette(look: Pick<Look, 'ground' | 'tint' | 'block' | 'track' | 'horizon' | 'storm'>): void {
  const color = new Color();
  scenePaletteOf(look).forEach((hex, index) => {
    color.set(hex);
    toon.palette.value[index]!.fromArray(oklab([color.r, color.g, color.b]));
  });
  toon.mix.value = PALETTE_MIX;
  toon.rim.value.copy(CLAY_RIM_TINT).multiplyScalar(CLAY_RIM * (look.storm === true ? STORM_RIM : 1 - darkness(look)));
}

/** Okraj v bouřce (P81 R3): třetina – teplé hrany domů předlohy s9; celý okraj z kulis dělal vybledlé sklo (T5). */
export const STORM_RIM = 0.35;

/** Paleta místa (`Look.palette`, `#rrggbb`) v Oklab pro `snapToPalette`. */
export function paletteLab(hexes: readonly string[]): Rgb[] {
  const color = new Color();
  return hexes.map((hex) => oklab(color.set(hex).toArray() as unknown as Rgb));
}

/** Váha rozdílu světlosti při hledání tónu: o tónu rozhoduje odstín, světlost barva stejně nechá svou. */
const SNAP_LIGHTNESS = 0.25;
/**
 * Kolik vlastní barvy (Oklab a, b) kulisa podrží (P77 T6). Čistý tón palety (0) soudce proti produkci
 * dvakrát odmítl: „production has stronger contrast, dark stone and turquoise accents“ – akcenty zmizely.
 */
export const SNAP_KEEP = 0.35;

/**
 * Barva kulisy v paletě místa (P77 T2, lineární RGB): nejbližší tón palety (`paletteLab`) dá většinu odstínu
 * a sytosti, `SNAP_KEEP` zůstane z vlastní barvy, světlost celá – stín a světlo modelu drží. Barva tmavší než
 * tón dostane jeho sytost úměrně menší, jinak by tmavé plochy zářily (a mimo rozsah sRGB se odstín láme).
 */
export function snapToPalette(color: Rgb, palette: readonly Rgb[]): Rgb {
  const lab = oklab(color);
  let best = palette[0]!;
  let bestGap = Infinity;
  for (const tone of palette) {
    const gap = SNAP_LIGHTNESS * (tone[0] - lab[0]) ** 2 + (tone[1] - lab[1]) ** 2 + (tone[2] - lab[2]) ** 2;
    if (gap < bestGap) {
      bestGap = gap;
      best = tone;
    }
  }
  const keep = Math.min(1, lab[0] / Math.max(best[0], 1e-3));
  const mix = (tone: number, own: number) => (1 - SNAP_KEEP) * tone * keep + SNAP_KEEP * own;
  return rgbOf([lab[0], mix(best[1], lab[1]), mix(best[2], lab[2])]);
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
