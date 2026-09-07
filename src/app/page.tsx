'use client';

/**
 * **Hlavní cesta produktu: věta → relace → svět na plátně** (P15 `T21b`,
 * odblokováno `T47-t21bunblock`).
 *
 * Do 6. 9. 2026 tady stála stará herní scéna: `PromptBar` vybral emisi
 * z korpusu, rozpoznávače nebo lokálního modelu a `Stage` z ní hrál
 * `WorldDocRuntime`. Ta stránka se nemaže, přestěhovala se na `/classic`
 * i s celou svojí sadou testů.
 *
 * Tohle je jiný systém a je to ten, o kterém je celý design book:
 *
 *   věta → `POST /api/worldstream/sessions` → proud rámců (§20) → blueprint →
 *   `buildProxyWorldFrom()` v prohlížeči → `WorldstreamStage`.
 *
 * ## Co stránka drží a co schválně nedrží
 *
 * Drží **stav jedné relace**: fázi, svět, poruchu. Nedrží nic o meshingu ani
 * o výměně podoby — hot-swap má vlastní harness na `/dev/worldstream` a
 * tlačítka toho harnessu na produkční stránku nepatří (rozhodnutí `T21b`
 * ze 6. 9. 2026). Až poteče detail proudem relace, přijde sem jako `upgrade`
 * pro `WorldstreamStage`; dokud neteče, stránka o něm mlčí.
 *
 * ## Server je jediný autor světa
 *
 * Blueprint se **nedopočítává** z ničeho, co by si stránka domyslela: přijde
 * rámcem `blueprint.ready` a projde `blueprintSchema` znovu, tady. Server ho
 * validoval taky, a to je schválně dvakrát — mezi nimi je síť a `unknown`,
 * takže bez druhého čtení by se do `buildProxyWorldFrom()` dostal objekt,
 * o kterém překladač jen věří, že má správný tvar.
 *
 * ## Odchod čtenáře neruší relaci
 *
 * `AbortController` zavře **čtení**, ne generaci: relace na serveru běží dál
 * (`client.ts`). Druhá věta tedy nezahazuje zaplacenou práci té první, jen
 * na ni přestane čekat.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import ChangePreview, { type ChangeState } from '@/components/worldstream/ChangePreview';
import WorldStatus, { type WorldStatusState } from '@/components/worldstream/WorldStatus';
import WorldstreamApp from '@/components/worldstream/WorldstreamApp';
import { createMeshClient, type MeshClient } from '@/shape/mesh-client';
import {
  commitChange,
  followSession,
  openWorldstreamSession,
  readBlueprint,
  requestChange,
  type AuthoredProvenance,
  type SessionHandle,
} from '@/worldstream/client';
import {
  buildProxyWorldFrom,
  PROXY_RUNG_LABELS,
  type ProxyWorld,
} from '@/worldstream/proxy';
import { pickQualityTier, type QualityTier } from '@/worldstream/quality';
import { blueprintSchema } from '@/worldstream/schema';

// `ssr: false` je povinné, ne kosmetické — WebGL2 kontext na serveru
// neexistuje a `<Canvas>` by při prerenderu spadl na `document`.
const WorldstreamCanvas = dynamic(() => import('@/components/worldstream/WorldstreamCanvas'), {
  ssr: false,
});

/**
 * Věta, kterou porotce uvidí, když relace skončí bez světa a bez důvodu.
 *
 * Text poruchy ze serveru je **veřejná věta** (`SESSION_FAULTS`), ne výjimka
 * poskytovatele — do proudu se nic jiného nedostane. Když ani ta nedorazí,
 * zbude tahle: relace skončila a svět nevznikl, což je celá pravda, kterou
 * v tu chvíli známe.
 */
const UNKNOWN_FAULT = 'the session ended without a world';

/** Co z relace vyleze: buď blueprint, nebo věta, proč žádný nebude. */
type Arrival = { readonly blueprint: unknown } | { readonly fault: string };

