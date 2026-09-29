/**
 * Ikony PLAY (P33 T3): vlastní tahy na mřížce 24 × 24, barva z textu.
 * Žádná knihovna ikon a žádné emoji – každá ikona je pár čar kreslených tady.
 */

import type { ReactNode } from 'react';

const PATHS = {
  close: <path d="M6 6l12 12M18 6L6 18" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  next: <path d="M12 5v14M6 13l6 6 6-6" />,
  share: <path d="M12 4v11M7 9l5-5 5 5M5 14v5h14v-5" />,
  'sound-on': <path d="M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />,
  'sound-off': <path d="M4 9h4l5-4v14l-5-4H4zM16 9l6 6M22 9l-6 6" />,
  mic: <path d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v3" />,
  replay: <path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { readonly name: IconName }) {
  return (
    <svg className="play-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
