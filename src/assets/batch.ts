import { BufferGeometry, Group, Matrix4, Mesh, type Object3D, type Material } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Decode-time batching only. Semantic nodes remain as named transform groups;
 * mutable part subtrees and transparency retain their original draw ordering. */
export function batchStaticAsset(root: Group, mutableNodes: readonly string[] = [], maxMergeBytes = 32 * 1024 ** 2) {
  root.updateMatrixWorld(true);
  const mutable = new Set(mutableNodes), buckets = new Map<string, Mesh<BufferGeometry,Material>[]>();
  root.traverse(node => {
    if (!(node instanceof Mesh) || Array.isArray(node.material) || node.material.transparent || !node.visible) return;
    for (let parent: Object3D | null = node; parent && parent !== root; parent = parent.parent)
      if (mutable.has(parent.name)) return;
    // Mirroring changes winding; retain the original renderer transform.
    if (node.matrixWorld.determinant() <= 0) return;
    const geometry: BufferGeometry = node.geometry;
    const attributes = Object.entries(geometry.attributes).sort(([a],[b])=>a.localeCompare(b))
      .map(([name,a])=>`${name}:${a.itemSize}:${a.normalized}:${a.array.constructor.name}`).join('|');
    const key = `${node.material.uuid}:${Boolean(node.geometry.index)}:${attributes}:${node.castShadow}:${node.receiveShadow}`;
    const bucket = buckets.get(key) ?? []; bucket.push(node as Mesh<BufferGeometry,Material>); buckets.set(key,bucket);
  });
  const inverse = root.matrixWorld.clone().invert(), retired = new Set<BufferGeometry>();
  let removedDraws = 0, mergeBytes = 0;
  for (const nodes of buckets.values()) {
    if (nodes.length < 2) continue;
    // Reused source buffers may be small while expanded instance data is huge.
    // Bound allocation BEFORE cloning/baking rather than after the cache check.
    const bytes = nodes.reduce((sum,node)=>sum + Object.values(node.geometry.attributes).reduce((n,a)=>n+a.array.byteLength,0)
      + (node.geometry.index?.array.byteLength ?? 0),0);
    if (mergeBytes + bytes > maxMergeBytes) continue;
    mergeBytes += bytes;
    const geometries = nodes.map(node => node.geometry.clone().applyMatrix4(new Matrix4().multiplyMatrices(inverse,node.matrixWorld)));
    const geometry = mergeGeometries(geometries,false);
    for (const temporary of geometries) temporary.dispose();
    if (!geometry) continue;
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry,nodes[0].material);
    mesh.name = `batched:${nodes[0].material.name}`;
    mesh.castShadow = nodes[0].castShadow; mesh.receiveShadow = nodes[0].receiveShadow;
    for (const node of nodes) {
      const placeholder = new Group(); placeholder.copy(node,false);
      for (const child of [...node.children]) placeholder.add(child);
      node.parent!.add(placeholder); node.removeFromParent(); retired.add(node.geometry);
    }
    root.add(mesh); removedDraws += nodes.length - 1;
  }
  const retained = new Set<BufferGeometry>();
  root.traverse(node => {if(node instanceof Mesh)retained.add(node.geometry);});
  for (const geometry of retired) if (!retained.has(geometry)) geometry.dispose();
  let geometryBytes = 0;
  for (const geometry of retained) {
    for (const attribute of Object.values(geometry.attributes)) geometryBytes += attribute.array.byteLength;
    if (geometry.index) geometryBytes += geometry.index.array.byteLength;
  }
  root.updateMatrixWorld(true);
  return {removedDraws,geometryBytes};
}
