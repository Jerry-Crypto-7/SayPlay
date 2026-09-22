'use client';

/**
 * Proužek progresivní hry (P23-D T2): návrh ze slov se hraje hned a server
 * mezitím dopočítá autorskou verzi. Hook se ptá `GET …/upgrade` každé 2 s,
 * nejvýš 90 s; proužek se ukáže jen na `ready`. Rozehraná hra se **nepřepíná
 * sama** – přejde se až tlačítkem.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const POLL_MS = 2_000;
const POLL_LIMIT_MS = 90_000;

/** `versionId` autorské verze, jakmile je hotová; jinak `null`. `url === null` = neptej se. */
export function useUpgrade(url: string | null): string | null {
  const [ready, setReady] = useState<string | null>(null);

  useEffect(() => {
    if (url === null) return;
    const control = new AbortController();
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const ask = async (): Promise<void> => {
      try {
        const response = await fetch(url, { signal: control.signal, cache: 'no-store' });
        if (response.ok) {
          const body = (await response.json()) as { status?: string; versionId?: unknown };
          if (body.status === 'ready' && typeof body.versionId === 'string') {
            setReady(body.versionId);
            return;
          }
          if (body.status !== 'pending') return;
        }
      } catch {
        if (control.signal.aborted) return;
      }
      if (Date.now() - started + POLL_MS <= POLL_LIMIT_MS) timer = setTimeout(() => void ask(), POLL_MS);
    };

    timer = setTimeout(() => void ask(), POLL_MS);
    return () => {
      control.abort();
      clearTimeout(timer);
    };
  }, [url]);

  return ready;
}

export function UpgradeBanner({ versionId }: { readonly versionId: string }) {
  const router = useRouter();
  return (
    <aside className="play-upgrade" data-testid="play-upgrade" role="status">
      <span>Your custom version is ready</span>
      <button className="play-button" type="button" onClick={() => router.push(`/play/${versionId}`)}>
        Play it
      </button>
    </aside>
  );
}
