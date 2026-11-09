/**
 * Barevné ladění podle rodiny prostředí (P37B T3): poslední krok skládače za
 * ACES. Snímky „před“ (T1) ukázaly dvě vady, které paleta sady sama nespraví:
 * sníh v mlze arény vybledne do bílé a noční sady (hřbitov, jeskyně, vesmír)
 * zapadnou do černé, takže hrdina v nich není vidět. Ladění proto zvedá stíny
 * nočním sadám, sníh dostane hloubku ve středních tónech a každá rodina jemný
 * odstín (teplá světla na poušti, tyrkysové stíny pod vodou) a vinětu.
 *
 * Operace běží ve vnímaném prostoru (gama 2,2), jako tónová křivka LUT:
 * zisk·(c + zdvih·(1 − c)), pak gama, sytost a kontrast kolem středu.
 * Efekt se slije do průchodu ACES, takže na telefonu nestojí průchod navíc;
 * úroveň `low` má kontrast navíc (`gradeFor`, P54B T14).
 *
 * Nic fialového: zdvih i zisk jsou jen modré, tyrkysové nebo teplé a tmavé
 * fialové směsi, které by zdvih vytáhl nad černou, shader stáhne k modré.
 * Mimo hash: jádro obraz nečte.
 */

import { Effect } from 'postprocessing';
import { Uniform, Vector3 } from 'three';

import type { LookId } from '@/play/arcade/look';
import { type Grade, type GradeFamily, LOOK_FAMILY, LOOK_STYLE } from '@/play/arcade/look/style';

import type { QualityTier } from './quality';

export { GRADE_FAMILIES, type Grade, type GradeFamily, LOOK_FAMILY } from '@/play/arcade/look/style';

/** Ladění rodin z profilu vzhledu (P81, `LOOK_STYLE.grade`). */
export const GRADES: Readonly<Record<GradeFamily, Grade>> = LOOK_STYLE.grade.families;

export const gradeOf = (lookId: LookId): Grade => GRADES[LOOK_FAMILY[lookId]];

/**
 * Kontrast navíc na telefonní úrovni (P54B T14): `low` nemá AO ani bloom, kontaktní stíny
 * a záře chybí a obraz na malém displeji splývá – postava se slévá se zemí.
 */
export const LOW_CONTRAST = LOOK_STYLE.grade.lowContrast;

/** Ladění rodiny na úrovni kvality; jen uniformy, změna úrovně nic nepřekládá. */
export const gradeFor = (family: GradeFamily, tier: QualityTier): Grade =>
  tier === 'low' ? { ...GRADES[family], contrast: GRADES[family].contrast + LOW_CONTRAST } : GRADES[family];

const FRAGMENT = /* glsl */ `
uniform vec3 lift;
uniform vec3 gain;
uniform float split;
uniform float gamma;
uniform float saturation;
uniform float contrast;
uniform float vignette;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = pow(clamp(inputColor.rgb, 0.0, 1.0), vec3(1.0 / 2.2));
  float shade = 1.0 - smoothstep(0.3, 0.5, max(c.r, max(c.g, c.b)));
  // Split-tone (P81): zisk jen ve světlech – tmavé a střední tóny (tučňák, podlaha ve stínu) bez teplého nádechu.
  vec3 toned = mix(vec3(1.0), gain, smoothstep(0.45, 0.85, dot(c, vec3(0.2126, 0.7152, 0.0722))));
  c = mix(gain, toned, split) * (c + lift * (1.0 - c));
  c = pow(max(c, 0.0), vec3(gamma));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, saturation);
  c = (c - 0.5) * contrast + 0.5;
  // Nic fialového (P37B T9): tmavá směs červené půdy a modré mlhy na obzoru vesmíru je fialová,
  // jen dřív zapadla do černé – zvednutá nocí byla 4,5 % snímku. Odstín 250–320° se v tmavých
  // tónech stáhne pod okraj pásma (fialová strana k modré ~245°, purpurová k červené ~330°,
  // s rezervou na zaokrouhlení do 8 bitů); světlou fialovou, kterou si hráč řekl větou,
  // ladění nepřebarví.
  if (shade > 0.0 && min(c.r, c.b) > c.g) {
    vec3 safe = c;
    if (c.b >= c.r) safe.r = min(c.r, c.g + (c.b - c.g) * 0.08);
    else safe.b = min(c.b, c.g + (c.r - c.g) * 0.5);
    c = mix(c, safe, shade);
  }
  c *= 1.0 - vignette * smoothstep(0.45, 1.0, length(uv - 0.5) * 1.414);
  outputColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(2.2)), inputColor.a);
}`;

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', FRAGMENT, {
      uniforms: new Map<string, Uniform>([
        ['lift', new Uniform(new Vector3())],
        ['gain', new Uniform(new Vector3(1, 1, 1))],
        ['split', new Uniform(0)],
        ['gamma', new Uniform(1)],
        ['saturation', new Uniform(1)],
        ['contrast', new Uniform(1)],
        ['vignette', new Uniform(0)],
      ]),
    });
  }

  set grade(grade: Grade) {
    const uniforms = this.uniforms;
    (uniforms.get('lift')!.value as Vector3).set(...grade.lift);
    (uniforms.get('gain')!.value as Vector3).set(...grade.gain);
    uniforms.get('split')!.value = grade.split;
    uniforms.get('gamma')!.value = grade.gamma;
    uniforms.get('saturation')!.value = grade.saturation;
    uniforms.get('contrast')!.value = grade.contrast;
    uniforms.get('vignette')!.value = grade.vignette;
  }
}
