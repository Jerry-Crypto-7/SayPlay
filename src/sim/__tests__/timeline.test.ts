import { describe, expect, it } from 'vitest';

import { hashHex } from '../hash';
import { createRuntime, run, step, type WorldDocRuntime } from '../interpreter';
import { createStreams, nextInt } from '../rng';
import { advance, createTimeline, seekTo } from '../timeline';

import { INPUT_TICK, oscillator } from '../__fixtures__/oscillator';
import vaultWorld from '../__fixtures__/vault.world.json';

const vault = vaultWorld as unknown as WorldDocRuntime;

const HORIZON = 200;
const JUMPS = 20;
const SEED = 0x51ce11a1;

function inputsAt(doc: WorldDocRuntime, tick: number) {
  return doc.trace.filter((entry) => entry.tick === tick);
}

/** Hash zabaleného stavu na hranici každého tiku běhu bez jediného skoku. */
function straightRun(doc: WorldDocRuntime, ticks: number): string[] {
  const runtime = createRuntime(doc);
  const hashes = [hashHex(runtime.state)];
  for (let i = 0; i < ticks; i += 1) {
    step(runtime, inputsAt(doc, runtime.tick));
    hashes.push(hashHex(runtime.state));
  }
  return hashes;
}

describe('fixture, na které se osa měří', () => {
  it('běží celý horizont a nikdy nezopakuje stav', () => {
    const runtime = createRuntime(oscillator());
    expect(run(runtime, HORIZON)).toBe('running');
    expect(runtime.tick).toBe(HORIZON);

    const hashes = straightRun(oscillator(), HORIZON);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  /**
   * Bez tohohle měření je pokrytí fronty jen záměr. Snímek, který frontu
   * zapomene, projde každým světem, kde je na hranici tiku prázdná — a to je
   * většina z nich.
   */
  it('má na hranici tiku střídavě neprázdnou frontu', () => {
    const runtime = createRuntime(oscillator());
    const depths: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      step(runtime, []);
      depths.push(runtime.drainQueue.length);
    }
    expect(depths.filter((depth) => depth > 0).length).toBeGreaterThan(0);
    expect(depths.filter((depth) => depth === 0).length).toBeGreaterThan(0);
  });

  /**
   * Předpoklad, na kterém stojí vynechání `writeQueue` ze snímku. Není v
   * `timeline.ts` napsaný jako komentář a doufáno v něj — měří se, takže den, kdy
   * `step` přestane zapisovanou frontu na konci tiku vyprazdňovat, shodí test
   * osy, ne až demo.
   */
  it('má na hranici tiku vždy prázdnou zapisovanou frontu', () => {
    const doc = oscillator();
    const runtime = createRuntime(doc);
    expect(runtime.writeQueue).toHaveLength(0);
    for (let i = 0; i < HORIZON; i += 1) {
      step(runtime, inputsAt(doc, runtime.tick));
      expect(runtime.writeQueue).toHaveLength(0);
    }
  });
});

describe('přetáčení času', () => {
  it('skok na libovolný tik a doběh na konec dá bitově shodný hash', () => {
    const reference = straightRun(oscillator(), HORIZON);
    const doc = oscillator();
    const runtime = createRuntime(doc);
    const timeline = createTimeline(runtime, 64);

    for (let i = 0; i < HORIZON; i += 1) {
      advance(timeline, runtime, inputsAt(doc, runtime.tick));
    }
    expect(hashHex(runtime.state)).toBe(reference[HORIZON]);

    // Skoky jsou náhodné, ale seed je v testu — dvě spuštění projdou týmiž tiky.
    const stream = createStreams(SEED).spawn;
    for (let i = 0; i < JUMPS; i += 1) {
      const target = nextInt(stream, 0, HORIZON);

      // Aserce nad CÍLEM je ta podstatná: osa, která by místo skoku vždycky
      // obnovila kotvu, by na konec taky dokonvergovala a konečný hash by nic
      // neprokázal.
      expect(seekTo(timeline, runtime, target)).toBe(target);
      expect(hashHex(runtime.state)).toBe(reference[target]);

      expect(seekTo(timeline, runtime, HORIZON)).toBe(HORIZON);
      expect(hashHex(runtime.state)).toBe(reference[HORIZON]);
    }
  });

  /**
   * Skok přesně na tik, který nese vstup.
   *
   * Náhodné skoky tuhle vadu netrefí: kruh o kapacitě 64 drží u dvousetkového
   * běhu jen posledních 64 tiků, takže starší cíl stejně odpadne na kotvu a
   * poškozený snímek se nepoužije. Vlastnost potřebuje jmenovaný test, ne
   * naději na dvacet losů.
   */
  it('skok na tik se vstupem ten vstup nezdvojí', () => {
    const reference = straightRun(oscillator(), HORIZON);
    const doc = oscillator();
    const runtime = createRuntime(doc);
    const timeline = createTimeline(runtime, 64);
    for (let i = 0; i < HORIZON; i += 1) advance(timeline, runtime, inputsAt(doc, runtime.tick));

    expect(seekTo(timeline, runtime, INPUT_TICK)).toBe(INPUT_TICK);
    expect(hashHex(runtime.state)).toBe(reference[INPUT_TICK]);

    expect(seekTo(timeline, runtime, HORIZON)).toBe(HORIZON);
    expect(runtime.runState).toBe('running');
    expect(runtime.fault).toBeNull();
    expect(hashHex(runtime.state)).toBe(reference[HORIZON]);
  });

  it('dojde i na tik, který kruh dávno přepsal', () => {
    const reference = straightRun(oscillator(), HORIZON);
    const doc = oscillator();
    const runtime = createRuntime(doc);
    const timeline = createTimeline(runtime, 8);

    for (let i = 0; i < HORIZON; i += 1) {
      advance(timeline, runtime, inputsAt(doc, runtime.tick));
    }
    expect(timeline.ring.length).toBe(8);

    expect(seekTo(timeline, runtime, 3)).toBe(3);
    expect(hashHex(runtime.state)).toBe(reference[3]);
  });

  it('druhý skok na týž tik skončí tam, kde první', () => {
    const doc = oscillator();
    const runtime = createRuntime(doc);
    const timeline = createTimeline(runtime, 64);
    for (let i = 0; i < HORIZON; i += 1) advance(timeline, runtime, inputsAt(doc, runtime.tick));

    seekTo(timeline, runtime, 90);
    const first = hashHex(runtime.state);
    seekTo(timeline, runtime, HORIZON);
    seekTo(timeline, runtime, 90);

    expect(hashHex(runtime.state)).toBe(first);
  });

  it('řekne, kam doopravdy dosáhla, když se cíl dosáhnout nedá', () => {
    const doc = oscillator();
    const runtime = createRuntime(doc);
    for (let i = 0; i < 10; i += 1) step(runtime, []);
    const timeline = createTimeline(runtime, 8);

    // Před kotvou žádný snímek není a osa to nezastírá přistáním jinde potichu.
    expect(seekTo(timeline, runtime, 3)).toBe(10);
  });

  it('u dohraného světa se zastaví na tiku výhry, nedopočítává dál', () => {
    const runtime = createRuntime(vault);
    const timeline = createTimeline(runtime, 32);
    for (let i = 0; i < 40; i += 1) {
      advance(timeline, runtime, inputsAt(vault, runtime.tick));
    }

    expect(runtime.runState).toBe('won');
    expect(runtime.tick).toBe(vault.winsAtTick);
    // Tiky po výhře runtimem nepohnou, takže do kruhu nesmí vstoupit — jinak by
    // z něj vytlačily celou minulost, kterou má osa nabízet.
    expect(timeline.written).toBe(vault.winsAtTick);
    expect(seekTo(timeline, runtime, 40)).toBe(vault.winsAtTick);
  });

  /**
   * Přetočení dohraného světa zpět před výhru. Konec běhu je stav runtimu, ne
   * jen jeho pole — osa, která obnoví sloty a `runState` nechá na `won`, by
   * scrub zpátky zamkla: svět by stál na tiku 2 a odmítal se hnout.
   */
  it('vrátí dohraný svět zpět do běhu a nechá ho vyhrát znovu', () => {
    const runtime = createRuntime(vault);
    const timeline = createTimeline(runtime, 32);
    for (let i = 0; i < 40; i += 1) {
      advance(timeline, runtime, inputsAt(vault, runtime.tick));
    }
    const won = hashHex(runtime.state);

    expect(seekTo(timeline, runtime, 2)).toBe(2);
    expect(runtime.runState).toBe('running');
    expect(runtime.fault).toBeNull();

    expect(seekTo(timeline, runtime, 40)).toBe(vault.winsAtTick);
    expect(runtime.runState).toBe('won');
    expect(hashHex(runtime.state)).toBe(won);
  });

  it('odmítne kapacitu, se kterou by kruh nebyl kruh', () => {
    const runtime = createRuntime(oscillator());
    expect(() => createTimeline(runtime, 0)).toThrow(/positive integer/);
    expect(() => createTimeline(runtime, 2.5)).toThrow(/positive integer/);
  });
});
