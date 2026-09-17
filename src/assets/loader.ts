import { Box3, Group, LoadingManager, Mesh, DoubleSide, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { disposeSubtree } from '@/components/viewer/dispose';
import type { AssetManifest } from './manifest';
import type { AssetRecord } from './schema';

export interface AssetLimits { bytes: number; triangles: number; geometryBytes: number; textureBytes: number; nodes: number }
export const DEFAULT_ASSET_LIMITS: AssetLimits = { bytes: 16 * 1024 ** 2, triangles: 100_000,
  geometryBytes: 32 * 1024 ** 2, textureBytes: 64 * 1024 ** 2, nodes: 2048 };
export interface LoadedAsset { object: Group; triangles: number; hash: string; geometryBytes: number; textureBytes: number; mutableNodes?: readonly string[] }
export type AssetLoadPhase = 'download' | 'hash' | 'preflight' | 'decode' | 'validation';
export interface AssetLoadTiming {
  readonly sequence:number; readonly assetId:string; readonly hash:string; readonly level:number; readonly path:string;
  readonly bytes:number; readonly startedAt:number; readonly totalMs:number; readonly status:'loaded'|'failed';
  readonly phase:AssetLoadPhase; readonly phases:Readonly<Record<AssetLoadPhase,number|null>>; readonly error?:string;
}
export interface AssetLoader { load(reference: unknown, level?: number): Promise<LoadedAsset>;
  /** At most 64 completed loads per loader. Cache hits do not fabricate decode samples. */
  timings?(): readonly AssetLoadTiming[];
  estimate?(reference: unknown, level?: number): Pick<LoadedAsset, 'triangles' | 'geometryBytes' | 'textureBytes'> }
type Json = Record<string, any>;
function requireCondition(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

async function readBytes(response: Response, expected: number): Promise<ArrayBuffer> {
  requireCondition(response.ok && !response.redirected, 'Asset fetch failed or redirected');
  const advertised = response.headers.get('content-length');
  requireCondition(advertised === null || Number(advertised) <= expected, 'Asset byte budget exceeded');
  requireCondition(response.body, 'Asset response has no body');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.byteLength;
      requireCondition(size <= expected, 'Asset byte budget exceeded'); chunks.push(result.value);
    }
    requireCondition(size === expected, 'Asset byte count differs from manifest');
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}

/** Narrow import profile: core glTF static triangle meshes, embedded PNG, no extensions.
 * All allocation-driving counts are checked before GLTFLoader sees the document. */
function preflight(buffer: ArrayBuffer, asset: AssetRecord, level: number, limits: AssetLimits) {
  const view = new DataView(buffer);
  requireCondition(buffer.byteLength >= 28 && view.getUint32(0, true) === 0x46546c67
    && view.getUint32(4, true) === 2 && view.getUint32(8, true) === buffer.byteLength, 'Invalid GLB header');
  let json: Json | undefined; let bin: Uint8Array | undefined; let offset = 12;
  while (offset < buffer.byteLength) {
    requireCondition(offset + 8 <= buffer.byteLength, 'Truncated GLB chunk');
    const size = view.getUint32(offset, true), kind = view.getUint32(offset + 4, true); offset += 8;
    requireCondition(size % 4 === 0 && offset + size <= buffer.byteLength, 'Invalid GLB chunk length');
    if (kind === 0x4e4f534a) {
      requireCondition(!json && offset === 20, 'Invalid JSON chunk');
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset, size)));
    } else { requireCondition(kind === 0x004e4942 && !bin && json, 'Unsupported GLB chunk'); bin = new Uint8Array(buffer, offset, size); }
    offset += size;
  }
  requireCondition(json && bin && json.asset?.version === '2.0', 'GLB requires JSON and embedded binary');
  const doc = json;
  const inspect = (value: any, depth = 0): void => {
    requireCondition(depth < 64, 'GLB nesting budget exceeded');
    if (!value || typeof value !== 'object') return;
    requireCondition(!('uri' in value) && !('extensions' in value), 'External resources and extensions are unsupported');
    for (const child of Object.values(value)) inspect(child, depth + 1);
  }; inspect(doc);
  requireCondition(!(doc.extensionsUsed?.length || doc.extensionsRequired?.length || doc.animations?.length || doc.skins?.length), 'Unsupported GLB feature');
  requireCondition(doc.buffers?.length === 1 && integer(doc.buffers[0].byteLength)
    && doc.buffers[0].byteLength <= bin.byteLength && bin.byteLength - doc.buffers[0].byteLength <= 3, 'Invalid binary buffer');
  const views: Json[] = doc.bufferViews ?? [], accessors: Json[] = doc.accessors ?? [];
  requireCondition(views.length <= limits.nodes * 8 && accessors.length <= limits.nodes * 8, 'GLB structure budget exceeded');
  for (const v of views) requireCondition(v.buffer === 0 && integer(v.byteOffset ?? 0) && integer(v.byteLength)
    && (v.byteOffset ?? 0) + v.byteLength <= doc.buffers[0].byteLength
    && (v.byteStride === undefined || (integer(v.byteStride) && v.byteStride > 0 && v.byteStride <= 252)), 'Invalid buffer view');
  let geometryBytes = 0;
  for (const a of accessors) {
    const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[a.type];
    const width = ({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[a.componentType];
    const v = views[a.bufferView];
    requireCondition(v && !a.sparse && integer(a.count) && a.count > 0 && components && width && integer(a.byteOffset ?? 0), 'Unsupported accessor');
    const stride = v.byteStride ?? components * width;
    requireCondition(stride === components * width && ((v.byteOffset ?? 0) + (a.byteOffset ?? 0)) % width === 0
      && (a.byteOffset ?? 0) + (a.count - 1) * stride + components * width <= v.byteLength, 'Accessor exceeds buffer view');
    geometryBytes += a.count * components * width;
    requireCondition(geometryBytes <= limits.geometryBytes, 'Decoded geometry budget exceeded');
  }
  let textureBytes = 0;
  for (const image of doc.images ?? []) {
    const v = views[image.bufferView]; requireCondition(image.mimeType === 'image/png' && v && v.byteLength >= 33, 'Only embedded PNG images are supported');
    const imageView = new DataView(bin.buffer, bin.byteOffset + (v.byteOffset ?? 0), v.byteLength);
    requireCondition(imageView.getUint32(0) === 0x89504e47 && imageView.getUint32(4) === 0x0d0a1a0a
      && imageView.getUint32(8) === 13 && imageView.getUint32(12) === 0x49484452
      && imageView.getUint8(24) === 8 && [2, 6].includes(imageView.getUint8(25)), 'Only 8-bit RGB/RGBA PNG images are supported');
    const w = imageView.getUint32(16), h = imageView.getUint32(20);
    requireCondition(w > 0 && h > 0 && w <= 8192 && h <= 8192, 'Decoded texture dimensions exceeded');
    textureBytes += Math.ceil(w * h * 4 * 4 / 3);
    requireCondition(textureBytes <= limits.textureBytes, 'Decoded texture budget exceeded');
  }
  requireCondition((doc.textures?.length ?? 0) <= (doc.images?.length ?? 0), 'Duplicated texture allocations unsupported');
  const textureSources = new Set<number>();
  for (const texture of doc.textures ?? []) {
    requireCondition(integer(texture.source) && doc.images?.[texture.source] && !textureSources.has(texture.source), 'Invalid or duplicated texture source');
    textureSources.add(texture.source);
  }
  const nodes: Json[] = doc.nodes ?? [], meshes: Json[] = doc.meshes ?? [];
  requireCondition(nodes.length <= limits.nodes && meshes.length <= limits.nodes && doc.scenes?.length === 1
    && (doc.scene ?? 0) === 0, 'Unsupported scene structure');
  let triangles = 0; const visited = new Set<number>();
  const visit = (index: number, depth: number) => {
    requireCondition(integer(index) && nodes[index] && !visited.has(index) && depth < 64, 'Invalid node graph'); visited.add(index);
    const node = nodes[index]; requireCondition(node.skin === undefined && node.weights === undefined, 'Unsupported animated node');
    for (const key of ['matrix', 'translation', 'rotation', 'scale']) if (node[key] !== undefined)
      requireCondition(Array.isArray(node[key]) && node[key].length === (key === 'matrix' ? 16 : key === 'rotation' ? 4 : 3)
        && node[key].every((x: unknown) => typeof x === 'number' && Number.isFinite(x)), 'Invalid node transform');
    if (node.mesh !== undefined) {
      requireCondition(integer(node.mesh) && meshes[node.mesh], 'Invalid mesh');
      for (const p of meshes[node.mesh].primitives ?? []) {
        const position = accessors[p.attributes?.POSITION], indices = p.indices === undefined ? undefined : accessors[p.indices];
        requireCondition((p.mode ?? 4) === 4 && !p.targets && position?.type === 'VEC3' && position.componentType === 5126
          && doc.materials?.[p.material], 'Unsupported mesh primitive');
        for (const index of Object.values(p.attributes ?? {})) requireCondition(integer(index) && accessors[index] && accessors[index].count === position.count, 'Invalid mesh attribute');
        requireCondition(p.indices === undefined || (indices?.type === 'SCALAR' && [5121, 5123, 5125].includes(indices.componentType)), 'Invalid indices');
        const positionView = views[position.bufferView];
        const positions = new DataView(bin!.buffer, bin!.byteOffset + (positionView.byteOffset ?? 0) + (position.byteOffset ?? 0), position.count * 12);
        for (let i = 0; i < position.count * 3; i++) requireCondition(Number.isFinite(positions.getFloat32(i * 4, true)), 'Nonfinite vertex position');
        if (indices) {
          const iv = views[indices.bufferView], width = indices.componentType === 5121 ? 1 : indices.componentType === 5123 ? 2 : 4;
          const values = new DataView(bin!.buffer, bin!.byteOffset + (iv.byteOffset ?? 0) + (indices.byteOffset ?? 0), indices.count * width);
          for (let i = 0; i < indices.count; i++) {
            const value = width === 1 ? values.getUint8(i) : width === 2 ? values.getUint16(i * width, true) : values.getUint32(i * width, true);
            requireCondition(value < position.count, 'Index exceeds vertex count');
          }
        }
        const count = indices?.count ?? position.count; requireCondition(count % 3 === 0, 'Invalid triangle count'); triangles += count / 3;
        requireCondition(triangles <= limits.triangles, 'Triangle budget exceeded');
      }
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  for (const node of doc.scenes[0].nodes ?? []) visit(node, 0);
  requireCondition(visited.size === nodes.length, 'Unreachable nodes unsupported');
  const lod = asset.lods.find((l) => l.level === level)!;
  requireCondition(triangles <= lod.triangles && geometryBytes <= lod.decodedGeometryBytes && textureBytes <= lod.decodedTextureBytes, 'Decoded model exceeds manifest budget');
  requireCondition(doc.materials?.length === asset.materials.length && asset.materials.every((m, i) => {
    const actual = doc.materials[i]; return actual.name === m.name && (actual.alphaMode ?? 'OPAQUE') === m.alphaMode && !!actual.doubleSided === m.doubleSided;
  }), 'Material metadata differs from manifest');
  for (const part of asset.parts) requireCondition(nodes.filter((n) => n.name === part.node).length === 1, 'Missing or ambiguous part node');
  return { triangles, geometryBytes, textureBytes };
}

export function createAssetLoader(manifest: AssetManifest, options: { fetch?: typeof fetch;
  parse?: (buffer: ArrayBuffer) => Promise<Group>; limits?: Partial<AssetLimits>; now?:()=>number } = {}): AssetLoader {
  const limits = { ...DEFAULT_ASSET_LIMITS, ...options.limits };
  const now=options.now??(()=>performance.now()),history:AssetLoadTiming[]=[];let sequence=0;
  const parse = options.parse ?? (async (buffer) => {
    const manager = new LoadingManager(); manager.setURLModifier((url) => { requireCondition(url.startsWith('blob:'), 'External resource blocked'); return url; });
    return (await new GLTFLoader(manager).parseAsync(buffer, '')).scene;
  });
  return { timings:()=>history.map(sample=>({...sample,phases:{...sample.phases}})),estimate(reference, level = 0) {
    const resolved = manifest.resolve(reference); requireCondition(resolved.ok, resolved.ok ? '' : resolved.reason);
    const lod = resolved.asset.lods.find((l) => l.level === level); requireCondition(lod, 'Missing LOD');
    return { triangles: lod.triangles, geometryBytes: lod.decodedGeometryBytes, textureBytes: lod.decodedTextureBytes };
  }, async load(reference, level = 0) {
    const resolved = manifest.resolve(reference); requireCondition(resolved.ok, resolved.ok ? '' : resolved.reason);
    const asset = resolved.asset, lod = asset.lods.find((l) => l.level === level);
    requireCondition(lod && lod.bytes <= limits.bytes && lod.triangles <= limits.triangles
      && lod.decodedGeometryBytes <= limits.geometryBytes && lod.decodedTextureBytes <= limits.textureBytes, 'Missing LOD or declared budget exceeded');
    const startedAt=now(),id=++sequence,phases:Record<AssetLoadPhase,number|null>={download:null,hash:null,preflight:null,decode:null,validation:null};
    let phase:AssetLoadPhase='download',phaseAt=startedAt,status:'loaded'|'failed'='failed',errorText:string|undefined;
    const next=(value:AssetLoadPhase)=>{const at=now();phases[phase]=Math.max(0,at-phaseAt);phase=value;phaseAt=at;};
    try {
    const buffer = await readBytes(await (options.fetch ?? fetch)(lod.path, {
      redirect: 'error', credentials: 'same-origin', signal: AbortSignal.timeout(15_000),
    }), lod.bytes);
    next('hash');
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    requireCondition(hash === lod.hash, 'Asset content hash mismatch');
    next('preflight');
    const counts = preflight(buffer, asset, level, limits);
    next('decode');
    const object = await parse(buffer);
    next('validation');
    try {
      object.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(object, true);
      const actual = [...bounds.min.toArray(), ...bounds.max.toArray()], expected = [...asset.bounds.min, ...asset.bounds.max];
      requireCondition(actual.every((n, i) => Number.isFinite(n) && (i < 3 ? n >= expected[i] - 0.001 : n <= expected[i] + 0.001))
        && [0, 1, 2].every((i) => actual[i + 3] - actual[i] >= 0.9 * (expected[i + 3] - expected[i])), 'Decoded bounds differ from manifest');
      let actualTriangles = 0;
      object.traverse((node) => { if (!(node instanceof Mesh)) return;
        const g = node.geometry; actualTriangles += (g.index?.count ?? g.attributes.position.count) / 3;
        for (const m of Array.isArray(node.material) ? node.material : [node.material])
          requireCondition(asset.materials.some((declared) => m.name === declared.name && (m.side === DoubleSide) === declared.doubleSided
            && (m.transparent ? 'BLEND' : m.alphaTest > 0 ? 'MASK' : 'OPAQUE') === declared.alphaMode), 'Decoded material differs from manifest');
      });
      requireCondition(actualTriangles === counts.triangles, 'Decoded triangle count mismatch');
      for (const part of asset.parts) {
        const node = object.getObjectByName(part.node);
        requireCondition(node && node.getWorldPosition(new Vector3()).toArray().every((n, i) => Math.abs(n - part.pivot[i]) <= 0.001), 'Decoded part pivot differs from manifest');
      }
      status='loaded';return { object, hash, ...counts, mutableNodes: asset.parts.map(part => part.node) };
    } catch (error) { disposeSubtree(object); throw error; }
    } catch(error) {errorText=(error instanceof Error?error.message:String(error)).slice(0,160);throw error;}
    finally {
      const end=now();phases[phase]=Math.max(0,end-phaseAt);
      history.push({sequence:id,assetId:asset.assetId,hash:lod.hash,level,path:lod.path,bytes:lod.bytes,startedAt,
        totalMs:Math.max(0,end-startedAt),status,phase,phases,...(errorText?{error:errorText}:{})});
      if(history.length>64)history.shift();
    }
  } };
}
