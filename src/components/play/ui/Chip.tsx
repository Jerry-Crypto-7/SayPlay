/** Čip PLAY (P33 T3): návrh na jedno klepnutí, 44 px vysoký. */

import type { ButtonHTMLAttributes } from 'react';

export function Chip({ className, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={className === undefined ? 'play-chip' : `play-chip ${className}`} {...rest} />;
}
