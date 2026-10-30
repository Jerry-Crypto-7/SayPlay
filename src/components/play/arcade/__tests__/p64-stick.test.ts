/**
 * Joystick palce na výšku (P64 T7): kroužek `TouchStick` stojí v klidu na domovské pozici vlevo dole a prst ho
 * přenese pod sebe, ale osu dál počítá jen `useArenaInput` z místa dotyku. Týž tah tedy musí dát táž volání
 * `session.hold` (a `press`) jako na `main` `e661855c` – kroužek, který vypadá dobře a posílá jinou osu, by změnil
 * hru i replay potichu. Hodnoty níž jsou zapsané z `main` (useArenaInput ani `arenaAxis` se od něj nezměnily).
 *
 * Repo nemá vykreslovač DOM: `useEffect` běží hned, `useRef` vrátí náhradní uzel, plocha je `EventTarget`
 * a ukazatel `Event` se souřadnicemi – posluchači čtou jen `clientX`, `clientY` a `pointerId`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUTTON } from '@/play/arcade/contract';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const node = () => ({ style: { left: '', top: '', transform: '' }, dataset: {} as Record<string, string> });
  return {
    ...actual,
    useEffect: (effect: () => void) => {
      effect();
    },
    useRef: (initial: unknown) => ({ current: initial ?? node() }),
  };
});

const { useArenaInput } = await import('../arena/ArenaScene');
const { TouchStick } = await import('../TouchControls');
type Session = Parameters<typeof useArenaInput>[0];

class Surface extends EventTarget {
  setPointerCapture(): void {}
  getBoundingClientRect(): { left: number; top: number } {
    return { left: 0, top: 0 };
  }
}

type Call = readonly ['hold', number] | readonly ['press', number];

function recorder(): { session: Session; calls: Call[] } {
  const calls: Call[] = [];
  const session = {
    hold: (axis: number) => calls.push(['hold', axis]),
    press: (buttons: number) => calls.push(['press', buttons]),
  } as unknown as Session;
  return { session, calls };
}

const pointer = (type: string, x: number, y: number) => Object.assign(new Event(type), { clientX: x, clientY: y, pointerId: 1, pointerType: 'touch' });

/** Palec na domovské pozici Pixelu 7 (střed kroužku ~72 × 657 px): tah, ťuk jinde a zrušený tah. */
function playDrags(surface: Surface): void {
  const at = (type: string, x: number, y: number) => surface.dispatchEvent(pointer(type, x, y));
  at('pointerdown', 72, 657);
  at('pointermove', 76, 660); // pod DRAG_PX – osa zůstává
  at('pointermove', 112, 657); // doprava
  at('pointermove', 112, 617); // šikmo doprava nahoru
  at('pointermove', 72, 567); // nahoru, dál než dosah páčky
  at('pointermove', 47, 687); // doleva dolů
  at('pointerup', 47, 687);
  at('pointerdown', 300, 400); // ťuk jinde = akce
  at('pointerup', 300, 400);
  at('pointerdown', 200, 300);
  at('pointermove', 200, 380); // dolů
  at('pointercancel', 200, 380);
}

/** Volání z `main` pro `playDrags` (osa = směr po 11,25°, ±1000 = dolů, 1 = nahoru, 0 = stát). */
const MAIN_CALLS: readonly Call[] = [
  ['hold', 0],
  ['hold', 500],
  ['hold', 250],
  ['hold', 1],
  ['hold', -750],
  ['hold', 0],
  ['hold', 0],
  ['press', BUTTON.TAP],
  ['hold', 0],
  ['hold', 0],
  ['hold', 1000],
  ['hold', 0],
];

function drive(withStick: boolean): { calls: Call[]; ring: { left: string; top: string; active: string | undefined }[] } {
  const surface = new Surface();
  const { session, calls } = recorder();
  const ring: { left: string; top: string; active: string | undefined }[] = [];
  if (withStick) {
    // V `ArcadeStage` je kroužek dítě plochy: jeho efekt (posluchači) běží před efektem `useArenaInput`.
    // React 19: ref je v props prvku.
    const element = TouchStick({ surface: { current: surface as unknown as HTMLDivElement } }) as unknown as { props: { ref: { current: { style: Record<string, string>; dataset: Record<string, string> } } } };
    const base = element.props.ref.current;
    const look = () => ring.push({ left: base.style.left ?? '', top: base.style.top ?? '', active: base.dataset.active });
    surface.addEventListener('pointerdown', look);
    surface.addEventListener('pointerup', look);
  }
  useArenaInput(session, { current: surface as unknown as HTMLDivElement }, true);
  playDrags(surface);
  return { calls, ring };
}

describe('P64 thumb joystick', () => {
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the same drag gives the same session.hold calls as main', () => {
    expect(drive(false).calls).toEqual(MAIN_CALLS);
  });

  it('the ring on the surface changes no call', () => {
    expect(drive(true).calls).toEqual(MAIN_CALLS);
  });

  it('a finger re-centres the ring under itself and lifting sends it back home', () => {
    // Posluchač `look` běží po kroužku: po položení prstu stojí kroužek pod prstem, po puštění bez inline polohy
    // (domovská pozice z `play.css` na výšku, jinde skrytý).
    expect(drive(true).ring).toEqual([
      { left: '72px', top: '657px', active: 'true' },
      { left: '', top: '', active: undefined },
      { left: '300px', top: '400px', active: 'true' },
      { left: '', top: '', active: undefined },
      { left: '200px', top: '300px', active: 'true' },
    ]);
  });
});
