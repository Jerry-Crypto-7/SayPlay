'use client';

/**
 * Panel překladu — **co model doopravdy napsal** (P11 T14).
 *
 * Vedle světa běží čitelně jeho zdroj: tvar stavby, pravidla v pořadí, ve kterém
 * je interpret vykoná, a cíl. Není to log a není to výpis JSONu — porotce má za
 * dvě sekundy poznat, jestli ten svět dělá to, co si přál, a nastrouhaný
 * dokument tuhle otázku nezodpoví.
 *
 * **Druhá věta ukáže rozdíl, ne nový výpis.** Celý smysl živé editace je, že se
 * dá vidět, co se změnilo; panel, který po každé větě překreslí totéž jinými
 * slovy, tu informaci zahodí. Řádky se proto porovnávají přes stabilní `id`
 * (`./describe`) a označí se jako přidané, změněné nebo zmizelé.
 *
 * **Panel jde sbalit.** Na demu se přepíná mezi „ukaž mi ten svět" a „ukaž mi,
 * z čeho vznikl", a stav sbalení je proto součást produktu, ne kosmetika.
 */

import { useMemo, useState } from 'react';

import {
  describeEmission,
  diffPrograms,
  SECTIONS,
  SECTION_TITLES,
  type Change,
  type DiffLine,
  type ProgramLine,
  type SectionId,
} from './describe';

/** Značka před řádkem. Barva sama o sobě nestačí — nese ji i znak. */
const MARKERS: Readonly<Record<Change, string>> = {
  same: ' ',
  added: '+',
  changed: '~',
  removed: '−',
};

const CHANGE_LABELS: Readonly<Record<Change, string>> = {
  same: 'unchanged',
  added: 'added',
  changed: 'changed',
  removed: 'gone',
};

export default function Program({
  emission,
  previous = null,
}: {
  /** Emise, kterou model právě napsal. `null` = ještě žádná věta nepadla. */
  readonly emission: unknown;
  /** Emise předchozí věty. `null` u první — první svět není samá novinka. */
  readonly previous?: unknown;
}) {
  const [open, setOpen] = useState(true);

  const lines: readonly DiffLine[] = useMemo(() => {
    if (emission === null || emission === undefined) return [];
    const before: readonly ProgramLine[] | null =
      previous === null || previous === undefined ? null : describeEmission(previous);
    return diffPrograms(before, describeEmission(emission));
  }, [emission, previous]);

  if (lines.length === 0) return null;

  const changes = lines.filter((entry) => entry.change !== 'same').length;

  return (
    <section data-testid="pipeline-panel" data-open={open ? 'true' : 'false'} style={PANEL}>
      <button
        type="button"
        data-testid="pipeline-toggle"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        style={TOGGLE}
      >
        <span>What the model wrote</span>
        <span style={BADGE}>
          {changes === 0 ? (open ? 'hide' : 'show') : `${String(changes)} changed`}
          {open ? ' ▾' : ' ▸'}
        </span>
      </button>

      {open ? (
        <div data-testid="pipeline-body" style={BODY}>
          {SECTIONS.map((section) => (
            <Section key={section} section={section} lines={lines.filter((entry) => entry.line.section === section)} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Section({ section, lines }: { readonly section: SectionId; readonly lines: readonly DiffLine[] }) {
  if (lines.length === 0) return null;

  return (
    <div data-testid={`pipeline-section-${section}`} style={SECTION}>
      <h2 style={HEADING}>{SECTION_TITLES[section]}</h2>
      <ul style={LIST}>
        {lines.map((entry) => (
          <li
            key={entry.line.id}
            data-testid="pipeline-line"
            data-line-id={entry.line.id}
            data-change={entry.change}
            title={CHANGE_LABELS[entry.change]}
            style={{ ...LINE, ...LINE_BY_CHANGE[entry.change] }}
          >
            <span aria-hidden="true" style={MARKER}>
              {MARKERS[entry.change]}
            </span>
            {entry.line.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

const PANEL: React.CSSProperties = {
  // Ukotvení nese sloupec v `src/app/page.tsx`, ne panel sám. Dokud si ho panel
  // kotvil sám, stál na témž `bottom: 1rem; left: 1rem; zIndex: 2` jako časová
  // osa — a po sbalení se schoval pod ni tak, že už nešel rozbalit.
  pointerEvents: 'auto',
  width: 'min(24rem, calc(100vw - 2rem))',
  maxHeight: '62dvh',
  // Squeeze celého sloupce padá sem, protože tělo panelu roluje. Bez `minHeight`
  // to ale nejde: položka flexboxu má `min-height: auto`, tedy se nesmršťuje pod
  // výšku svého obsahu, a přebytek pak sloupci vyteče **pod spodní okraj okna**.
  // Naměřeno na 1280×720 po přidání třetího panelu: `elementFromPoint` ve středu
  // `game-restart` i `timeline-branch` vracel `null` — tlačítka byla mimo obraz.
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  borderRadius: '0.6rem',
  background: 'rgba(12, 22, 26, 0.9)',
  border: '1px solid #24383d',
  color: '#dceaec',
  fontSize: '0.82rem',
};

const TOGGLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '0.6rem 0.75rem',
  border: 'none',
  borderRadius: '0.6rem',
  background: 'transparent',
  color: '#dceaec',
  font: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
  textAlign: 'left',
};

const BADGE: React.CSSProperties = {
  color: '#9fc0c2',
  fontWeight: 400,
  whiteSpace: 'nowrap',
};

const BODY: React.CSSProperties = {
  overflowY: 'auto',
  padding: '0 0.75rem 0.75rem',
};

const SECTION: React.CSSProperties = {
  marginTop: '0.5rem',
};

const HEADING: React.CSSProperties = {
  margin: '0 0 0.3rem',
  fontSize: '0.72rem',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#7fa3a6',
};

const LIST: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.2rem',
};

const LINE: React.CSSProperties = {
  display: 'flex',
  gap: '0.4rem',
  lineHeight: 1.45,
};

const MARKER: React.CSSProperties = {
  width: '0.7rem',
  flexShrink: 0,
  fontWeight: 700,
};

const LINE_BY_CHANGE: Readonly<Record<Change, React.CSSProperties>> = {
  same: {},
  added: { color: '#5fd3bd' },
  changed: { color: '#e8a33d' },
  removed: { color: '#7a8f92', textDecoration: 'line-through' },
};
