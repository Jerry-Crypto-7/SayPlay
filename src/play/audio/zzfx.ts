/**
 * ZzFX – Zuper Zmall Zound Zynth, generátor vzorků (P28C T2).
 * Vendorováno a přepsáno do TypeScriptu z https://github.com/KilledByAPixel/ZzFX
 * (ZzFX 1.x, `zzfxG`); přehrání (`zzfxP`) dělá `./index.ts` přes vlastní
 * `AudioContext`. Zvuk je ozdoba mimo stav hry: náhoda tu nesahá do hashe.
 *
 * MIT License
 *
 * Copyright (c) 2019 Frank Force
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export const ZZFX_RATE = 44_100;
const ZZFX_VOLUME = 0.3;

/**
 * Parametry ve stejném pořadí jako `zzfx(...)`: hlasitost, náhoda, frekvence,
 * náběh, držení, doznění, tvar (0 sinus, 1 trojúhelník, 2 pila, 3 tan, 4 šum),
 * křivka tvaru, sklouznutí, zrychlení sklouznutí, skok výšky, čas skoku,
 * opakování, šum, modulace, bitcrush, zpoždění, hlasitost držení, pokles, tremolo.
 */
export type ZzfxParams = readonly number[];

export function zzfxSamples(params: ZzfxParams): number[] {
  let [
    volume = 1,
    randomness = 0.05,
    frequency = 220,
    attack = 0,
    sustain = 0,
    release = 0.1,
    shape = 0,
    shapeCurve = 1,
    slide = 0,
    deltaSlide = 0,
    pitchJump = 0,
    pitchJumpTime = 0,
    repeatTime = 0,
    noise = 0,
    modulation = 0,
    bitCrush = 0,
    delay = 0,
    sustainVolume = 1,
    decay = 0,
    tremolo = 0,
  ] = params;
  const PI2 = Math.PI * 2;
  const sign = (v: number): number => (v > 0 ? 1 : -1);
  const startSlide = (slide *= (500 * PI2) / ZZFX_RATE / ZZFX_RATE);
  let startFrequency = (frequency *= ((1 + randomness * 2 * Math.random() - randomness) * PI2) / ZZFX_RATE);
  const b: number[] = [];
  let t = 0;
  let tm = 0;
  let j = 1;
  let r = 0;
  let c = 0;
  let s = 0;

  attack = attack * ZZFX_RATE + 9;
  decay *= ZZFX_RATE;
  sustain *= ZZFX_RATE;
  release *= ZZFX_RATE;
  delay *= ZZFX_RATE;
  deltaSlide *= (500 * PI2) / ZZFX_RATE ** 3;
  modulation *= PI2 / ZZFX_RATE;
  pitchJump *= PI2 / ZZFX_RATE;
  pitchJumpTime *= ZZFX_RATE;
  repeatTime = (repeatTime * ZZFX_RATE) | 0;

  const length = (attack + decay + sustain + release + delay) | 0;
  for (let i = 0; i < length; b[i++] = s) {
    if (!(++c % ((bitCrush * 100) | 0))) {
      s = shape
        ? shape > 1
          ? shape > 2
            ? shape > 3
              ? Math.sin((t % PI2) ** 3)
              : Math.max(Math.min(Math.tan(t), 1), -1)
            : 1 - (((((2 * t) / PI2) % 2) + 2) % 2)
          : 1 - 4 * Math.abs(Math.round(t / PI2) - t / PI2)
        : Math.sin(t);
      s =
        (repeatTime ? 1 - tremolo + tremolo * Math.sin((PI2 * i) / repeatTime) : 1) *
        sign(s) *
        Math.abs(s) ** shapeCurve *
        volume *
        ZZFX_VOLUME *
        (i < attack
          ? i / attack
          : i < attack + decay
            ? 1 - ((i - attack) / decay) * (1 - sustainVolume)
            : i < attack + decay + sustain
              ? sustainVolume
              : i < length - delay
                ? ((length - i - delay) / release) * sustainVolume
                : 0);
      s = delay ? s / 2 + (delay > i ? 0 : ((i < length - delay ? 1 : (length - i) / delay) * (b[(i - delay) | 0] as number)) / 2) : s;
    }
    const f = (frequency += slide += deltaSlide) * Math.cos(modulation * tm++);
    t += f - f * noise * (1 - (((Math.sin(i) + 1) * 1e9) % 2));
    if (j && ++j > pitchJumpTime) {
      frequency += pitchJump;
      startFrequency += pitchJump;
      j = 0;
    }
    if (repeatTime && !(++r % repeatTime)) {
      frequency = startFrequency;
      slide = startSlide;
      j = j || 1;
    }
  }
  return b;
}
