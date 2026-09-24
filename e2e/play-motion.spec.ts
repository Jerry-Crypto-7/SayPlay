import { expect, test } from '@playwright/test';

/**
 * Riggovaná postava v běžící hře (P26B T6): věta s rytířem projde skutečnými
 * dveřmi (návrh ze slov → běžec), scéna načte rytíře s klipy a klip hráče
 * (`data-anim-clip` na plátně) jde za tím, co tělo dělá – běh, po mezerníku
 * skok. Z obrázku se klip nepřečte, proto atribut.
 */

const SENTENCE = 'a knight running and jumping over hurdles';

test('the knight runs, then jumps when Space is pressed', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  const response = await request.post('/api/play/games', { data: { sentence: SENTENCE } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  const { url } = (await response.json()) as { url: string };

  await page.goto(url);
  const stage = page.getByTestId('arcade-stage');
  await expect(stage).toHaveAttribute('data-control', 'runner');
  // Každý klip, který plátno ohlásí, se zapíše – skok trvá zlomek sekundy a polling by ho minul.
  await page.evaluate(() => {
    const element = document.querySelector('[data-testid="arcade-stage"]') as HTMLElement;
    const seen: string[] = [];
    (window as unknown as { __animSeen: string[] }).__animSeen = seen;
    new MutationObserver(() => {
      const clip = element.dataset.animClip;
      if (clip !== undefined && seen[seen.length - 1] !== clip) seen.push(clip);
    }).observe(element, { attributes: true, attributeFilter: ['data-anim-clip'] });
  });

  await expect(stage).toHaveAttribute('data-anim-clip', 'run', { timeout: 30_000 });
  await page.keyboard.press('Space');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __animSeen: string[] }).__animSeen), { timeout: 10_000 })
    .toEqual(expect.arrayContaining(['jump']));
  const seen = await page.evaluate(() => (window as unknown as { __animSeen: string[] }).__animSeen);
  expect(seen.indexOf('jump')).toBeGreaterThan(-1);
  // Po dopadu zpátky do běhu (nebo zásah o překážku) – postava v póze skoku nezamrzne.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __animSeen: string[] }).__animSeen.slice(-1)[0]), { timeout: 10_000 }).not.toBe('jump');
  expect(errors).toEqual([]);
});
