/** Čip PLAY podle kitu (`.sp-chip`): návrh na jedno klepnutí, 44 px vysoký; `.play-chip` kvůli e2e. */

import type { ButtonHTMLAttributes } from 'react';

export function Chip({ className, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={className === undefined ? 'sp-chip play-chip' : `sp-chip play-chip ${className}`} {...rest} />;
}
