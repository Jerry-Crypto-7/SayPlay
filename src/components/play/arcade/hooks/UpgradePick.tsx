'use client';

/**
 * Výběr vylepšení mezi vlnami (P66 T4): tři karty ve spodní polovině obrazovky (zóna palce, `play-hooks.css`)
 * na `upgrade_offer`, do `upgrade_pick` jádra. Klepnutí na kartu i klávesy 1 / 2 / 3 pošlou **tentýž** vstup
 * (`pickCard`: `BUTTON.PICK_1..3`, `UPGRADE_PICK_BUTTONS`) přes `ArcadeSession` – volba je vstup v záznamu, takže
 * ji přehrání zopakuje. Karty jen nabízejí: kterou jádro vzalo, říká až `upgrade_pick` (nevybere-li hráč do
 * `pickTicks`, vezme kartu 0 – proužek času nad kartami ubývá do té doby).
 *
 * Karty jsou papírové; výchozí karta 0 je slunečná, rajčatová akce na obrazovce zůstává jedna (ne tady).
 */

import { type Ref, useEffect, useRef, useState } from 'react';

import { ARCADE_HZ, UNIT } from '@/play/arcade/contract';
import { UPGRADE_OFFER, UPGRADE_PICK_BUTTONS, UPGRADE_STEP, type UpgradeId } from '@/play/arcade/hooks/contract';

import { Icon, type IconName } from '../../ui/icons';
import { isTyping } from '../input';
import type { ArcadeSession } from '../session';

/** Text karty (anglicky, `11-voice-copy.md`): co vylepšení dělá a o kolik – čísla z `UPGRADE_STEP`. */
export const UPGRADE_TEXT: Readonly<Record<UpgradeId, { readonly title: string; readonly gain: string; readonly icon: IconName }>> = {
  speed: { title: 'Run faster', gain: `+${UPGRADE_STEP.speed}%`, icon: 'dash' },
  // O 20 % kratší rozestup ran = o 25 % víc ran za sekundu.
  fire_rate: { title: 'Shoot faster', gain: `+${Math.round(10_000 / (100 - UPGRADE_STEP.fire_rate)) - 100}%`, icon: 'shoot' },
  range: { title: 'Shoot further', gain: `+${UPGRADE_STEP.range}%`, icon: 'arrow-right' },
  extra_life: { title: 'Extra life', gain: `+${UPGRADE_STEP.extra_life}`, icon: 'heart' },
  magnet: { title: 'Magnet', gain: `+${UPGRADE_STEP.magnet / UNIT} m`, icon: 'egg' },
  carry: { title: 'Carry more', gain: `+${UPGRADE_STEP.carry}`, icon: 'grab' },
};

/** Čas na volbu (ms) pro proužek nad kartami. */
const PICK_MS = (UPGRADE_OFFER.pickTicks / ARCADE_HZ) * 1000;

/** Klávesa 1 / 2 / 3 → karta 0–2; jiná `null`. */
export function cardOfKey(key: string): number | null {
  const card = ['1', '2', '3'].indexOf(key);
  return card < 0 ? null : card;
}

/** Volba karty `card` (0–2): jediný vstup volby, ať klepnutí a klávesa nemůžou poslat každé něco jiného. */
export function pickCard(session: Pick<ArcadeSession, 'press'>, card: number): void {
  session.press(UPGRADE_PICK_BUTTONS[card]!);
}

/** Klávesa nad nabídkou: 1 / 2 / 3 vybere kartu (ne při psaní, se zkratkou ani podržením); `true` = vybráno. */
export function pickKey(session: Pick<ArcadeSession, 'press'>, event: Pick<KeyboardEvent, 'key' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey' | 'target'>): boolean {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return false;
  const card = cardOfKey(event.key);
  if (card === null) return false;
  pickCard(session, card);
  return true;
}

/** Tři karty nabídky; `pressed` = karta, kterou hráč právě zvolil (zamáčkne se, než jádro volbu potvrdí). */
export function UpgradeCards({
  offer,
  pressed,
  onPick,
  ref,
}: {
  readonly offer: readonly UpgradeId[];
  readonly pressed: number | null;
  readonly onPick: (card: number) => void;
  readonly ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={ref} className="play-hook-cards" data-testid="upgrade-pick" role="group" aria-label="Pick an upgrade">
      <span className="play-hook-timer" style={{ animationDuration: `${PICK_MS}ms` }} aria-hidden="true" />
      {offer.map((upgrade, card) => {
        const text = UPGRADE_TEXT[upgrade];
        const classes = ['play-hook-card', card === UPGRADE_OFFER.defaultCard ? 'is-default' : '', card === pressed ? 'is-pressed' : ''].filter(Boolean).join(' ');
        return (
          <button key={card} type="button" className={classes} data-testid={`upgrade-card-${card}`} data-upgrade={upgrade} aria-keyshortcuts={String(card + 1)} onClick={() => onPick(card)}>
            <span className="play-hook-key" aria-hidden="true">
              {card + 1}
            </span>
            <Icon name={text.icon} />
            <span className="play-hook-card-title">{text.title}</span>
            <span className="play-hook-card-gain">{text.gain}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Karty nabídky nad plátnem: klepnutí i klávesy 1 / 2 / 3 jdou přes `pickCard`. */
export function UpgradePick({ session, offer }: { readonly session: Pick<ArcadeSession, 'press'>; readonly offer: readonly UpgradeId[] }) {
  const [pressed, setPressed] = useState<number | null>(null);
  const cards = useRef<HTMLDivElement | null>(null);
  // Ťuk na kartu nesmí doběhnout k ploše scény – tam je to pohyb nebo skok. Plocha poslouchá nativně, takže
  // zastavit to musí nativní posluchač (React by přišel až po ní), stejně jako u `FireButton`.
  useEffect(() => {
    const element = cards.current;
    if (element === null) return;
    const stop = (event: PointerEvent) => event.stopPropagation();
    element.addEventListener('pointerdown', stop);
    element.addEventListener('pointerup', stop);
    return () => {
      element.removeEventListener('pointerdown', stop);
      element.removeEventListener('pointerup', stop);
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!pickKey(session, event)) return;
      event.preventDefault();
      setPressed(cardOfKey(event.key));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);
  const pick = (card: number): void => {
    pickCard(session, card);
    setPressed(card);
  };
  return <UpgradeCards ref={cards} offer={offer} pressed={pressed} onPick={pick} />;
}
