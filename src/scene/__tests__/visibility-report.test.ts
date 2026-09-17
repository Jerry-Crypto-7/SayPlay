import { expect, it } from 'vitest';
import { visibilityReport } from '../visibility-report';
import type { SceneSpec } from '../spec';

it('separates a missing requirement, an off-camera object and an unrecognizable object', () => {
  const spec = {instances:[{stableId:'chair'},{stableId:'person'}],requirements:[
    {description:'chair',polarity:'required',instanceIds:['chair']},
    {description:'person',polarity:'required',instanceIds:['person']},
  ]} as SceneSpec;
  const report = visibilityReport(spec,[
    {stableId:'chair',built:true,loaded:true,inFrame:false,screenPixels:0,unoccludedSamples:0,samples:5},
    {stableId:'person',built:true,loaded:true,inFrame:true,screenPixels:100,unoccludedSamples:5,samples:5},
  ],[{description:'aquarium from original brief',instanceIds:['aquarium']}],{person:false});
  expect(report.map(r=>r.instances[0].status)).toEqual(['loaded','visible','absent']);
  expect(report[1].instances[0].recognition).toBe(false);
  expect(report.every(r=>r.instances[0].repair)).toBe(true);
});

it('five chairs do not satisfy five missing people and tiny pixels are not visible evidence', () => {
  const people=Array.from({length:5},(_,i)=>`person${i}`);
  const chairs=Array.from({length:5},(_,i)=>`chair${i}`);
  const spec={instances:[...people,...chairs].map(stableId=>({stableId})),requirements:[
    {description:'five people',polarity:'required',instanceIds:people},
    {description:'five chairs',polarity:'required',instanceIds:chairs},
  ]} as SceneSpec;
  const observations=chairs.map(stableId=>({stableId,built:true,loaded:true,inFrame:true,screenPixels:10,unoccludedSamples:5,samples:5}));
  const report=visibilityReport(spec,observations);
  expect(report[0].instances.map(i=>i.status)).toEqual(Array(5).fill('planned'));
  expect(report[1].instances.map(i=>i.status)).toEqual(Array(5).fill('loaded'));
  expect(report.flatMap(r=>r.instances).every(i=>i.recognition==='unreviewed')).toBe(true);
});
