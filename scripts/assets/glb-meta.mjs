/** Metadata a validace GLB – sdílí `normalize.mjs` (modely z Three.js) i `game-models.mjs` (modely z Blenderu). */
import validator from 'gltf-validator';

const componentBytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export function metadata(bytes) {
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  return {
    json,
    triangles: json.meshes.reduce((sum, m) => sum + m.primitives.reduce((n, p) => n + json.accessors[p.indices ?? p.attributes.POSITION].count / 3, 0), 0),
    decodedGeometryBytes: json.accessors.reduce((sum, a) => sum + a.count * components[a.type] * componentBytes[a.componentType], 0),
  };
}

export async function validate(bytes, name) {
  const report = await validator.validateBytes(new Uint8Array(bytes), { uri: name, maxIssues: 100 });
  if (report.issues.numErrors || report.issues.numWarnings) throw new Error(`${name}: ${JSON.stringify(report.issues)}`);
  return { file: name, errors: report.issues.numErrors, warnings: report.issues.numWarnings };
}
