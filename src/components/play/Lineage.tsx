'use client';

/**
 * Rodokmen (P23-C T6): odkud hra pochází a kolik remixů z ní vzešlo. Ve
 * shellu je to poslední řádek listu „About this game“ (P33 T7); bez něj
 * (feed) proužek nad hrou jako dřív.
 *
 * `lineage` je uložený při publikaci, od kořene k listu, a poslední záznam je
 * tahle hra – rodič je tedy předposlední. Počet dětí se čte při načtení
 * stránky; na hraně smí být o chvíli pozadu, je to navigace, ne pravda o hře.
 *
 * Řetěz a rozdíl (P37C T7): remix remixu ukáže celou cestu od originálu
 * (dlouhou zkrátí na kořen, „…“ a poslední dva), a remix hráče 1–3 čipy, co
 * se proti rodiči změnilo („+dragons“, „faster“). Čipy počítá `remixChips`
 * ze specu obou her; přijdou po načtení, a když čtení selže, prostě chybí.
 */

import Link from 'next/link';
import { Fragment, useEffect, useMemo, useState } from 'react';

import type { GameVersion } from '@/play/contracts';
import type { GameSpecV1 } from '@/play/spec';
import { remixChips } from '@/play/version/remix-diff';

import { RemixChain } from './RemixChain';
import { useInInfoSheet, useInfoPart } from './ui/InfoContext';

/** Delší řetěz předků se zkrátí: kořen, „…“ a tolik posledních. */
const CHAIN_TAIL = 2;

/** Předci od kořene k rodiči; `null` = vynechaný úsek. */
export function chainOf(lineage: readonly GameVersion[]): (GameVersion | null)[] {
  const ancestors = lineage.slice(0, -1);
  return ancestors.length <= CHAIN_TAIL + 2 ? ancestors : [ancestors[0]!, null, ...ancestors.slice(-CHAIN_TAIL)];
}

async function specOf(versionId: string, signal: AbortSignal): Promise<GameSpecV1> {
  const response = await fetch(`/api/play/games/${versionId}`, { signal });
  if (!response.ok) throw new Error(`game ${String(response.status)}`);
  return ((await response.json()) as { spec: GameSpecV1 }).spec;
}

/** Čipy rozdílu remixu proti rodiči; prázdné, dokud se nenačtou nebo když čtení selže. */
function useRemixChips(parentId: string | null, childId: string): readonly string[] {
  const [chips, setChips] = useState<readonly string[]>([]);
  useEffect(() => {
    if (parentId === null) return;
    const control = new AbortController();
    Promise.all([specOf(parentId, control.signal), specOf(childId, control.signal)])
      .then(([parent, child]) => setChips(remixChips(parent, child)))
      // Bez čipů rodokmen pořád řekne, odkud hra je.
      .catch(() => undefined);
    return () => control.abort();
  }, [parentId, childId]);
  return chips;
}

/** `aiVersion`: hra je vylepšení návrhu od AI (`relation: 'upgrade'`), ne remix hráče (P26 T8). */
export function Lineage({ lineage, remixes, aiVersion = false }: { readonly lineage: readonly GameVersion[]; readonly remixes: number; readonly aiVersion?: boolean }) {
  const parent = lineage.length >= 2 ? lineage[lineage.length - 2]! : null;
  // Vylepšení od AI není remix hráče – rozdíl proti návrhu by vyjmenoval detaily, ne změnu.
  const self = lineage.at(-1)?.versionId ?? '';
  const chips = useRemixChips(aiVersion || parent === null ? null : parent.versionId, self);
  // Řetěz remixů (P44B T11) jen v listu „About this game“: ve feedu je rodokmen skrytý a nic navíc nečte.
  const remixChain = useInInfoSheet() && remixes > 0 && self !== '';
  const line = useMemo(
    () => (
      <p className="play-lineage" data-testid="play-lineage">
        {parent === null ? (
          <span>Original</span>
        ) : (
          <span data-testid="play-lineage-chain">
            {aiVersion ? 'Full-detail version of' : 'Remixed from'}{' '}
            {chainOf(lineage).map((step, index) => (
              <Fragment key={step?.versionId ?? `gap-${String(index)}`}>
                {index > 0 && ' → '}
                {step === null ? '…' : <Link href={`/play/${step.versionId}`}>{step.title}</Link>}
              </Fragment>
            ))}
          </span>
        )}
        {remixes > 0 && <span className="play-lineage-count">{remixes === 1 ? '1 remix' : `${remixes} remixes`}</span>}
        {chips.length > 0 && (
          <span className="play-chips" data-testid="play-remix-changes" aria-label="What this remix changed">
            {chips.map((chip) => (
              <span key={chip} className="sp-chip">
                {chip}
              </span>
            ))}
          </span>
        )}
        {remixChain && <RemixChain versionId={self} />}
      </p>
    ),
    [parent, lineage, remixes, aiVersion, chips, remixChain, self],
  );
  return useInfoPart('lineage', line) ? null : line;
}
