/**
 * Tlačítko PLAY podle kitu Sayplay (`.sp-btn`): `primary` je rajčatová
 * akce (jedna na obrazovku), `secondary` papír, `sun` slunečná podpora,
 * `link` podtržený text. Velikost L 62 px, M 52 px, S 44 px. `data-variant`
 * nese variantu do DOM, aby test karty spočítal hlavní akce (má být právě
 * jedna); `.play-button` zůstává kvůli e2e. `ref` projde na `<button>`
 * (React 19) – sdílení na něj věší nativní posluchače.
 */

import type { ComponentProps } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'sun' | 'link';

export function Button({
  variant = 'primary',
  size = 'm',
  className,
  type = 'button',
  ...rest
}: ComponentProps<'button'> & { readonly variant?: ButtonVariant; readonly size?: 'l' | 'm' | 's' }) {
  const classes = [
    'sp-btn',
    `sp-btn--${variant}`,
    size === 'l' ? null : `sp-btn--${size}`,
    'play-button',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <button type={type} className={classes} data-variant={variant} {...rest} />;
}
