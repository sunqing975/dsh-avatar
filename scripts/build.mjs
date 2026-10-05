import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

await rm('lib', { recursive: true, force: true })

// Host 半部：Node 侧 Cordis 插件（工具注册 + 模型 HTTP 服务）。
// @deepseek-ai/* 与 node 内置模块 external，运行时由 dsh 宿主提供。
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@deepseek-ai/*'],
  sourcemap: true,
  logLevel: 'info',
})

// Client 半部：浏览器 bundle。产物格式复刻 dsh 官方 client 包——
// cjs + banner/footer 包成 window.__ModuleLoader__.load({id, factory})，
// 模块表项（react 等）保持 require()，由 dsh web 的模块加载器提供；其余（three.js 等）内联。
await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  jsx: 'automatic',
  target: 'es2022',
  external: ['react', 'react-dom'],
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.MODE': '"production"',
    'import.meta.env': '{"MODE":"production"}',
  },
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "dsh-avatar", factory: (require) => {\nconsole.log("[dsh-avatar] script executed");\nvar module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
  sourcemap: true,
  logLevel: 'info',
})

console.log('built lib/index.js (host) + lib/client.js (browser)')
