/**
 * Kotvy otevřeného slovníku (P44C T3): ke kterému kusu hry se neznámé sloveso přimkne.
 *
 * Každý cíl – pohyb, akce a cíl hry ze smlouvy záměru (`intent/contract.ts`) a viditelná
 * činnost hrdiny (`hero-action.ts`) – má kotevní slovesa a synsety Open English WordNet 2024.
 * Stavba tabulky (`scripts/vocab/build.mjs`) jde od synsetu neznámého slovesa po hyperonymech,
 * dokud nenarazí na synset kotvy; slovesa kotvy jsou text pro embeddingovou zálohu.
 *
 * Kotvy neodporují ruční tabulce `ROWS` v `intent/extract.ts`: sloveso, které ruční tabulka zná,
 * je kotvou jen toho cíle, na který ho tabulka posílá (hlídá `__tests__/anchors.test.ts`).
 * Osa hrdiny je na osách záměru nezávislá – „whisk“ může být akce i póza zároveň.
 *
 * Synsety jsou id vydání OEWN 2024 (`oewn-<offset>-v`), které stavba pinuje SHA archivu.
 */

import type { ActionId, MoveId, ObjectiveId } from '../intent/contract';
import type { HeroAction } from '../hero-action';

export type AxisTarget = `move:${MoveId}` | `action:${ActionId}` | `objective:${ObjectiveId}`;
export type HeroTarget = `hero:${Exclude<HeroAction, 'none'>}`;
export type AnchorTarget = AxisTarget | HeroTarget;

export interface Anchor {
  /** Slovesa v základním tvaru; u os záměru je ruční tabulka čte jako tento cíl. */
  readonly verbs: readonly string[];
  /** Synsety OEWN 2024, ke kterým vede cesta hyperonym. */
  readonly synsets: readonly string[];
  /** Věta, ve které ruční tabulka sloveso pozná, když holé „you <verb> the thing“ nestačí. */
  readonly frame?: string;
}

/** Věta pro kontrolu kotvy proti ruční tabulce; `{verb}` = kotevní sloveso. */
export const DEFAULT_FRAME = 'you {verb} the thing';

