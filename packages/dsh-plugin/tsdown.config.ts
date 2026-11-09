import { defineConfig } from 'tsdown';

/**
 * The plugin id. It is stamped into the browser bundle's module-loader handoff
 * and onto the injected style tag, so it must equal the package name.
 */
const ID = 'dsh-plugin-tiny-schedule';

/**
 * Modules the browser already owns. The client bundle must not inline them:
 * the loader answers `require(...)` from its frozen module table, and a second
 * React copy would break hooks and context across the shell boundary.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
];

/**
 * Host packages resolved from the running harness. They stay external so the
 * plugin shares the harness's singletons instead of shipping a second copy.
 */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-locale',
];

export default defineConfig([
  {
    // Host half: the cordis plugin the loader imports by package name.
    name: ID,
    entry: {
      index: 'src/index.ts',
      'migrate/cli': 'src/migrate/cli.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    external: HOST_EXTERNALS,
  },
  {
    // Browser half: the closure factory the loader materializes on demand.
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    sourcemap: true,
    external: CLIENT_EXTERNALS,
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]);
