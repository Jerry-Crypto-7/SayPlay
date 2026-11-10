/**
 * Vzhled věcí klikací simulace (P83C T7): tvar věci bez modelu podle druhu a místo jmenovky na plátně.
 *
 * První brána (T5) ukázala, že město ze čtyř koulí a srdce ze čtyř koulí soudce nepozná: budova dostane kvádr se
 * střechou, park a strom korunu na kmeni. Jmenovky jsou vidět od startu, takže se u osmi věcí na telefonu musí
 * rozestoupit – `placeTags` každé najde místo nad, pod nebo vedle věci, kde nepřekryje jinou jmenovku ani věc.
 */

export type ThingShape = 'building' | 'tree' | 'ball';

/** Budova podle posledního slova popisku („fire station“, „town hall“); knihovna u nich dává vnitřek (třída, lůžko). */
const BUILDING = /\b(?:school|hospital|station|house|home|shop|store|library|museum|bank|church|castle|tower|factory|barn|bakery|cafe|restaurant|hotel|office|hall|cinema|theat(?:er|re)|mall|market|stadium|garage|lighthouse|cottage|cabin|hut|palace|temple|skyscraper|apartments?|building|warehouse|mill|windmill|pharmacy|supermarket|airport|kindergarten|university|college|gym|prison|jail|courthouse|firehouse)$/;
/** Zeleň: koruna na kmeni, když knihovna model nemá. */
const GREEN = /\b(?:tree|park|forest|bush|hedge|garden|woods|grove|orchard)$/;

/** Tvar věci podle popisku z věty; budova má tvar vždy (model knihovny je u ní vnitřek), zeleň jen bez modelu. */
export function shapeOf(label: string | undefined, hasModel: boolean): ThingShape | 'model' {
  const word = (label ?? '').trim().toLowerCase();
  if (BUILDING.test(word)) return 'building';
  if (hasModel) return 'model';
  return GREEN.test(word) ? 'tree' : 'ball';
}

/** Věc na plátně: střed a poloměr (px plátna, y dolů). */
export interface ScreenThing {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/** Jmenovka na plátně: střed a rozměry (px). */
export interface TagRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Pás plátna, kde jmenovka smí být: pod HUD a nad zónou palce. */
export interface TagBand {
  readonly width: number;
  readonly top: number;
  readonly bottom: number;
}

/** Mezera mezi věcí a jmenovkou (px). */
export const TAG_GAP_PX = 4;

const overlap = (a: TagRect, b: TagRect): number =>
  Math.max(0, Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2)) *
  Math.max(0, Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2));

/** Kolik plochy jmenovky leží mimo pás. */
const outside = (rect: TagRect, band: TagBand): number => rect.w * rect.h - overlap(rect, { x: band.width / 2, y: (band.top + band.bottom) / 2, w: band.width, h: band.bottom - band.top });

/**
 * Místa jmenovky kolem věci, v pořadí přednosti: nad, pod, vpravo, vlevo, šikmo (roh jmenovky u věci), o řádek výš
 * a níž.
 */
function spotsAround(thing: ScreenThing, w: number, h: number): readonly TagRect[] {
  const above = thing.y - thing.r - TAG_GAP_PX - h / 2;
  const below = thing.y + thing.r + TAG_GAP_PX + h / 2;
  const side = thing.r + TAG_GAP_PX + w / 2;
  const slant = thing.r * Math.SQRT1_2 + TAG_GAP_PX + w / 2;
  const lift = thing.r * Math.SQRT1_2 + TAG_GAP_PX + h / 2;
  return [
    { x: thing.x, y: above, w, h },
    { x: thing.x, y: below, w, h },
    { x: thing.x + side, y: thing.y, w, h },
    { x: thing.x - side, y: thing.y, w, h },
    { x: thing.x + slant, y: thing.y - lift, w, h },
    { x: thing.x - slant, y: thing.y - lift, w, h },
    { x: thing.x + slant, y: thing.y + lift, w, h },
    { x: thing.x - slant, y: thing.y + lift, w, h },
    { x: thing.x, y: above - h - TAG_GAP_PX, w, h },
    { x: thing.x, y: below + h + TAG_GAP_PX, w, h },
  ];
}

type Size = { readonly w: number; readonly h: number };

/** Jeden hladový průchod v pořadí `order`; vrací i jmenovky, které volné místo nenašly. */
function placeInOrder(things: readonly ScreenThing[], sizes: readonly Size[], band: TagBand, previous: readonly number[], order: readonly number[]) {
  const rects: TagRect[] = new Array<TagRect>(things.length);
  const choice: number[] = new Array<number>(things.length).fill(0);
  const placed: TagRect[] = [];
  const stuck: number[] = [];
  for (const index of order) {
    const thing = things[index] as ScreenThing;
    const size = sizes[index] as Size;
    const options = spotsAround(thing, size.w, size.h);
    const cost = (rect: TagRect): number =>
      placed.reduce((sum, other) => sum + overlap(rect, other), 0) +
      things.reduce((sum, other, at) => (at === index ? sum : sum + overlap(rect, { x: other.x, y: other.y, w: 2 * other.r, h: 2 * other.r })), 0) +
      outside(rect, band);
    // Volno = překryv pod 1 px²: plocha mimo pás je rozdíl dvou ploch a v plovoucí čárce málokdy vyjde přesně nula.
    const costs = options.map(cost).map((value) => (value < 1 ? 0 : value));
    const kept = previous[index];
    // Nad věcí vždy, když je tam volno; jinak minulé místo, dokud je volné (při oběhu jmenovka neskáče), jinak první volné.
    const free = costs[0] === 0 ? 0 : kept !== undefined && costs[kept] === 0 ? kept : costs.indexOf(0);
    const pick = free >= 0 ? free : costs.indexOf(Math.min(...costs));
    if (free < 0) stuck.push(index);
    choice[index] = pick;
    rects[index] = options[pick] as TagRect;
    placed.push(options[pick] as TagRect);
  }
  return { rects, choice, stuck };
}

/**
 * Jmenovky všech věcí bez překryvu: po pořadí věcí každá vezme první místo, které nepřekryje už položenou jmenovku,
 * jinou věc ani okraj pásu; nad věcí má přednost, kdykoli je volno, potom místo z minulého snímku (`previous`), dokud
 * je volné – jmenovka při oběhu neskáče sem a tam. Jmenovka, která volné místo nenašla, jde v dalším průchodu na řadu první (nejvýš tolik průchodů,
 * kolik je věcí); když ani pak, vezme místo s nejmenším překryvem. Vrací obdélníky a zvolená místa.
 *
 * simplified: hladové průchody s posunem uvízlých dopředu – u devíti věcí stačí; víc věcí v hustém shluku → plný rozvrh.
 */
export function placeTags(things: readonly ScreenThing[], sizes: readonly Size[], band: TagBand, previous: readonly number[] = []): { readonly rects: TagRect[]; readonly choice: number[] } {
  let order = things.map((_, index) => index);
  let best = placeInOrder(things, sizes, band, previous, order);
  for (let pass = 1; pass < things.length && best.stuck.length > 0; pass += 1) {
    const stuck = best.stuck;
    order = [...stuck, ...order.filter((index) => !stuck.includes(index))];
    const next = placeInOrder(things, sizes, band, previous, order);
    if (next.stuck.length < best.stuck.length) best = next;
  }
  return { rects: best.rects, choice: best.choice };
}
