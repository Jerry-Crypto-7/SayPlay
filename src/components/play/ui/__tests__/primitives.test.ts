import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { Button, Chip, holdSheet, IconButton, Sheet } from '..';

/**
 * Sdílené prvky P33 (T3). List, který nevrátí fokus nebo nejde zavřít
 * klávesou, vypadá na snímku správně a rozbije ovládání z klávesnice – proto
 * se chování listu (`holdSheet`) zkouší na událostech, ne od oka.
 *
 * Sada nemá DOM (vitest běží v node), takže dokument a panel jsou
 * `EventTarget` s tím nejmenším, co `holdSheet` čte.
 */

class FakeNode extends EventTarget {
  focused = 0;
  constructor(
    private readonly doc: FakeDocument,
    readonly children: FakeNode[] = [],
    readonly drag = false,
  ) {
    super();
  }
  focus(): void {
    this.focused += 1;
    this.doc.activeElement = this;
  }
  contains(node: unknown): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }
  closest(selector: string): FakeNode | null {
    return selector === '[data-sheet-drag]' && this.drag ? this : null;
  }
  /** Úchyt tahu je `div`, ne ovládací prvek – fokus na něj nejde. */
  querySelectorAll(): FakeNode[] {
    return this.children.flatMap((child) => (child.drag ? child.querySelectorAll() : [child, ...child.querySelectorAll()]));
  }
  get isConnected(): boolean {
    return true;
  }
}

class FakeDocument extends EventTarget {
  activeElement: FakeNode | null = null;
}

/** Událost s cílem, který si test určí – `dispatchEvent` na dokumentu by jinak za cíl dal dokument. */
class At extends Event {
  constructor(
    type: string,
    private readonly at: unknown,
    extra: Record<string, unknown> = {},
  ) {
    super(type);
    Object.assign(this, extra);
  }
  override get target(): EventTarget | null {
    return this.at as EventTarget;
  }
}

function setup() {
  const doc = new FakeDocument();
  const trigger = new FakeNode(doc);
  const handle = new FakeNode(doc, [], true);
  const first = new FakeNode(doc);
  const last = new FakeNode(doc);
  const panel = new FakeNode(doc, [handle, first, last]);
  trigger.focus();
  const onClose = vi.fn();
  const release = holdSheet(doc as unknown as Document, panel as unknown as HTMLElement, onClose);
  return { doc, trigger, handle, first, last, panel, onClose, release };
}

describe('holdSheet', () => {
  it('moves focus into the sheet and hands it back to the trigger on release', () => {
    const { doc, trigger, panel, release } = setup();
    expect(panel.contains(doc.activeElement)).toBe(true);
    release();
    expect(doc.activeElement).toBe(trigger);
  });

  it('closes on Escape', () => {
    const { doc, onClose } = setup();
    doc.dispatchEvent(new At('keydown', doc, { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a tap outside the sheet, not inside it', () => {
    const { doc, first, onClose } = setup();
    doc.dispatchEvent(new At('pointerdown', first, { clientY: 300 }));
    expect(onClose).not.toHaveBeenCalled();
    doc.dispatchEvent(new At('pointerdown', doc, { clientY: 300 }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the handle is dragged down, not on a short drag', () => {
    const { doc, handle, onClose } = setup();
    doc.dispatchEvent(new At('pointerdown', handle, { clientY: 100 }));
    doc.dispatchEvent(new At('pointerup', doc, { clientY: 130 }));
    expect(onClose).not.toHaveBeenCalled();
    doc.dispatchEvent(new At('pointerdown', handle, { clientY: 100 }));
    doc.dispatchEvent(new At('pointerup', doc, { clientY: 220 }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the sheet', () => {
    const { doc, first, last } = setup();
    last.focus();
    const forward = new At('keydown', doc, { key: 'Tab', shiftKey: false });
    doc.dispatchEvent(forward);
    expect(doc.activeElement).toBe(first);
    const back = new At('keydown', doc, { key: 'Tab', shiftKey: true });
    doc.dispatchEvent(back);
    expect(doc.activeElement).toBe(last);
  });

  it('stops listening after release', () => {
    const { doc, onClose, release } = setup();
    release();
    doc.dispatchEvent(new At('keydown', doc, { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('primitives', () => {
  it('marks the button variant so a card can count its primary actions', () => {
    const html = renderToStaticMarkup(createElement(Button, { variant: 'accent', size: 'l' }, 'Play it'));
    expect(html).toContain('data-variant="accent"');
    expect(html).toContain('play-button-l');
    expect(html).toContain('type="button"');
    expect(renderToStaticMarkup(createElement(Button, null, 'Go'))).toContain('data-variant="primary"');
  });

  it('draws the icon button as a labelled 44 px disc with an optional caption', () => {
    const html = renderToStaticMarkup(createElement(IconButton, { 'aria-label': 'Sound off', icon: 'sound-on', caption: 'Sound' }));
    expect(html).toContain('aria-label="Sound off"');
    expect(html).toContain('<svg');
    expect(html).toContain('>Sound</span>');
    // @ts-expect-error – an icon button without a label is a button nobody can name.
    expect(renderToStaticMarkup(createElement(IconButton, { icon: 'close' }))).toContain('<button');
  });

  it('renders a chip as a button', () => {
    expect(renderToStaticMarkup(createElement(Chip, null, 'Make it harder'))).toMatch(/^<button type="button" class="play-chip"/);
  });

  it('renders the sheet only while open, as a labelled modal dialog', () => {
    expect(renderToStaticMarkup(createElement(Sheet, { open: false, title: 'Change it', onClose: () => undefined, children: 'body' }))).toBe('');
    const html = renderToStaticMarkup(createElement(Sheet, { open: true, title: 'Change it', onClose: () => undefined, children: 'body' }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Change it"');
    expect(html).toContain('data-sheet-drag');
    expect(html).toContain('aria-label="Close"');
  });
});
