/**
 * Všechny čtyři větve `detectRuntime()` plus hrany, na kterých se rozhoduje.
 *
 * Hrany jsou tu schválně po dvojicích (`práh` a `práh - epsilon`), protože
 * jediná mutace, kterou by testy jen na „typických" hodnotách nechytily, je
 * záměna `>=` za `>` — a ta posílá stroj přesně na prahu do menší větve, což si
 * nikdo nevšimne, dokud to nezačne měřit.
 */

import { describe, expect, it } from 'vitest';

import {
  LARGE_MIN_MEMORY_GB,
  SMALL_MIN_MEMORY_GB,
  WEIGHT_HOSTS,
  detectRuntime,
  isWeightRequest,
  probeEnvironment,
  readEnvironment,
  type NavigatorLike,
  type RuntimeEnvironment,
} from '../capability';

function env(overrides: Partial<RuntimeEnvironment> = {}): RuntimeEnvironment {
  return { hasWebGpu: false, deviceMemoryGb: undefined, cloudConfigured: false, ...overrides };
}

describe('detectRuntime — čtyři větve', () => {
  it('large: WebGPU je a paměti je dost', () => {
    expect(detectRuntime(env({ hasWebGpu: true, deviceMemoryGb: LARGE_MIN_MEMORY_GB }))).toBe('large');
    expect(detectRuntime(env({ hasWebGpu: true, deviceMemoryGb: 64 }))).toBe('large');
  });

  it('small: WebGPU je, ale paměti je málo na velký model', () => {
    expect(detectRuntime(env({ hasWebGpu: true, deviceMemoryGb: SMALL_MIN_MEMORY_GB }))).toBe('small');
    expect(detectRuntime(env({ hasWebGpu: true, deviceMemoryGb: LARGE_MIN_MEMORY_GB - 0.5 }))).toBe('small');
  });

  it('cloud: WebGPU není, ale serverová cesta je nakonfigurovaná', () => {
    expect(detectRuntime(env({ hasWebGpu: false, deviceMemoryGb: 32, cloudConfigured: true }))).toBe('cloud');
  });

  it('none: ani WebGPU, ani server', () => {
    expect(detectRuntime(env())).toBe('none');
    expect(detectRuntime(env({ deviceMemoryGb: 32 }))).toBe('none');
  });
});

describe('detectRuntime — hrany, na kterých se to rozhoduje', () => {
  it('práh pro large platí včetně, o půl giga níž už je small', () => {
    expect(detectRuntime(env({ hasWebGpu: true, deviceMemoryGb: LARGE_MIN_MEMORY_GB }))).toBe('large');
    expect(detectRuntime(env({ hasWebGpu: true, deviceMemoryGb: LARGE_MIN_MEMORY_GB - 0.5 }))).not.toBe('large');
  });

  it('práh pro small platí včetně, o půl giga níž už WebGPU nestačí', () => {
    expect(detectRuntime(env({ hasWebGpu: true, deviceMemoryGb: SMALL_MIN_MEMORY_GB }))).toBe('small');
    expect(detectRuntime(env({ hasWebGpu: true, deviceMemoryGb: SMALL_MIN_MEMORY_GB - 0.5 }))).toBe('none');
  });

  it('neohlášená paměť se počítá jako málo, ne jako dost', () => {
    expect(detectRuntime(env({ hasWebGpu: true, deviceMemoryGb: undefined }))).toBe('none');
  });

  it('slabý stroj s WebGPU spadne na cloud, když je nakonfigurovaný', () => {
    expect(detectRuntime(env({ hasWebGpu: true, deviceMemoryGb: 1, cloudConfigured: true }))).toBe('cloud');
  });

  it('cloud nikdy nepřebije stroj, který na velký model má', () => {
    expect(detectRuntime(env({ hasWebGpu: true, deviceMemoryGb: 8, cloudConfigured: true }))).toBe('large');
  });
});

describe('readEnvironment', () => {
  it('mimo prohlížeč nehádá — vrátí tvar, ze kterého vyjde none', () => {
    // Vitest běží v Node, takže `navigator` tu buď není, nebo je to Node
    // navigator bez `gpu`. Obojí musí skončit stejně: build nesmí rozhodovat
    // za stroj návštěvníka.
    expect(detectRuntime(readEnvironment())).toBe('none');
  });

  it('cloudConfigured je bez zapojení serveru false', () => {
    expect(readEnvironment().cloudConfigured).toBe(false);
  });
});

describe('probeEnvironment — přítomnost objektu není totéž co použitelné WebGPU', () => {
  const withGpu = (adapter: unknown | null, deviceMemory = 32): NavigatorLike => ({
    gpu: { requestAdapter: async () => adapter },
    deviceMemory,
  });

  it('adaptér se vrátí -> WebGPU jede', async () => {
    expect(await probeEnvironment(withGpu({ name: 'fake' }))).toMatchObject({ hasWebGpu: true, deviceMemoryGb: 32 });
    expect(detectRuntime(await probeEnvironment(withGpu({ name: 'fake' })))).toBe('large');
  });

  /**
   * Tohle je přesně to, co Chromium dělá s `--disable-gpu`: objekt vystaví,
   * adaptér nevrátí. Levná synchronní cesta by tady řekla `large` a stroj by
   * čekal minutu na 979 MB vah, které nemá čím spustit.
   */
  it('objekt je, adaptér není -> WebGPU nejede, a levná cesta se v tomhle mýlí', async () => {
    const nav = withGpu(null);
    expect(await probeEnvironment(nav)).toMatchObject({ hasWebGpu: false });
    expect(detectRuntime(await probeEnvironment(nav))).toBe('none');
    // A tady je ta chyba, kvůli které probe existuje:
    expect(detectRuntime(readEnvironment(nav))).toBe('large');
  });

  it('requestAdapter, který spadne, se počítá jako nejede', async () => {
    const nav: NavigatorLike = {
      gpu: {
        requestAdapter: async () => {
          throw new Error('ovladač neodpověděl');
        },
      },
      deviceMemory: 32,
    };
    expect(await probeEnvironment(nav)).toMatchObject({ hasWebGpu: false });
  });

  it('bez navigator.gpu se na nic neptá', async () => {
    expect(await probeEnvironment({ deviceMemory: 32 })).toMatchObject({ hasWebGpu: false, deviceMemoryGb: 32 });
    expect(await probeEnvironment(undefined)).toMatchObject({ hasWebGpu: false, deviceMemoryGb: undefined });
  });

  it('adaptér je, ale paměti je málo -> small, ne large', async () => {
    expect(detectRuntime(await probeEnvironment(withGpu({}, SMALL_MIN_MEMORY_GB)))).toBe('small');
  });
});

describe('isWeightRequest', () => {
  it('pozná každou doménu vah ze seznamu', () => {
    for (const host of WEIGHT_HOSTS) {
      expect(isWeightRequest(`https://${host}/mlc-ai/Qwen3-1.7B-q4f16_1-MLC/resolve/main/params_shard_0.bin`)).toBe(true);
    }
  });

  it('vlastní původ ani datové URL za váhy nepovažuje', () => {
    expect(isWeightRequest('http://127.0.0.1:3100/api/emit')).toBe(false);
    expect(isWeightRequest('/api/emit')).toBe(false);
    expect(isWeightRequest('data:text/plain,ahoj')).toBe(false);
  });

  it('podvržená doména, která jen obsahuje jméno, neprojde', () => {
    expect(isWeightRequest('https://huggingface.co.zloduch.example/vahy.bin')).toBe(false);
  });
});
