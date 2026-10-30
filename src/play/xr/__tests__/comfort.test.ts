/**
 * Pohodlí ve VR (P67 T9): volby panelu „Comfort“ v `localStorage` a co z nich rig postaví. Volba, která se uloží,
 * ale nepoužije, vypadá funkčně – použití (stůl vsedě níž) drží e2e `vr-hud.spec.ts` sondou výšky.
 */

import { describe, expect, it } from 'vitest';

import {
  COMFORT_DEFAULTS,
  COMFORT_KEY,
  type Comfort,
  SEATED_DROP,
  comfortNow,
  deskHome,
  frameOf,
  loadComfort,
  saveComfort,
  setComfort,
  sizedLayout,
  sizedMode,
  sizedRoomScale,
  yawOfHead,
} from '../comfort';
import { DESK, DESK_LAYOUT, STAGE, STAGE_LAYOUT, STAGE_POSE, TABLE } from '../diorama-scale';
import { DESK_MODE, XR_MODES } from '../modes';

/** `localStorage` v paměti. */
function memory(): { readonly store: Map<string, string>; readonly storage: () => Pick<Storage, 'getItem' | 'setItem'> } {
  const store = new Map<string, string>();
  return {
    store,
    storage: () => ({
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    }),
  };
}

const SEATED_SMALL: Comfort = { stance: 'seated', size: 'small', haptics: false, vignette: false };

describe('comfort options in localStorage', () => {
  it('nothing saved yet gives the defaults: standing, medium, haptics and vignette on', () => {
    expect(loadComfort(memory().storage)).toEqual({ stance: 'standing', size: 'medium', haptics: true, vignette: true });
    expect(COMFORT_DEFAULTS).toEqual({ stance: 'standing', size: 'medium', haptics: true, vignette: true });
  });

  it('saved options load back the same, under one key', () => {
    const { store, storage } = memory();
    for (const comfort of [SEATED_SMALL, { stance: 'standing', size: 'large', haptics: true, vignette: false } as const]) {
      saveComfort(comfort, storage);
      expect(loadComfort(storage)).toEqual(comfort);
    }
    expect([...store.keys()]).toEqual([COMFORT_KEY]);
  });

  it('a storage that throws on access, on read or on write gives the defaults and never throws', () => {
    const denied = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    expect(loadComfort(denied)).toEqual(COMFORT_DEFAULTS);
    expect(() => saveComfort(SEATED_SMALL, denied)).not.toThrow();
    const broken = () => ({ getItem: denied, setItem: denied });
    expect(loadComfort(broken)).toEqual(COMFORT_DEFAULTS);
    expect(() => saveComfort(SEATED_SMALL, broken)).not.toThrow();
    // Bez prohlížeče (`window` není) taky.
    expect(loadComfort()).toEqual(COMFORT_DEFAULTS);
  });

  it('a damaged record gives the defaults; an unknown value falls back only for its own option', () => {
    const { store, storage } = memory();
    for (const raw of ['{not json', 'null', '7', '"seated"']) {
      store.set(COMFORT_KEY, raw);
      expect(loadComfort(storage), raw).toEqual(COMFORT_DEFAULTS);
    }
    store.set(COMFORT_KEY, JSON.stringify({ stance: 'lying', size: 'large', haptics: 'no', vignette: false }));
    expect(loadComfort(storage)).toEqual({ stance: 'standing', size: 'large', haptics: true, vignette: false });
  });

  it('setComfort keeps the choice for the page even when the storage refuses it', () => {
    const { storage } = memory();
    setComfort(SEATED_SMALL, storage);
    expect(comfortNow()).toEqual(SEATED_SMALL);
    expect(loadComfort(storage)).toEqual(SEATED_SMALL);
    setComfort(COMFORT_DEFAULTS, () => {
      throw new Error('quota');
    });
    expect(comfortNow()).toEqual(COMFORT_DEFAULTS);
  });
});

