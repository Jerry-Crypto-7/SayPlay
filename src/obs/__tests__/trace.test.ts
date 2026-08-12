import { describe, expect, it } from 'vitest';

import { currentRequestId, withRequest } from '../trace';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Vnořená funkce, která korelační ID nedostane parametrem — o to tu celé jde. */
async function deepRead(): Promise<string | undefined> {
  await delay(1);
  return currentRequestId();
}

describe('kontext korelačního ID', () => {
  it('je mimo požadavek prázdný', () => {
    expect(currentRequestId()).toBeUndefined();
  });

  it('projde přes async hranici bez explicitního parametru', async () => {
    const seen = await withRequest('alpha', async () => {
      await delay(3);
      return deepRead();
    });

    expect(seen).toBe('alpha');
    expect(currentRequestId()).toBeUndefined();
  });

  it('přežije vyhozenou výjimku', async () => {
    const observed: (string | undefined)[] = [];

    await expect(
      withRequest('boom', async () => {
        try {
          await delay(2);
          throw new Error('upstream failed');
        } catch (error) {
          // Bez tohohle by se chyba nedala zalogovat pod ID požadavku, který ji
          // způsobil — a právě u chyb je korelace nejcennější.
          observed.push(currentRequestId());
          throw error;
        }
      }),
    ).rejects.toThrow('upstream failed');

    expect(observed).toEqual(['boom']);
    expect(currentRequestId()).toBeUndefined();
  });

  it('vnořený kontext se po návratu obnoví', async () => {
    const seen = await withRequest('outer', async () => {
      const inner = await withRequest('inner', async () => {
        await delay(1);
        return currentRequestId();
      });
      await delay(1);
      return { inner, afterInner: currentRequestId() };
    });

    expect(seen).toEqual({ inner: 'inner', afterInner: 'outer' });
  });

  it('dvě prokládané operace si kontext navzájem nepřepíšou', async () => {
    // Modulová proměnná s aktuálním ID by prošla všemi testy výš. Teprve dvě
    // operace, které se skutečně střídají na jednom vlákně, ji odhalí.
    const timeline: string[] = [];

    async function traced(id: string, steps: readonly number[]): Promise<(string | undefined)[]> {
      return withRequest(id, async () => {
        const seen: (string | undefined)[] = [currentRequestId()];
        for (const ms of steps) {
          await delay(ms);
          timeline.push(id);
          seen.push(currentRequestId());
          seen.push(await deepRead());
        }
        return seen;
      });
    }

    const [alpha, beta] = await Promise.all([
      traced('alpha', [8, 2, 12, 2]),
      traced('beta', [2, 12, 2, 8]),
    ]);

    expect(new Set(alpha)).toEqual(new Set(['alpha']));
    expect(new Set(beta)).toEqual(new Set(['beta']));

    // Kdyby operace doběhly za sebou místo prokládaně, test by nic nedokazoval:
    // sekvenční běh zvládne i globální proměnná. Jeden přechod má i pouhé
    // zřetězení, takže se vyžadují aspoň dva.
    const switches = timeline.filter((id, i) => i > 0 && id !== timeline[i - 1]).length;
    expect(switches, `operace se neprokládaly: ${timeline.join(',')}`).toBeGreaterThanOrEqual(2);
  });
});
