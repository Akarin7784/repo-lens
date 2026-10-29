import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRepo, createRegistry } from './analyze.js';
import { AnalyzerError } from './errors.js';
import { isTsJsRepo, surveyRepo } from './typescript/detect.js';

/** 在临时目录写出 { 相对路径: 内容 },返回根目录与其中的 TS/JS 源码列表(模拟 scanRepo 的输出) */
function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'rl-detect-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, dirname(p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  const src = Object.keys(files)
    .filter((p) => /\.[cm]?[jt]sx?$/.test(p))
    .sort();
  return { root, files: src };
}
const many = (prefix: string, ext: string, n: number, body = 'x\n') =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}/f${i}${ext}`, body]));

describe('TS/JS 仓库识别(detect.ts)', () => {
  it('monorepo:根只有 tsconfig.base.json,包里有 tsconfig.json → 支持(repo-lens 自身的形状)', async () => {
    const r = repo({
      'tsconfig.base.json': '{}',
      'package.json': '{}',
      'packages/a/tsconfig.json': '{"extends":"../../tsconfig.base.json"}',
      'packages/a/src/index.ts': "export * from './x';\n",
      'packages/a/src/x.ts': 'export const x = 1;\n',
      'apps/api/tsconfig.json': '{}',
      'apps/api/src/main.ts': "import { x } from '../../../packages/a/src/x';\nconsole.log(x);\n",
    });
    expect(surveyRepo(r.root).tsconfigDirs.sort()).toEqual(['', 'apps/api', 'packages/a']);
    expect(isTsJsRepo(r.root, r.files)).toBe(true);
    // 端到端:detect 选中 TS 分析器,init 在没有根 tsconfig.json 时走原降级路径,分析照常完成
    const a = await createRegistry(new Set(r.files)).detect(r);
    expect(a.id).toBe('typescript');
    a.dispose();
    const res = await analyzeRepo(r);
    expect(res.language).toBe('typescript');
    expect(res.stats.files).toBe(3);
  });

  it('根只有 tsconfig.base.json、没有任何包级 tsconfig → 也支持', () => {
    const r = repo({ 'tsconfig.base.json': '{}', ...many('packages/a/src', '.ts', 3) });
    expect(isTsJsRepo(r.root, r.files)).toBe(true);
  });

  it('没有 tsconfig、全是 JS → 占比 ≥ 50% 支持', () => {
    const r = repo(many('lib', '.js', 4));
    expect(isTsJsRepo(r.root, r.files)).toBe(true);
  });

  it('没有 tsconfig 且 TS/JS 占比低(< 50%)→ 不支持,detect 抛 UNSUPPORTED_LANGUAGE', async () => {
    const r = repo({ ...many('src', '.py', 6), ...many('web', '.js', 4) });
    expect(isTsJsRepo(r.root, r.files)).toBe(false);
    const err = await createRegistry(new Set(r.files))
      .detect(r)
      .catch((x: unknown) => x);
    expect((err as AnalyzerError).code).toBe('UNSUPPORTED_LANGUAGE');
    expect((err as AnalyzerError).message).toBe('目前仅支持 TypeScript/JavaScript 仓库');
  });

  it('Vue 应用:有 tsconfig、50 个 .vue、8 个 .ts → 支持(.vue 不计入其他语言)', async () => {
    const r = repo({
      'tsconfig.json': '{}',
      ...many('src/components', '.vue', 50, '<template><div/></template>\n'),
      ...many('src/lib', '.ts', 8, 'export const x = 1;\n'),
    });
    expect(surveyRepo(r.root).otherSourceFiles).toBe(0);
    expect(isTsJsRepo(r.root, r.files)).toBe(true);
    const a = await createRegistry(new Set(r.files)).detect(r);
    expect(a.id).toBe('typescript');
    a.dispose();
  });

  it('无 tsconfig 的 Vue/Svelte JS 应用:30 个 .vue + 5 个 .svelte + 4 个 .js → 支持(share=4/4=100% ≥ 50%)', () => {
    // 旧规则(根 tsconfig.json + TS ≥ 50%)对无 tsconfig 仓库一律拒绝,这里是放宽而非倒退
    const r = repo({
      'package.json': '{}',
      ...many('src/components', '.vue', 30),
      ...many('src/widgets', '.svelte', 5),
      ...many('src', '.js', 4),
    });
    expect(surveyRepo(r.root).otherSourceFiles).toBe(0);
    expect(isTsJsRepo(r.root, r.files)).toBe(true);
  });

  it('误判防护:Java 仓库只有文档站子目录带 tsconfig,TS 占比 < 20% → 不支持', () => {
    const r = repo({
      'pom.xml': '<project/>',
      ...many('src/main/java/com/acme', '.java', 40),
      'website/tsconfig.json': '{}',
      ...many('website/src', '.ts', 5),
    });
    expect(surveyRepo(r.root).otherSourceFiles).toBe(40);
    expect(isTsJsRepo(r.root, r.files)).toBe(false);
  });

  it('有 tsconfig 且 TS 占比在 20%–50% 之间 → 支持(全栈仓库的前端/工具链占比)', () => {
    const r = repo({
      'frontend/tsconfig.json': '{}',
      ...many('frontend/src', '.ts', 3),
      ...many('backend', '.go', 7),
    });
    expect(isTsJsRepo(r.root, r.files)).toBe(true);
  });

  it('排除目录(node_modules、隐藏目录)里的 tsconfig 与其他语言文件不计入', () => {
    const r = repo({
      'node_modules/x/tsconfig.json': '{}',
      '.github/scripts/a.py': '',
      ...many('src', '.ts', 2),
      ...many('py', '.py', 3),
    });
    const s = surveyRepo(r.root);
    expect(s.tsconfigDirs).toEqual([]);
    expect(s.otherSourceFiles).toBe(3);
    expect(isTsJsRepo(r.root, r.files)).toBe(false); // 2/5 < 50%,且无有效 tsconfig
  });

  it('没有任何 TS/JS 源码 → 不支持(即便有 tsconfig)', () => {
    const r = repo({ 'tsconfig.json': '{}', 'main.py': '' });
    expect(isTsJsRepo(r.root, r.files)).toBe(false);
  });
});
