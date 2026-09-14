/** Shared by local tests and interactive launchers. Historical timing runs can
 * explicitly retain software rendering; native mode never requests SwiftShader. */
export function browserRenderer(env: Record<string, string | undefined> = process.env, platform = process.platform) {
  const mode = env.E2E_RENDERER ?? (platform === 'win32' && !env.CI ? 'native' : 'software');
  if (mode !== 'native' && mode !== 'software') throw new Error('E2E_RENDERER must be native or software');
  const args = mode === 'software'
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : platform === 'win32' ? ['--use-gl=angle', '--use-angle=d3d11'] : [];
  return { mode, args };
}