/**
 * První blueprint z relace — **ne její konec**.
 *
 * `followSession()` se vrátí až na koncové fázi, jenže `advance('complete')`
 * nemá v provozu volajícího (`sessions.ts`): relace zůstává po `world.ready`
 * otevřená, aby do ní mohla přijít druhá věta a hlášení o mešovaných tvarech
 * (§21). Čekat na její konec by tedy znamenalo čekat navždy — naměřeno
 * 6. 9. 2026, stavová věta stála na `building` devadesát vteřin.
 *
 * Čte se proto `onState`: jakmile proud donese blueprint, je co stavět.
 * Proud se přitom **nezavírá** — běží dál pod rukou, protože další rámce téže
 * relace patří téhle stránce. Zavře ho až druhá věta nebo odchod.
 *
 * Slib se plní **právě jednou**; `then` níž je proto druhá větev, ne návazný
 * krok: relace, která skončila bez blueprintu, musí umět vydat svoji větu.
 */
function firstBlueprint(
  handle: SessionHandle,
  signal: AbortSignal,
): Promise<Arrival> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (arrival: Arrival): void => {
      if (settled) return;
      settled = true;
      resolve(arrival);
    };

    void followSession(handle, {
      signal,
      onState: (state) => {
        if (state.blueprint !== null) done({ blueprint: state.blueprint });
      },
    })
      .then((final) => done({ fault: final.fault ?? UNKNOWN_FAULT }))
      .catch((error: unknown) =>
        done({ fault: error instanceof Error ? error.message : String(error) }),
      );
  });
}