export const ANCHORS = {
  'move:run': { verbs: ['run', 'dash', 'ski', 'skate', 'surf'], synsets: ['oewn-01930264-v'] },
  'move:jump': { verbs: ['jump', 'hop', 'leap', 'bounce', 'climb'], synsets: ['oewn-01967949-v', 'oewn-01925957-v', 'oewn-01927862-v'] },
  'move:flap': { verbs: ['flap', 'flutter'], synsets: ['oewn-01905776-v', 'oewn-02097668-v'] },
  'move:drive': {
    verbs: ['drive', 'steer', 'ride', 'sail', 'paddle', 'gallop', 'drift'],
    synsets: ['oewn-01934845-v', 'oewn-01934070-v', 'oewn-01961388-v', 'oewn-01959843-v', 'oewn-01850600-v', 'oewn-01949375-v'],
  },
  'move:roam': { verbs: ['roam', 'waddle', 'explore'], synsets: ['oewn-01885173-v'] },
  'move:glide': {
    verbs: ['glide', 'soar', 'swim', 'dive', 'hover', 'fly'],
    synsets: ['oewn-01891569-v', 'oewn-01946206-v', 'oewn-01944262-v', 'oewn-01944952-v', 'oewn-01964770-v', 'oewn-01947307-v'],
  },
  'move:walk': { verbs: ['walk', 'stroll', 'wander', 'sneak', 'tiptoe', 'hide'], synsets: ['oewn-01908923-v', 'oewn-01915881-v'] },
  'move:ball': { verbs: ['dribble'], synsets: ['oewn-01411414-v'] },

  'action:shoot': { verbs: ['shoot', 'blast', 'snipe', 'zap'], synsets: ['oewn-01139564-v', 'oewn-01137207-v', 'oewn-01138209-v'] },
  'action:throw': { verbs: ['throw', 'toss', 'fling', 'hurl', 'lob'], synsets: ['oewn-01511000-v', 'oewn-01509775-v'] },
  'action:fight': {
    verbs: ['fight', 'battle', 'wrestle', 'punch', 'attack', 'stomp', 'slash', 'brawl', 'spar', 'squash'],
    synsets: ['oewn-01092746-v', 'oewn-01121587-v', 'oewn-01122487-v', 'oewn-01412877-v', 'oewn-00069650-v'],
    // Proti jednomu soupeři je to v ruční tabulce souboj (`duel`), proti více rvačka.
    frame: 'you {verb} the goblins',
  },
  'action:collect': {
    verbs: ['collect', 'gather', 'grab', 'steal', 'hoard', 'loot', 'munch', 'eat'],
    synsets: ['oewn-02309962-v', 'oewn-02326737-v', 'oewn-02349564-v'],
  },
  'action:deliver': {
    // Šablony pravidel `carry` a `give` (`arcade/rules/templates.ts`): haul, transport, give, hand, offer, feed.
    verbs: ['carry', 'deliver', 'bring', 'escort', 'serve', 'fetch', 'haul', 'transport', 'give', 'hand', 'offer', 'feed'],
    synsets: ['oewn-01452567-v', 'oewn-01440941-v', 'oewn-02081903-v', 'oewn-01435927-v', 'oewn-02029675-v', 'oewn-01957669-v'],
  },
  'action:interact': {
    // Šablona `open`: open, pull, unlock, flip – ruční tabulka je bez dveří nebo páky nepozná.
    verbs: ['rescue', 'save', 'ignite', 'kindle', 'extinguish', 'activate', 'unlock', 'smash', 'pop', 'liberate', 'open', 'pull', 'flip'],
    synsets: ['oewn-02426474-v', 'oewn-02556841-v', 'oewn-02765572-v', 'oewn-02767855-v', 'oewn-01647199-v', 'oewn-01348685-v', 'oewn-00336733-v'],
  },
  'action:stack': { verbs: ['stack', 'pile', 'heap'], synsets: ['oewn-01506036-v'] },
  'action:time': { verbs: ['time'], synsets: ['oewn-00703992-v'], frame: 'you {verb} your jump' },
  'action:beat': { verbs: ['dance', 'drum', 'sing'], synsets: ['oewn-01898642-v', 'oewn-01712535-v', 'oewn-01736413-v', 'oewn-01733312-v'] },
  'action:duel': { verbs: ['duel', 'argue', 'debate', 'negotiate', 'persuade', 'convince'], synsets: ['oewn-01124374-v', 'oewn-00775477-v'] },
  // Šablona `push` (push, shove, nudge, kick) je v záměru kopnutí do věci.
  'action:kick': { verbs: ['kick', 'push', 'shove', 'nudge'], synsets: ['oewn-01374421-v', 'oewn-01373226-v', 'oewn-01875972-v'] },

  'objective:race': { verbs: ['race'], synsets: ['oewn-01088514-v'] },
  'objective:reach': { verbs: ['reach'], synsets: ['oewn-02024442-v'] },
  'objective:collect': { verbs: ['collect', 'gather', 'grab', 'steal', 'eat'], synsets: ['oewn-01387093-v'], frame: 'you {verb} all the coins' },
  'objective:survive': { verbs: ['survive', 'outlast', 'defend', 'protect'], synsets: ['oewn-02624202-v'] },
  'objective:escape': { verbs: ['escape', 'flee', 'outrun'], synsets: ['oewn-02078906-v', 'oewn-02079709-v', 'oewn-01931561-v'] },
  'objective:defeat': {
    verbs: ['defeat', 'kill', 'slay', 'destroy', 'eliminate', 'conquer', 'vanquish'],
    synsets: ['oewn-01110559-v', 'oewn-01326622-v', 'oewn-01622948-v', 'oewn-01085766-v'],
  },
  'objective:catch': { verbs: ['chase', 'hunt', 'pursue', 'stalk', 'catch'], synsets: ['oewn-02005890-v', 'oewn-02004900-v', 'oewn-01217985-v', 'oewn-01441809-v'] },
  'objective:score': { verbs: ['score'], synsets: ['oewn-01114241-v'] },
  'objective:land': { verbs: ['land'], synsets: ['oewn-01983915-v', 'oewn-01985050-v'] },
  'objective:build': { verbs: ['build', 'construct'], synsets: ['oewn-01658171-v', 'oewn-01656984-v'] },

  'hero:stir': { verbs: ['stir', 'whisk'], synsets: ['oewn-01898313-v'] },
  'hero:spray': { verbs: ['spray', 'squirt', 'hose'], synsets: ['oewn-01375347-v', 'oewn-01376216-v'] },
  'hero:stack': { verbs: ['stack', 'pile'], synsets: ['oewn-01506036-v'] },
  'hero:carry': { verbs: ['carry', 'haul'], synsets: ['oewn-01452567-v'] },
  'hero:sweep': { verbs: ['sweep', 'mop', 'scrub', 'vacuum', 'wipe', 'shovel'], synsets: ['oewn-01396368-v', 'oewn-01253792-v', 'oewn-01395993-v'] },
  'hero:throw': { verbs: ['throw', 'toss'], synsets: ['oewn-01511000-v'] },
  'hero:dig': { verbs: ['dig'], synsets: ['oewn-01312361-v'] },
  'hero:paint': { verbs: ['paint'], synsets: ['oewn-01365439-v', 'oewn-01688794-v'] },
  'hero:chop': { verbs: ['chop', 'carve'], synsets: ['oewn-01260655-v'] },
  'hero:water': { verbs: ['water', 'irrigate'], synsets: ['oewn-00228662-v', 'oewn-00229081-v'] },
  'hero:knit': { verbs: ['knit', 'sew', 'stitch'], synsets: ['oewn-01674934-v', 'oewn-01331921-v', 'oewn-01670222-v'] },
  'hero:fix': { verbs: ['fix', 'repair', 'weld'], synsets: ['oewn-00261534-v', 'oewn-01598751-v'] },
} as const satisfies Readonly<Record<AnchorTarget, Anchor>>;

export const ANCHOR_TARGETS = Object.keys(ANCHORS) as AnchorTarget[];
