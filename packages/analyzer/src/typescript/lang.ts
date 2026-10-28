import { builtinModules } from 'node:module';

export const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts'] as const;
export const JS_EXTS = ['.js', '.jsx', '.mjs', '.cjs'] as const;
export const SOURCE_EXTS: readonly string[] = [...TS_EXTS, ...JS_EXTS];

export const isDts = (p: string): boolean => /\.d\.[mc]?ts$/.test(p);
export const extOf = (p: string): string => {
  const m = /\.[^./]+$/.exec(p);
  return m ? m[0] : '';
};
export const isSourceFile = (p: string): boolean => SOURCE_EXTS.includes(extOf(p)) && !isDts(p);
export const isTsFile = (p: string): boolean =>
  (TS_EXTS as readonly string[]).includes(extOf(p)) && !isDts(p);

const BUILTINS = new Set(builtinModules);

/** 'react/jsx-runtime' → 'react','@a/b/c' → '@a/b';Node 内置模块与 URL 返回 null */
export function packageName(spec: string): string | null {
  if (spec.startsWith('node:') || /^[a-z]+:\/\//i.test(spec)) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
  if (!name || BUILTINS.has(name)) return null;
  return /^(@[\w.-]+\/)?[\w.-]+$/.test(name) ? name : null;
}

export const isRelative = (spec: string): boolean =>
  spec === '.' ||
  spec === '..' ||
  spec.startsWith('./') ||
  spec.startsWith('../') ||
  spec.startsWith('/');

/** 资源类 import 的扩展名:只计数,不进图(T-003 规则) */
export const ASSET_EXTS: readonly string[] = [
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.styl',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.ico',
  '.bmp',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.webm',
  '.wav',
  '.ogg',
  '.wasm',
  '.json',
  '.md',
  '.txt',
  '.html',
];

/** './a.css'、'./logo.svg?url'、'pkg/dist/style.css' 均视为资源 */
export const isAssetSpec = (spec: string): boolean =>
  ASSET_EXTS.includes(extOf(spec.replace(/[?#].*$/, '')).toLowerCase());
