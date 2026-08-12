/**
 * Replay musí dát **tentýž hash v Node i v prohlížeči**.
 *
 * Certifikát vydaný v Node tvrdí „tenhle svědek dojde do výhry". Hra ale běží
 * v prohlížeči, takže bez téhle kontroly je to tvrzení o jiném prostředí, než
 * ve kterém ho někdo uvidí. Stačí jiná sémantika `Math.imul`, jiné pořadí
 * vlastností nebo jiné zaokrouhlení a certifikát přestane platit tam, kde na něm
 * záleží — a nic v Node testech to neodhalí.
 *
 * Oracle je **shoda hashů dvou skutečných běhů**, ne screenshot: `TOOLING.md` §1
 * upozorňuje, že headless Chromium jede přes SwiftShader, takže se tu žádné
 * pixely neporovnávají. Porovnává se zabalený stav, který je na GPU nezávislý.
 */

import { expect, test } from '@playwright/test';

import type { TraceInput } from '../src/verify/../sim/interpreter';
import { verifyWitness, type Certificate, type VerifiableWorld } from '../src/verify/witness';

import vaultWorld from '../src/sim/__fixtures__/vault.world.json';
import unwinnableWorld from '../src/verify/__fixtures__/unwinnable.world.json';

const vault = vaultWorld as unknown as VerifiableWorld;
const unwinnable = unwinnableWorld as unknown as VerifiableWorld;

async function bridge(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith?.verify !== undefined, undefined, {
    timeout: 30_000,
  });
}

test('hash koncového stavu je v Node i v prohlížeči bitově stejný', async ({ page }) => {
  const witness = vault.trace as TraceInput[];

  const node = verifyWitness(vault, witness);
  expect(node.verdict, 'Node necertifikoval — test by pak neporovnával nic').toBe('CERTIFIED');

  await bridge(page);
  const browser = await page.evaluate(
    ([doc, trace]) => window.__worldsmith!.verify(doc as VerifiableWorld, trace as TraceInput[]),
    [vault, witness] as const,
  );

  expect(browser.verdict).toBe('CERTIFIED');
  // Celý certifikát, ne jen hash: kdyby se lišil tier, `L_witness` nebo verze
  // runtimu, byl by to týž druh rozporu a stejně by se na něj nesmělo stavět.
  expect(browser).toEqual(node);
  expect((browser as Certificate).snapshotHash).toBe((node as Certificate).snapshotHash);
});

test('prohlížeč odmítá totéž co Node, se stejným důvodem', async ({ page }) => {
  // Shoda na výhře sama nestačí: kdyby prohlížeč odmítal jinde nebo z jiného
  // důvodu, sedí jen ta jedna cesta, kterou test náhodou vybral.
  const node = verifyWitness(unwinnable, unwinnable.trace as TraceInput[]);
  expect(node.verdict).toBe('REJECTED');

  await bridge(page);
  const browser = await page.evaluate(
    ([doc, trace]) => window.__worldsmith!.verify(doc as VerifiableWorld, trace as TraceInput[]),
    [unwinnable, unwinnable.trace] as const,
  );

  expect(browser).toEqual(node);
});
