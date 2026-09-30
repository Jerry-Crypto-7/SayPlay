/**
 * Ikony PLAY podle kitu Sayplay: sprite `public/brand/icons/sprite.svg`
 * (`docs/brand/icons/`), mřížka 24 × 24, tah 2,2 px, barva z textu
 * (`currentColor`). Žádná knihovna ikon a žádné emoji. Jména jsou jména
 * symbolů ve spritu bez předpony `sp-`.
 */

const SPRITE = '/brand/icons/sprite.svg';

export const ICON_NAMES = [
  'mic',
  'dice',
  'play',
  'plus',
  'grid',
  'user',
  'restart',
  'share',
  'wand',
  'pause',
  'close',
  'link',
  'story',
  'download',
  'message',
  'egg',
  'clock',
  'check',
  'chevron-left',
  'chevron-right',
  'arrow-right',
  'info',
  'alert',
  'sound-on',
  'sound-off',
  'trophy',
  'settings',
  'search',
  'heart',
  'flag',
  'eye-off',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

export function Icon({ name }: { readonly name: IconName }) {
  return (
    <svg className="sp-icon play-icon" aria-hidden="true" focusable="false">
      <use href={`${SPRITE}#sp-${name}`} />
    </svg>
  );
}