export default function Page() {
  const [world, setWorld] = useState<ProxyWorld | null>(null);
  /** Běží relace? Rozhoduje o stavové větě i o zamčeném tlačítku. */
  const [streaming, setStreaming] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  /**
   * Odkud je svět na plátně. `null` znamená „napsal ho model teď".
   *
   * Přepisuje se **až se světem**, ne při odeslání věty: dokud stará scéna
   * stojí, platí o ní starý popisek. Kdyby se nuloval dřív, produkt by během
   * generace jednu vteřinu tvrdil, že přehrávaný svět je čerstvý.
   */
  const [provenance, setProvenance] = useState<AuthoredProvenance | null>(null);
  const [sentence, setSentence] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const toggleInspect = useCallback(() => setInspecting((was) => !was), []);

  /* ---------------------------------------------------------------- *
   * Dějství III: druhá věta (`T35-actsthree4`).
   * ---------------------------------------------------------------- */

  /**
   * Relace, do které se druhá věta posílá. `null` znamená „zatím není co měnit".
   *
   * Drží se **relace, ne svět**: preview i commit jsou dvoje dveře jedné relace
   * a obojí potřebuje její id. Svět na plátně je až její výsledek.
   */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [second, setSecond] = useState('');
  const [change, setChange] = useState<ChangeState | null>(null);
  /** Odkud je plán změny. `null` znamená „napsal ho model teď". */
  const [changeFrom, setChangeFrom] = useState<AuthoredProvenance | null>(null);
  /** Běží preview nebo commit? Dvojklik by jinak poslal dvě žádosti. */
  const [changing, setChanging] = useState(false);

  /**
   * Meshovací klient. **Jeden na celou stránku**, ne jeden na relaci: worker
   * stojí start a druhá věta by ho zaplatila znovu. Zavírá se s odchodem
   * ze stránky.
   */
  const mesher = useRef<MeshClient | null>(null);
  /** Čtení právě běžící relace. Nová věta to předchozí zruší. */
  const reading = useRef<AbortController | null>(null);
  /** Úroveň kvality. Čte se jednou, po připojení — sahá na `document`. */
  const tier = useRef<QualityTier>('full');

  useEffect(() => {
    const client = createMeshClient();
    mesher.current = client;
    tier.current = pickQualityTier(window.location.search);

    return () => {
      reading.current?.abort();
      mesher.current = null;
      client.dispose();
    };
  }, []);

  const submit = useCallback(
    async (event: FormEvent): Promise<void> => {
      event.preventDefault();
      const prompt = sentence.trim();
      if (prompt === '' || streaming) return;

      // Předchozí čtení se ruší **před** otevřením nové relace, aby dva proudy
      // nepsaly do jednoho stavu. Relaci to na serveru neruší, jen ji přestaneme
      // poslouchat.
      reading.current?.abort();
      const control = new AbortController();
      reading.current = control;

      setStreaming(true);
      setFault(null);
      setWorld(null);
      // Nová věta zakládá **novou** relaci, takže po té staré nesmí zůstat ani
      // rozdělaný plán změny, ani její adresa: commit do zavřené relace by
      // skončil 404 a panel by mezitím tvrdil, že se pořád o něčem rozhoduje.
      setSessionId(null);
      setChange(null);
      setChangeFrom(null);

      try {
        const handle = await openWorldstreamSession(prompt, { signal: control.signal });
        const arrival = await firstBlueprint(handle, control.signal);
        if (control.signal.aborted) return;

        if (!('blueprint' in arrival)) {
          setFault(arrival.fault);
          return;
        }

        // Server blueprint validoval taky. Čte se podruhé, protože mezi tím je
        // síť a `unknown` — bez toho by se dovnitř dostal objekt, o kterém
        // překladač jen věří, že má správný tvar.
        const parsed = blueprintSchema.safeParse(arrival.blueprint);
        if (!parsed.success) {
          setFault(`the world that arrived does not parse: ${parsed.error.issues[0]?.message ?? '?'}`);
          return;
        }

        const client = mesher.current;
        if (client === null) return;
        const built = await buildProxyWorldFrom(parsed.data, {
          mesh: (order) => client.mesh(order),
          quality: tier.current,
        });
        if (control.signal.aborted) return;

        // Odmítnutý svět není svět. Věta o něm je ta, kterou napsal
        // `buildProxyWorldFrom()` — ta ví, na čem stavba ztroskotala.
        if (built.kind === 'built') {
          setWorld(built);
          setProvenance(handle.authored);
          setSessionId(handle.sessionId);
        } else setFault(built.reason);
      } catch (error: unknown) {
        if (control.signal.aborted) return;
        setFault(error instanceof Error ? error.message : String(error));
      } finally {
        if (!control.signal.aborted) setStreaming(false);
      }
    },
    [sentence, streaming],
  );

  /**
   * Druhá věta → **plán, ne změna**. Design book §4 dějství III: rozsah se
   * ukáže dřív, než se cokoli změní.
   *
   * `stableId` má přednost před textem, a je to celý smysl nabídky kandidátů:
   * když porotce na objekt ukázal, o cíli rozhodl on, ne rozpoznávač. Grounding
   * je přitom na serveru **před** modelem, takže nejasná věta nestojí nic.
   */
  const plan = useCallback(
    async (stableId?: string): Promise<void> => {
      const prompt = second.trim();
      if (sessionId === null || prompt === '' || changing) return;
      const signal = reading.current?.signal;

      setChanging(true);
      try {
        const outcome = await requestChange(sessionId, prompt, {
          ...(signal === undefined ? {} : { signal }),
          ...(stableId === undefined ? {} : { stableId }),
        });

        if (outcome.kind === 'ambiguous') {
          setChange({
            kind: 'candidates',
            reason: outcome.reason,
            candidates: outcome.candidates,
          });
          setChangeFrom(null);
          return;
        }
        if (outcome.kind === 'refused') {
          setChange({ kind: 'refused', message: outcome.detail });
          setChangeFrom(null);
          return;
        }

        setChange({
          kind: 'preview',
          changeId: outcome.changeId,
          summary: outcome.summary,
          target: outcome.target,
          scope: outcome.scope,
          preserved: outcome.preserved,
        });
        setChangeFrom(outcome.authored);
      } catch (error: unknown) {
        setChange({ kind: 'refused', message: error instanceof Error ? error.message : String(error) });
        setChangeFrom(null);
      } finally {
        setChanging(false);
      }
    },
    [second, sessionId, changing],
  );

  /**
   * Potvrzení plánu — **jediné místo, kde se svět mění**.
   *
   * Nový svět se čte ze snapshotu relace, ne z odpovědi commitu: autoritativní
   * stav je snapshot (§21), takže druhá kopie světa v odpovědi by byla druhá
   * pravda. Stavba pak jde toutéž cestou jako po první větě — `blueprintSchema`
   * podruhé, `buildProxyWorldFrom()`, plátno.
   */
  const apply = useCallback(async (): Promise<void> => {
    if (sessionId === null || change === null || change.kind !== 'preview' || changing) return;
    const client = mesher.current;
    if (client === null) return;
    const signal = reading.current?.signal;

    setChanging(true);
    try {
      const done = await commitChange(sessionId, change.changeId, {
        ...(signal === undefined ? {} : { signal }),
      });
      if (done.kind === 'refused') {
        setChange({ kind: 'refused', message: done.detail });
        return;
      }

      const parsed = blueprintSchema.safeParse(
        await readBlueprint(sessionId, { ...(signal === undefined ? {} : { signal }) }),
      );
      if (!parsed.success) {
        setChange({ kind: 'refused', message: 'the changed world does not parse' });
        return;
      }

      const built = await buildProxyWorldFrom(parsed.data, {
        mesh: (order) => client.mesh(order),
        quality: tier.current,
      });
      if (built.kind !== 'built') {
        setChange({ kind: 'refused', message: built.reason });
        return;
      }

      setWorld(built);
      setChange(null);
      setChangeFrom(null);
      setSecond('');
    } catch (error: unknown) {
      setChange({ kind: 'refused', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setChanging(false);
    }
  }, [change, changing, sessionId]);

  /** Zahození plánu. Sahá **jen** na panel — svět ani revize se nehnou. */
  const discard = useCallback(() => {
    setChange(null);
    setChangeFrom(null);
  }, []);

  // Pořadí je pořadí pravdy: porucha přebíjí běžící relaci, protože relace
  // skončila; běžící relace přebíjí prázdno, protože se něco děje.
  const status: WorldStatusState =
    fault !== null ? 'broken' : streaming ? 'building' : world === null ? 'empty' : 'live';

  return (
    <WorldstreamApp
      inspecting={inspecting}
      onInspect={toggleInspect}
      prompt={
        <form onSubmit={(event) => void submit(event)} data-testid="prompt-form" style={FORM}>
          <input
            data-testid="prompt-input"
            aria-label="Describe a place"
            placeholder="a drowned cathedral lit from below"
            value={sentence}
            onChange={(event) => setSentence(event.target.value)}
            style={INPUT}
          />
          <button type="submit" data-testid="prompt-submit" disabled={streaming} style={BUTTON}>
            {streaming ? 'Building…' : 'Build the world'}
          </button>
        </form>
      }
      status={<WorldStatus state={status} detail={fault} />}
      provenance={<AuthoredNotice provenance={world === null ? null : provenance} />}
      change={
        sessionId === null || world === null ? null : (
          <>
            {change === null ? null : (
              <ChangePreview
                state={change}
                onChoose={(stableId) => void plan(stableId)}
                onApply={() => void apply()}
                onDiscard={discard}
                busy={changing}
              />
            )}
            <AuthoredChangeNotice provenance={change === null ? null : changeFrom} />
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void plan();
              }}
              data-testid="refine-form"
              style={FORM}
            >
              <input
                data-testid="refine-input"
                aria-label="Change one thing in this world"
                placeholder="paint the containers rust red"
                value={second}
                onChange={(event) => setSecond(event.target.value)}
                style={INPUT}
              />
              <button type="submit" data-testid="refine-submit" disabled={changing} style={BUTTON}>
                {changing ? 'Working…' : 'Change it'}
              </button>
            </form>
          </>
        )
      }
      inspect={<WorldFacts world={world} />}
      stage={<WorldstreamCanvas world={world} />}
    />
  );
}

