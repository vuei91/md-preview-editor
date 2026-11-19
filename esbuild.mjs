import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

// 확장 호스트(Node) 코드
const extensionCtx = await esbuild.context({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
});

// Webview(브라우저) 코드
const webviewCtx = await esbuild.context({
  ...common,
  entryPoints: {
    editor: 'src/webview/editor.ts',
    diff: 'src/webview/diff.ts',
  },
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
});

// 스타일시트 복사
mkdirSync('dist/webview', { recursive: true });
copyFileSync('node_modules/@toast-ui/editor/dist/toastui-editor.css', 'dist/webview/toastui-editor.css');
copyFileSync('node_modules/@toast-ui/editor/dist/theme/toastui-editor-dark.css', 'dist/webview/toastui-editor-dark.css');
copyFileSync('src/webview/editor.css', 'dist/webview/editor.css');
copyFileSync('src/webview/diff.css', 'dist/webview/diff.css');
copyFileSync('src/webview/search.css', 'dist/webview/search.css');

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
}