describe('what the rig builds from the options', () => {
  const ahead = { x: 0, z: 0, yaw: 0 };

  it('standing without recenter leaves the table and the stage where they always were', () => {
    const frame = frameOf('standing', ahead);
    expect(deskHome(TABLE, frame)).toEqual(DESK);
    expect(deskHome(STAGE, frame)).toEqual(STAGE_POSE);
  });

  it('seated lowers the table and the stage by the eye drop, nothing else moves', () => {
    const frame = frameOf('seated', ahead);
    expect(frame.top).toBe(-SEATED_DROP);
    const table = deskHome(TABLE, frame);
    expect(table).toMatchObject({ x: DESK.x, z: DESK.z, yaw: 0 });
    expect(table.top).toBeCloseTo(TABLE.top - SEATED_DROP, 9);
    expect(deskHome(STAGE, frame).top).toBeCloseTo(STAGE.top - SEATED_DROP, 9);
  });

  it('recenter turns the table to where the head looks and puts it in front of the head', () => {
    // Hlava otočená o čtvrt kruhu doleva (kolem +y) se dívá na −x.
    const left = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    const yaw = yawOfHead(left)!;
    expect(yaw).toBeCloseTo(Math.PI / 2, 9);
    const table = deskHome(TABLE, frameOf('standing', { x: 0.5, z: 0.2, yaw }));
    expect(table.x).toBeCloseTo(0.5 + TABLE.z, 9);
    expect(table.z).toBeCloseTo(0.2, 9);
    expect(table.top).toBeCloseTo(TABLE.top, 9);
    expect(table.yaw).toBeCloseTo(Math.PI / 2, 9);
    // Pohled rovně a sklon dolů směr nezmění; svisle dolů směr není.
    expect(yawOfHead({ x: 0, y: 0, z: 0, w: 1 })).toBe(0);
    const down = (40 * Math.PI) / 180;
    expect(yawOfHead({ x: -Math.sin(down / 2), y: 0, z: 0, w: Math.cos(down / 2) })).toBeCloseTo(0, 9);
    expect(yawOfHead({ x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 })).toBeNull();
  });

  it('Small puts tracks and games around the player on the table; hand games and table games stay', () => {
    expect(sizedMode(XR_MODES.arena, 'small')).toEqual(DESK_MODE);
    expect(sizedMode(XR_MODES.runner, 'small')).toEqual(DESK_MODE);
    expect(sizedMode(XR_MODES.shooter, 'small')).toBe(XR_MODES.shooter);
    expect(sizedMode(XR_MODES.quest, 'small')).toBe(XR_MODES.quest);
    for (const size of ['medium', 'large'] as const) expect(sizedMode(XR_MODES.arena, size)).toBe(XR_MODES.arena);
  });

  it('size scales the table and the stage worlds; the world around the player never beyond 1:1', () => {
    const area = { minX: -10, maxX: 10, minY: 0, maxY: 2, minZ: -10, maxZ: 10 };
    expect(sizedLayout(DESK_LAYOUT, 'medium')).toBe(DESK_LAYOUT);
    expect(sizedLayout(DESK_LAYOUT, 'small').scale(area)).toBeCloseTo(DESK_LAYOUT.scale(area) * 0.75, 12);
    expect(sizedLayout(STAGE_LAYOUT, 'large').scale(area)).toBeCloseTo(STAGE_LAYOUT.scale(area) * 1.25, 12);
    // Pódium se pozná podle prostoru, ne podle identity rozvržení (`Diorama`).
    expect(sizedLayout(STAGE_LAYOUT, 'large').room).toBe(STAGE);
    expect(sizedRoomScale(0.4, 'large')).toBeCloseTo(0.5, 12);
    expect(sizedRoomScale(1, 'large')).toBe(1);
    expect(sizedRoomScale(0.4, 'medium')).toBe(0.4);
  });
});
