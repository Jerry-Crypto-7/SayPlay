import { expect, it } from 'vitest';
import { browserRenderer } from '../browser-renderer';

it('uses Direct3D for local Windows without requesting a software fallback', () => {
  expect(browserRenderer({}, 'win32')).toEqual({ mode: 'native', args: ['--use-gl=angle', '--use-angle=d3d11'] });
});
it('keeps software timing reproducible and rejects misspelled modes', () => {
  expect(browserRenderer({ E2E_RENDERER: 'software' }, 'win32').args).toContain('--use-angle=swiftshader');
  expect(() => browserRenderer({ E2E_RENDERER: 'nativ' }, 'win32')).toThrow('E2E_RENDERER');
});
it('preserves the CI default while permitting an explicit hardware runner', () => {
  expect(browserRenderer({ CI: 'true' }, 'win32').mode).toBe('software');
  expect(browserRenderer({ CI: 'true', E2E_RENDERER: 'native' }, 'win32').mode).toBe('native');
  expect(browserRenderer({}, 'linux').mode).toBe('software');
});
