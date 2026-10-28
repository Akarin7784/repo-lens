// T-005:在镜像内真实加载 tree-sitter 原生绑定,用 TypeScriptAnalyzer 解析一小段 TS。失败即非 0 退出。
/* global process, console */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeRepo } from '@repolens/analyzer';

const root = mkdtempSync(join(tmpdir(), 'smoke-'));
mkdirSync(join(root, 'src/core'), { recursive: true });
writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"module":"esnext"}}');
writeFileSync(
  join(root, 'src/core/a.ts'),
  "import { b } from './b';\nexport const a = (): number => b + 1;\n",
);
writeFileSync(join(root, 'src/core/b.ts'), 'export const b: number = 1;\n');

const r = await analyzeRepo({ root, files: ['tsconfig.json', 'src/core/a.ts', 'src/core/b.ts'] });
const s = { node: process.versions.node, abi: process.versions.modules, ...r.stats, ms: undefined };
console.log('SMOKE analyzer=' + JSON.stringify(s));
if (r.stats.files !== 2 || r.stats.syntaxErrorFiles !== 0 || r.stats.edges < 1) process.exit(1);
