import type {PlannedObject} from '../../../src/model/worldstream-intent';
import type {WorldstreamBlueprint} from '../../../src/worldstream/schema';
import {sceneMetrics} from '../../../src/worldstream/scene-metrics';
import type {VisualObservation} from '../../../src/scene/visibility-report';

/** Offline review joins independent evidence; no render or human judgment is invented. */
export function reviewScene(input:{
  blueprint:WorldstreamBlueprint;
  planned:readonly PlannedObject[];
  provenance:{kind:'fixture'|'replay'|'live';artifact:string};
  browser?:{artifact:string;observations:readonly VisualObservation[]};
  human?:{reviewer:string;artifact:string;recognition:Readonly<Record<string,boolean>>};
}) {
  const metrics=sceneMetrics(input.blueprint,input.planned);
  const observed=new Map(input.browser?.observations.map(item=>[item.stableId,item]));
  const instances=metrics.representationEvidence.map(evidence=>{
    const observation=observed.get(evidence.stableId);
    const judgment=input.human?.recognition[evidence.stableId];
    return {...evidence,loaded:observation?.loaded??'unobserved',
      inFrame:observation?.inFrame??null,
      sampledVisible:observation?observation.loaded&&observation.inFrame&&observation.unoccludedSamples>0:null,
      screenPixels:observation?.screenPixels??null,
      recognizable:judgment??'unreviewed',
      observation:observation??null};
  });
  return {provenance:input.provenance,metrics,instances,
    evidence:{browser:input.browser?.artifact??null,human:input.human?{reviewer:input.human.reviewer,artifact:input.human.artifact}:null},
    limits:['Catalog resolution does not establish loading or rendering.',
      'Legacy piece/support/collision metrics exclude assets and do not measure camera visibility.',
      'Per-instance contact and collision counts are axis-aligned box tests: a shape or asset contributes one box, its own targetBounds.',
      'Ray samples do not establish human recognizability.'],
  };
}
