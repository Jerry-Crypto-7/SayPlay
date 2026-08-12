export type SlotKind = 'counter' | 'flag' | 'timer' | 'enum';

export interface SlotSpec {
  readonly id: string;
  readonly kind: SlotKind;
  readonly min: number;
  readonly max: number;
  readonly initial: number;
}

export interface StateLayout {
  readonly slots: readonly SlotSpec[];
  readonly index: ReadonlyMap<string, number>;
}

/**
 * Rozvržení zabaleného stavu. Kontroly jsou tu proto, že layout nakonec pochází
 * z dokumentu emitovaného modelem — je to hranice, ne vnitřní volání.
 */
export function defineLayout(slots: readonly SlotSpec[]): StateLayout {
  const index = new Map<string, number>();
  slots.forEach((slot, position) => {
    if (index.has(slot.id)) {
      throw new Error(`duplicate slot id: ${slot.id}`);
    }
    if (slot.min > slot.max) {
      throw new Error(`slot ${slot.id} has min above max`);
    }
    if (slot.max - slot.min > 0xffffffff) {
      throw new Error(`slot ${slot.id} does not fit in a 32-bit word`);
    }
    if (slot.initial < slot.min || slot.initial > slot.max) {
      throw new Error(`slot ${slot.id} has an initial value outside its bounds`);
    }
    index.set(slot.id, position);
  });
  return { slots, index };
}

/**
 * Stav je `Uint32Array`, protože přesně tohle se hashuje. Hodnota se ukládá jako
 * odchylka od `min`, takže se do neznaménkového slova vejde i čítač se záporným
 * dolním mezníkem.
 */
export function createState(layout: StateLayout): Uint32Array {
  const state = new Uint32Array(layout.slots.length);
  layout.slots.forEach((slot, position) => {
    state[position] = slot.initial - slot.min;
  });
  return state;
}

export function slotIndex(layout: StateLayout, id: string): number {
  const position = layout.index.get(id);
  if (position === undefined) {
    throw new Error(`unknown slot: ${id}`);
  }
  return position;
}

export function readSlot(layout: StateLayout, state: Uint32Array, id: string): number {
  const position = slotIndex(layout, id);
  return state[position] + layout.slots[position].min;
}

/**
 * Zápis clampuje na deklarované meze. Clamp není chyba — protokol to má takhle
 * u `addCounter` a je to jediné chování, které drží stav konečný bez výjimky.
 */
export function writeSlot(layout: StateLayout, state: Uint32Array, id: string, value: number): void {
  const position = slotIndex(layout, id);
  const slot = layout.slots[position];
  const clamped = value < slot.min ? slot.min : value > slot.max ? slot.max : value;
  state[position] = clamped - slot.min;
}
