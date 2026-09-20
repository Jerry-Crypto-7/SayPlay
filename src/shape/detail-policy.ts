import {childIndicesOf,type ShapeProgram} from './types';
import {paddedBounds} from './surface-nets';

export interface ShapeDetailAssessment {
  readonly status:'sampling-risk'|'no-explicit-risk'|'unassessed';
  readonly resolution:number;
  readonly maxVoxelMeters:number;
  readonly minimumCells:number;
  readonly features:readonly {node:number;feature:string;meters:number;cells:number}[];
  readonly limitations:readonly string[];
  readonly recommendation:string|null;
}
/** Three cells is a conservative diagnostic heuristic, never a topology/recognition proof.
 * Traverses the validated DAG once; arrays do not expand. No grid or cache mutation. */
export function assessShapeDetail(program:ShapeProgram,resolution:number):ShapeDetailAssessment {
  if(!Number.isInteger(resolution)||resolution<1)throw new Error('Detail assessment requires positive integer resolution');
  const bounds=paddedBounds(program.targetBounds,resolution);
  const maxVoxelMeters=Math.max(...bounds.max.map((max,axis)=>(max-bounds.min[axis])/resolution));
  const scales=new Map<number,number>([[program.root,1]]),features:{node:number;feature:string;meters:number;cells:number}[]=[],limitations=new Set<string>();
  let repeated=false;
  for(let index=program.nodes.length-1;index>=0;index--) {
    const scale=scales.get(index);if(scale===undefined)continue;
    const node=program.nodes[index];
    const add=(feature:string,meters:number)=>{if(meters>0)features.push({node:index,feature,meters:meters*scale,cells:meters*scale/maxVoxelMeters});};
    switch(node.kind) {
      case 'sphere':case 'capsule':add('diameter',node.radius*2);break;
      case 'box':add('thickness',Math.min(...node.size));break;
      case 'roundBox':add('thickness',Math.min(...node.size)+2*node.radius);add('rounding radius',node.radius);break;
      case 'cylinder':case 'cone':add('diameter/height',Math.min(node.radius*2,node.height));if(node.kind==='cone')limitations.add('Cone tip narrows below the base feature size.');break;
      case 'torus':add('tube diameter',2*node.minorRadius);break;
      case 'prism':add('inscribed width/height',Math.min(2*node.radius*Math.cos(Math.PI/node.sides),node.height));break;
      case 'ellipsoid':add('minor diameter',2*Math.min(...node.radii));break;
      case 'union':case 'subtract':case 'intersect':
        if(node.k)add('blend width',node.k);
        if(node.kind!=='union')limitations.add('CSG can create thinner walls or gaps than its input primitives.');break;
      case 'twist':case 'bend':case 'taper':case 'displace':case 'revolve':
        limitations.add(`${node.kind} deformation has no certified minimum feature bound.`);break;
      case 'clip':limitations.add('Clipping may create arbitrarily thin remnants.');break;
      case 'repeat':case 'radialArray':case 'arrayAlongCurve':repeated=true;break;
      case 'plane':limitations.add('A half-space has no finite explicit thickness.');break;
    }
    const childScale=scale*(node.kind==='scale'?Math.min(...node.factor.map(Math.abs)):1);
    for(const child of childIndicesOf(node))scales.set(child,Math.min(scales.get(child)??Infinity,childScale));
  }
  features.sort((a,b)=>a.cells-b.cells||a.node-b.node||a.feature.localeCompare(b.feature,'en'));
  const risks=features.filter(feature=>feature.cells<3);
  const status=risks.length?'sampling-risk':limitations.size||!features.length?'unassessed':'no-explicit-risk';
  const recommendation=risks.length?`Node ${risks[0].node} ${risks[0].feature} spans ${risks[0].cells.toFixed(2)} cells at grid ${resolution}. ${repeated?'Mesh one repeated unit and instance it, or split the shape into smaller bounds.':'Split small features into separately meshed parts with tighter bounds.'} Consider catalog GLB or parametric geometry; raising the global grid is not an automatic repair.`
    :status==='unassessed'?'Inspect the rendered result; deformation/CSG feature thickness is not established by primitive dimensions.':null;
  return {status,resolution,maxVoxelMeters,minimumCells:3,features,limitations:[...limitations],recommendation};
}
