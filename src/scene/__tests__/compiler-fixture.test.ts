import {it,expect} from 'vitest';
import {compileSemanticLayoutFixture} from '@/app/dev/semantic-layout/fixture';
it('compiles the browser fixture through strict planner, architecture, facing and contact validation',()=>{
  const compiled=compileSemanticLayoutFixture();
  expect(compiled.value.objects).toHaveLength(12);
  expect(compiled.adjustments.some(a=>a.path==='objects/terminal/yaw')).toBe(true);
  expect(compiled.adjustments.filter(a=>a.reason.includes('unsupported'))).toEqual([]);
  expect(compiled.value.objects.filter(o=>o.supportSocket==='seat')).toHaveLength(3);
});
