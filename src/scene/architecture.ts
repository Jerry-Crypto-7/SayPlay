import { z } from 'zod';
import type { GeomNode } from '@/geom/program';

const point = z.tuple([z.number().min(-48).max(48), z.number().min(-16).max(32), z.number().min(-48).max(48)]);
export const architectureSchema = z.array(z.object({
  stableId: z.string().min(1).max(64), kind: z.enum(['room', 'corridor']),
  at: point, width: z.number().min(1).max(32), depth: z.number().min(1).max(32),
  height: z.number().min(2).max(12), thickness: z.number().min(0.08).max(0.5),
  openings: z.array(z.object({ wall: z.enum(['north', 'south', 'east', 'west']),
    offset: z.number().min(0), width: z.number().min(0.6).max(8), height: z.number().min(1.8).max(8),
  }).strict()).max(8),
}).strict()).max(8);
export type Architecture = z.infer<typeof architectureSchema>;

/** Exact continuous slabs, not scaled decorative kit pieces. Openings split walls. */
export function lowerArchitecture(input: Architecture, offset = 0) {
  const nodes: GeomNode[] = [];
  const roots = new Map<string, number>();
  const passages: { owner: string; min: number[]; max: number[] }[] = [];
  function slab(x: number, y: number, z: number, w: number, h: number, d: number) {
    const index = offset + nodes.length;
    // Vertical sweep frame uses normal=-Z, binormal=-X: profile u is depth.
    nodes.push({ kind: 'sweep', profile: [[-d/2,-w/2],[d/2,-w/2],[d/2,w/2],[-d/2,w/2]],
      path: [[x,y,z],[x,y+h,z]], segments: 2, swatch: 'shell' });
    return index;
  }
  for (const room of architectureSchema.parse(input)) {
    if (roots.has(room.stableId)) throw new Error(`Duplicate architecture ${room.stableId}`);
    const [x,y,z] = room.at, t = room.thickness;
    const children = [slab(x,y-t,z,room.width,t,room.depth)];
    for (const wall of ['north','south','east','west'] as const) {
      const horizontal = wall === 'north' || wall === 'south';
      const length = horizontal ? room.width : room.depth;
      const fixed = (wall === 'north' || wall === 'west' ? -1 : 1) * (horizontal ? room.depth : room.width)/2;
      const openings = room.openings.filter(o => o.wall === wall).sort((a,b) => a.offset-b.offset);
      let cursor = 0;
      const section = (start: number, end: number, bottom: number, height: number) => {
        if (end-start < 0.001 || height < 0.001) return;
        const center = (start+end-length)/2;
        children.push(slab(x+(horizontal?center:fixed),y+bottom,z+(horizontal?fixed:center),
          horizontal?end-start:t,height,horizontal?t:end-start));
      };
      for (const opening of openings) {
        if (opening.offset < cursor || opening.offset+opening.width > length || opening.height > room.height)
          throw new Error(`${room.stableId}: overlapping or out-of-wall opening`);
        section(cursor,opening.offset,0,room.height);
        section(opening.offset,opening.offset+opening.width,opening.height,room.height-opening.height);
        const c = (opening.offset+opening.width/2-length/2);
        const cx=x+(horizontal?c:fixed), cz=z+(horizontal?fixed:c);
        passages.push({ owner: room.stableId,
          min:[cx-(horizontal?opening.width/2:0.6),y,cz-(horizontal?0.6:opening.width/2)],
          max:[cx+(horizontal?opening.width/2:0.6),y+opening.height,cz+(horizontal?0.6:opening.width/2)] });
        cursor=opening.offset+opening.width;
      }
      section(cursor,length,0,room.height);
    }
    // The existing language limits group fanout to 16.
    while (children.length > 16) {
      const part = children.splice(0,16); const id=offset+nodes.length;
      nodes.push({kind:'group',children:part}); children.push(id);
    }
    roots.set(room.stableId,offset+nodes.length);
    nodes.push({kind:'group',children});
  }
  return { nodes, roots, passages };
}
