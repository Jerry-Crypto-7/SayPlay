'use client';

/**
 * Klientská polovina routy: postaví partii z rozhodnutí routeru a nechá ji
 * běžet na 20 Hz.
 *
 * `ssr: false` je povinné, ne kosmetické — `FallbackStage` uvnitř drží
 * `<Canvas>` a WebGL kontext na serveru neexistuje.
 *
 * **Postup je hráč.** Do 19. 8. 2026 tady běžela stopa od řešitele archetypu a
 * hra si hrála sama: bylo to deterministické a smoke test z toho dostal pokaždé
 * tentýž průběh, ale hráč neměl jak zasáhnout. Stopa je pryč, vstup jde z
 * klávesnice.
 *
 * Klávesnice se přitom **do hry nedostane**. Posluchač ji přeloží na `Intent` a
 * dál jde jenom záměr — tentýž tvar, jaký posílal řešitel. Proto zůstávají v
 * platnosti všechna tvrzení, která T203 dokázal enumerací n-tic: hra nepozná
 * rozdíl mezi prstem a stopou.
 *
 * Záměry se **řadí do fronty a čerpají po tiku**, ne aplikují hned. Tik je
 * jediná jednotka času; kdyby se klávesa vyhodnotila v okamžiku stisku, dva
 * rychlé stisky uvnitř jednoho tiku by daly dva pohyby a hra by přestala být
 * krokovatelná. Fronta má strop, takže držená klávesa nenaplní paměť.
 */

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';

import { intentFromKey } from '@/fallback/input';
import { DEFAULT_MAX_TICKS, MS_PER_TICK, type GameView, type Intent } from '@/fallback/loop';
import type { RouteDecision } from '@/fallback/router';
import { sessionFor } from '@/fallback/session';

const FallbackStage = dynamic(() => import('@/fallback/hud').then((mod) => mod.FallbackStage), {
  ssr: false,
});

/**
 * Kolik nevyčerpaných záměrů se drží.
 *
 * Není to výkonová optimalizace: bez stropu by držená klávesa (auto-repeat jede
 * rychleji, než tikají hodiny) vyrobila frontu, kterou hra dohání ještě dlouho
 * po puštění klávesy. Tři tiky napřed je hranice, za kterou už ovládání
 * přestává reagovat na to, co hráč právě dělá.
 */
const MAX_QUEUED_INTENTS = 3;

declare global {
  interface Window {
    /**
     * Most k běžící partii.
     *
     * Je to jediný způsob, jak se z prohlížeče zeptat **skutečné hry**, kde
     * stojí postava — HUD kreslí cíl a počítadla, souřadnice v něm nemají co
     * dělat. Jádro má most stejného tvaru a ze stejného důvodu; jeho jméno se
     * sem napsat nesmí, protože důkaz izolace hledá jména globálů jádra jako
     * holý text, takže by tenhle soubor spadl do karantény kvůli komentáři.
     */
    __fallback?: {
      /** Buňka postavy, nebo `null` u hry, která žádnou nemá. */
      avatar: () => readonly [number, number] | null;
      tick: () => number;
      phase: () => GameView['phase'] | null;
      /** Kolik záměrů čeká ve frontě na svůj tik. */
      queued: () => number;
    };
  }
}

export default function PlayView({
  decision,
  prompt,
}: {
  decision: RouteDecision;
  prompt: string;
}) {
  const session = useMemo(
    () => (decision.kind === 'archetype' ? sessionFor(decision, prompt) : null),
    [decision, prompt],
  );
  const [view, setView] = useState<GameView | null>(null);
  const queue = useRef<Intent[]>([]);

  // Posluchač visí na dokumentu, ne na plátně: `<canvas>` sám fokus nedostane a
  // hráč by musel nejdřív někam kliknout, aby se hra rozjela.
  useEffect(() => {
    if (session === null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const intent = intentFromKey(event.key);
      if (intent === null) return;
      // Šipky jinak posunou stránku pod hrou.
      event.preventDefault();
      if (queue.current.length >= MAX_QUEUED_INTENTS) return;
      queue.current.push(intent);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [session]);

  useEffect(() => {
    if (session === null) {
      setView(null);
      return;
    }

    const { game, seed } = session;
    let state = game.create(seed);
    let tick = 0;
    queue.current = [];
    setView(game.project(state));

    const timer = setInterval(() => {
      if (game.project(state).phase !== 'running' || tick >= DEFAULT_MAX_TICKS) {
        clearInterval(timer);
        return;
      }
      // Jeden záměr na tik. Zbytek fronty počká — víc pohybů v jednom tiku by
      // znamenalo, že rychlost prstu obchází pravidla hry.
      const intent = queue.current.shift();
      state = game.advance(state, intent === undefined ? [] : [intent]);
      tick += 1;
      setView(game.project(state));
    }, MS_PER_TICK);

    window.__fallback = {
      avatar: () => game.project(state).avatar,
      tick: () => game.project(state).tick,
      phase: () => game.project(state).phase,
      queued: () => queue.current.length,
    };

    return () => {
      clearInterval(timer);
      delete window.__fallback;
    };
  }, [session]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <FallbackStage decision={decision} view={view} />
    </div>
  );
}