/**
 * „Tenhle svět jsem uměl dopředu" — **nahlas, anglicky, na obrazovce**
 * (`T45-honestlabel`).
 *
 * Model se pro tohle demo nekupuje (`G2`, 5. 9. 2026), takže neznámou větu
 * obslouží nejbližší svět ze skladu uvařeného dopředu. Bez téhle věty by
 * produkt tvrdil, že tuhle větu napsal model teď — a je to nepravda, kterou
 * porotce odhalí druhou větou, protože dvě různé věty dostanou tentýž svět.
 * **Poctivost je tady levnější než iluze.**
 *
 * Mlčí se **jedině tehdy, když svět napsal model** (`provenance` je `null`).
 *
 * ⚠ **Do 7. 9. 2026 se mlčelo i u přesné shody a od `T14r-actone` je to
 * nepravda.** Tehdy platilo „nic se nenahrazovalo, není co přiznávat": sklad
 * uměl právě tuhle větu, takže odpověď byla její. Od `T14r-actone` ale uvařený
 * svět vydávají i dveře, na které nevyšel placený slot, takže přesná shoda
 * přestala znamenat „sklad tuhle větu uměl" a začala znamenat „tenhle svět je
 * uložený". Uložený svět bez popisku je tvrzení, že ho model napsal teď.
 * **Rozhodla debata Opus ↔ Codex 7. 9. 2026**, `.claude/debate/worldstream-twoacts-decision.md`.
 *
 * Dvě věty, protože „nejbližší" a „přesně tenhle" jsou dvě různé pravdy a
 * jedna společná by musela lhát u jedné z nich.
 *
 * Text jmenuje, co se stalo, a neomlouvá se. Omluva by z poctivosti udělala
 * vadu; tohle je vlastnost.
 */
