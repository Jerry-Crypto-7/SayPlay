import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorldStatus from '../WorldStatus';

it('keeps asynchronous phase messages polite and atomic, with a separate urgent fault', () => {
  const phases = [
    { state: 'empty' as const, text: 'Describe a place' },
    { state: 'building' as const, text: 'Writing the world.' },
    { state: 'building' as const, detailPending: true, text: 'The validated scene is ready to use.' },
    { state: 'live' as const, text: 'The world is live.' },
  ];
  for (const phase of phases) {
    const element = WorldStatus({ ...phase, detail: 'Ignored outside a fault' });
    expect(element.key).toBe('progress');
    const html = renderToStaticMarkup(element);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain(phase.text);
    expect(html).not.toContain('Ignored outside a fault');
    expect(html).not.toContain('role="alert"');
  }
  const fault = WorldStatus({ state: 'broken', detail: 'Please revise the sentence.' });
  expect(fault.key).toBe('fault');
  const html = renderToStaticMarkup(fault);
  expect(html).toContain('role="alert"');
  expect(html).toContain('Please revise the sentence.');
  expect(html).not.toContain('role="status"');
});
