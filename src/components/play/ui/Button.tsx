/**
 * Tlačítko PLAY (P33 T3). `primary` je teal akce, `accent` jantarové
 * zvýraznění, `quiet` obrys pro vedlejší cestu. `data-variant` nese variantu
 * do DOM, aby test karty spočítal hlavní akce (má být právě jedna).
 */

import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'accent' | 'quiet';

export function Button({
  variant = 'primary',
  size = 'm',
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: ButtonVariant; readonly size?: 'm' | 'l' }) {
  const classes = ['play-button', `play-button-${variant}`, size === 'l' ? 'play-button-l' : null, className].filter(Boolean).join(' ');
  return <button type={type} className={classes} data-variant={variant} {...rest} />;
}