function AuthoredNotice({
  provenance,
}: {
  readonly provenance: AuthoredProvenance | null;
}) {
  if (provenance === null) return null;

  return (
    <p className="ws-provenance" data-testid="world-authored">
      {provenance.match === 'exact'
        ? 'This world was authored ahead of time.'
        : 'This is the closest world authored ahead of time.'}
    </p>
  );
}

/**
 * Totéž o **druhé** větě (`T35-actsthree4`).
 *
 * Je to samostatná komponenta, ne parametr té nad ní, protože říká jinou věc:
 * tam se přiznává původ **světa**, tady původ **plánu změny**. Jeden text pro
 * obojí by porotci nad změněným světem tvrdil, že je přehrávaný celý svět.
 *
 * Mlčí ze stejných dvou důvodů: změnu píše model (`null`), nebo věta trefila
 * uvařenou změnu **přesně** — tam se nic nenahrazovalo.
 */
function AuthoredChangeNotice({
  provenance,
}: {
  readonly provenance: AuthoredProvenance | null;
}) {
  if (provenance === null || provenance.match !== 'nearest') return null;

  return (
    <p className="ws-provenance" data-testid="change-authored">
      This is the closest change authored ahead of time.
    </p>
  );
}

/**
 * Co v tom světě doopravdy stojí — **jediný panel Inspectu na hlavní cestě**.
 *
 * Není to log a není to ozdoba: hrubý svět dává každému objektu příčku žebříku
 * (§27) a právě ta odpovídá na otázku „proč tenhle kus vypadá jako bedna?".
 * Bez ní je hlína němá a porotce ji čte jako vadu vykreslování.
 *
 * Pět panelů staré stránky (`Program`, `Timeline`, `WitnessPreview`,
 * `RepairRounds`, `ModelProgress`) sem **nejde**: stojí nad lokální emisí a
 * `WorldDocRuntime`, tedy nad systémem, který na `/classic` zůstal celý.
 */
function WorldFacts({ world }: { readonly world: ProxyWorld | null }) {
  if (world === null || world.kind !== 'built') return null;

  return (
    <section data-testid="world-facts" style={FACTS}>
      <h2 style={FACTS_TITLE}>{world.title}</h2>
      <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {world.slots.map(({ slot, form }) => (
          <li key={slot.stableId} data-testid="world-facts-slot" data-rung={form.rung}>
            <strong>{slot.label}</strong> — {PROXY_RUNG_LABELS[form.rung]}
            {form.kind === 'clay' ? `: ${form.reason}` : ''}
          </li>
        ))}
      </ol>
    </section>
  );
}

const FACTS: React.CSSProperties = {
  pointerEvents: 'auto',
  maxWidth: '26rem',
  padding: '0.6rem 0.75rem',
  borderRadius: 6,
  background: 'rgba(11, 18, 20, 0.82)',
  color: '#cfe3e6',
  font: '12px/1.5 ui-monospace, monospace',
};

const FACTS_TITLE: React.CSSProperties = {
  margin: '0 0 0.4rem',
  font: 'inherit',
  color: '#7fd4c1',
};

const FORM: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  pointerEvents: 'auto',
};

const INPUT: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '0.55rem 0.75rem',
  border: '1px solid #2c4147',
  borderRadius: 4,
  background: 'rgba(11, 18, 20, 0.86)',
  color: '#cfe3e6',
  font: '14px/1.4 ui-monospace, monospace',
};

const BUTTON: React.CSSProperties = {
  padding: '0.55rem 1rem',
  border: '1px solid #2c4147',
  borderRadius: 4,
  background: '#132022',
  color: '#cfe3e6',
  cursor: 'pointer',
  font: '14px/1.4 ui-monospace, monospace',
};
