import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { Button, Chip, holdSheet, IconButton, Sheet } from '..';
import { ICON_NAMES } from '../icons';

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
  it('draws the button with the kit classes and marks the variant so a card can count its primary actions', () => {
    const large = renderToStaticMarkup(createElement(Button, { variant: 'sun', size: 'l' }, 'Play it'));
    expect(large).toContain('class="sp-btn sp-btn--sun play-button"');
    expect(large).toContain('data-variant="sun"');
    expect(large).toContain('type="button"');
    const plain = renderToStaticMarkup(createElement(Button, null, 'Go'));
    expect(plain).toContain('class="sp-btn sp-btn--primary sp-btn--m play-button"');
    expect(plain).toContain('data-variant="primary"');
    expect(renderToStaticMarkup(createElement(Button, { variant: 'link', size: 's', className: 'x' }, 'Copy link'))).toContain('class="sp-btn sp-btn--link sp-btn--s play-button x"');
  });

  it('draws the icon button as a labelled kit disc with a sprite icon and an optional caption', () => {
    const html = renderToStaticMarkup(createElement(IconButton, { 'aria-label': 'Sound off', icon: 'sound-on', caption: 'Sound' }));
    expect(html).toContain('aria-label="Sound off"');
    expect(html).toContain('<span class="sp-btn sp-btn--icon play-icon-button-disc">');
    expect(html).toContain('<use href="/brand/icons/sprite.svg#sp-sound-on">');
    expect(html).toContain('>Sound</span>');
    // @ts-expect-error – an icon button without a label is a button nobody can name.
    expect(renderToStaticMarkup(createElement(IconButton, { icon: 'close' }))).toContain('<button');
  });

  it('names only icons the kit sprite has', () => {
    const sprite = readFileSync(join(process.cwd(), 'public/brand/icons/sprite.svg'), 'utf-8');
    const symbols = [...sprite.matchAll(/<symbol id="sp-([a-z0-9-]+)"/g)].map((m) => m[1]).sort();
    expect([...ICON_NAMES].sort()).toEqual(symbols);
  });

  it('renders a chip as a kit chip button', () => {
    expect(renderToStaticMarkup(createElement(Chip, null, 'Make it harder'))).toMatch(/^<button type="button" class="sp-chip play-chip"/);
  });

  it('renders the sheet only while open, as a labelled kit sheet over a scrim', () => {
    expect(renderToStaticMarkup(createElement(Sheet, { open: false, title: 'Change it', onClose: () => undefined, children: 'body' }))).toBe('');
    const html = renderToStaticMarkup(createElement(Sheet, { open: true, title: 'Change it', onClose: () => undefined, children: 'body' }));
    expect(html).toContain('class="sp-scrim');
    expect(html).toContain('class="sp-sheet play-sheet"');
    expect(html).toContain('class="sp-sheet__handle"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Change it"');
    expect(html).toContain('data-sheet-drag');
    expect(html).toContain('aria-label="Close"');
  });
});
