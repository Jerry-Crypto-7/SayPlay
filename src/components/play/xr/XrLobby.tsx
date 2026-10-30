'use client';

/**
 * VR lobby (P67 T2): hra z věty bez sundání brýlí. Karta kitu metr před hráčem, ve výšce očí:
 *
 * - šest karet vět z `IDEAS` a `STARTERS` v pevném pořadí, „More ideas“ listuje dál dokola;
 * - „Type“ otevře 3D klávesnici (`XrKeyboard`) pod kartou, „Done“ ji zavře;
 * - „Say it“ (P67 T3, jen kde prohlížeč diktuje) nadiktuje větu do náhledu (`XrMic`);
 * - „Comfort“ (P67 T9) otevře panel pohodlí (`XrComfort`) místo karty; lobby pod ním žije dál (`covered`),
 *   takže náhled věty po „Done“ zůstane;
 * - „Make it!“ (jediná rajčatová akce) → `createGame()` → `router.push`, tatáž cesta jako formulář na `/play`.
 *   Mezitím „Making…“, chyba dveří zůstane na kartě (kit, Errors).
 *
 * Karta nápadu větu jen vloží do náhledu, hru spustí až „Make it!“ – jako na domově (kit: klepnutí nespouští
 * stavbu). Navigace `/play` → `/play/<id>` zůstává v layoutu `/play` s `XrGate`, takže XR relace i plátno žijí dál
 * (`e2e/vr-lobby.spec.ts`). Lobby zmizí, až je na obrazovce nová hra (`lobbyShown`); do té doby hráč vidí „Making…“.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { openComfort } from '@/play/xr/comfort';
import { type KeyPress, typed } from '@/play/xr/keyboard';

import type { ArcadeSession } from '../arcade/session';
import { createGame } from '../create-game';
import { IDEAS, PROMPT_LABEL, SENTENCE_LIMIT, STARTERS, TOO_VAGUE } from '../starters';
import type { DeskReport } from './Diorama';
import { madeInXrLobby } from './xr-lobby';
import { type Anchor, COMFORT, XrColumn } from './XrHud';
import { keyboardOf, KEYBOARD_WIDTH } from './XrKeyboard';
import { LISTENING, useXrMic } from './XrMic';
import type { PanelAim, PanelButton, PanelSpec, PanelTone } from './XrPanel';

export const MAKE_IT = 'Make it!';
export const MAKING = 'Making…';
export const MORE_IDEAS = 'More ideas';
export const TYPE = 'Type';

/** Věty karet v pevném pořadí: nápady domova, pak startovní věty. */
export const LOBBY_IDEAS: readonly string[] = [...IDEAS.map((idea) => idea.sentence), ...STARTERS.map((starter) => starter.sentence)];
/** Karet na stránce lobby. */
export const PAGE_SIZE = 6;
const PAGES = Math.ceil(LOBBY_IDEAS.length / PAGE_SIZE);

/** Karty `page` (dokola); poslední neúplná stránka se doplní ze začátku, ať je karet vždy šest. */
export function ideasOnPage(page: number): string[] {
  const from = (page % PAGES) * PAGE_SIZE;
  return Array.from({ length: PAGE_SIZE }, (_, index) => LOBBY_IDEAS[(from + index) % LOBBY_IDEAS.length]!);
}

/** Barvy karet v pořadí kitu, jako karty nápadů na domově. */
const TONES: readonly PanelTone[] = ['mint', 'sun', 'sky', 'bubblegum'];

/**
 * Metr před hráčem, horní hrana 5 cm nad očima, měřítko 0,8: karta 520 × ~490 px kitu je ~48° široká a visí do
 * ~35° pod oči; text karet (18 px kitu) má ~1,6°, nejmenší písmo kitu (13 px) ~1,2° – nad 0,9° z pravidel plánu.
 */
const FRONT: Anchor = { kind: 'front', distance: 1, up: 0.05, scale: 0.8 };

export function XrLobby({ shown, aim, covered }: { readonly shown: ArcadeSession | null; readonly aim: PanelAim; readonly covered: boolean }) {
  const router = useRouter();
  const desk = useRef<DeskReport | null>(null);
  const [sentence, setSentence] = useState('');
  const [page, setPage] = useState(0);
  const [typing, setTyping] = useState(false);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hra na obrazovce ve chvíli, kdy dveře odpoví – lobby pak čeká na jinou.
  const onScreen = useRef(shown);
  const live = useRef(true);
  useEffect(() => {
    onScreen.current = shown;
  });
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const edit = (next: (previous: string) => string): void => {
    if (making) return;
    setSentence(next);
    setError(null);
  };

  const make = async (): Promise<void> => {
    if (making) return;
    const text = sentence.trim();
    if (text === '') {
      setError(TOO_VAGUE);
      return;
    }
    setMaking(true);
    setError(null);
    const created = await createGame(text);
    if (!live.current) return;
    if ('error' in created) {
      setMaking(false);
      setError(created.error);
      return;
    }
    madeInXrLobby(onScreen.current);
    router.push(created.url);
  };

  // Nadiktovaná věta náhled nahradí jako karta nápadu (P67 T3): druhý pokus po špatném přepisu nemá co mazat.
  const mic = useXrMic({ blocked: making, onListen: () => setError(null), onText: (spoken) => edit(() => spoken.slice(0, SENTENCE_LIMIT)), onError: setError });
  const micButton = mic.button === null ? [] : [mic.button];
  const title = mic.listening ? LISTENING : PROMPT_LABEL;
  const makeIt: PanelButton = { id: 'make', label: making ? MAKING : MAKE_IT, primary: true, press: () => void make() };
  const lobby: PanelSpec = typing
    ? {
        id: 'lobby',
        width: KEYBOARD_WIDTH,
        title,
        // Kurzor na konci náhledu: klávesnice píše vždy na konec věty.
        body: `${sentence}|`,
        note: error ?? undefined,
        stats: [{ value: `${String(sentence.length)}/${String(SENTENCE_LIMIT)}`, caption: null, label: 'counter' }],
        buttons: [...micButton, makeIt],
        inline: true,
      }
    : {
        id: 'lobby',
        width: KEYBOARD_WIDTH,
        title,
        body: sentence === '' ? undefined : sentence,
        note: error ?? undefined,
        grid: {
          columns: 2,
          cells: ideasOnPage(page).map((idea, index) => ({ id: `idea-${String(index)}`, label: idea, tone: TONES[index % TONES.length], press: () => edit(() => idea) })),
        },
        // „Comfort“ první: řada se zalomí (`layoutOf`) a „Make it!“ zůstane poslední.
        buttons: [
          { id: 'comfort', label: COMFORT, press: () => !making && openComfort() },
          { id: 'more', label: MORE_IDEAS, press: () => !making && setPage((now) => now + 1) },
          { id: 'type', label: TYPE, press: () => !making && setTyping(true) },
          ...micButton,
          makeIt,
        ],
      };
  const onKey = (key: KeyPress): void => edit((previous) => typed(previous, key, SENTENCE_LIMIT));
  const specs = typing ? [lobby, keyboardOf(onKey, () => setTyping(false))] : [lobby];
  return covered ? null : <XrColumn anchor={FRONT} specs={specs} desk={desk} aim={aim} />;
}
