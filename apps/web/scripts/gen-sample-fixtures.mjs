/* global URL, console */
// 生成示例 fixture(手写示例数据,不是对真实仓库的解析结果)。
// 规则遵循 packages/shared/src/graph.ts:module → dir → file;无 workspace 时 src/ 下一级目录为 module,
// 其余文件归根模块 m:.;只产出入库数据(module/dir/file 节点 + file→file 原始边,file 带 externalDeps),
// 不产出 x: 节点与 aggregated 边(二者是 API 层派生数据)。
// 用法:node scripts/gen-sample-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { posix as P } from 'node:path';

const ZERO_SHA = '0'.repeat(40);

function build({ repoId, files, imports }) {
  const nodes = new Map();
  const add = (n) => (nodes.has(n.id) ? nodes.get(n.id) : (nodes.set(n.id, n), n));
  const moduleOf = (p) => {
    const seg = p.split('/');
    return seg[0] === 'src' && seg.length > 2 ? `src/${seg[1]}` : '.';
  };
  const ensureParent = (dir, mod) => {
    if (dir === mod || dir === '' || dir === '.') {
      add({
        id: `m:${mod}`,
        type: 'module',
        parentId: null,
        label: mod === '.' ? '(root)' : P.basename(mod),
        path: mod,
      });
      return `m:${mod}`;
    }
    const pid = ensureParent(P.dirname(dir) === '.' && mod === '.' ? '.' : P.dirname(dir), mod);
    add({ id: `d:${dir}`, type: 'dir', parentId: pid, label: P.basename(dir), path: dir });
    return `d:${dir}`;
  };
  for (const [path, loc, externalDeps] of files) {
    const parentId = ensureParent(P.dirname(path), moduleOf(path));
    const n = { id: `f:${path}`, type: 'file', parentId, label: P.basename(path), path, loc };
    if (externalDeps) n.externalDeps = externalDeps;
    add(n);
  }
  const edges = imports.map(([s, t, kind]) => ({
    id: `e:${s}->${t}:${kind}`,
    source: `f:${s}`,
    target: `f:${t}`,
    type: 'imports',
    kind,
    srcFileId: `f:${s}`,
    weight: 1,
  }));
  // 父节点排在子节点之前,module 在最前,输出稳定
  const order = { module: 0, dir: 1, file: 2 };
  const list = [...nodes.values()].sort(
    (a, b) => order[a.type] - order[b.type] || a.id.localeCompare(b.id),
  );
  return {
    nodes: list,
    edges,
    meta: { repoId, commitSha: ZERO_SHA, parentId: null, language: 'typescript' },
  };
}

const hono = build({
  repoId: 1,
  files: [
    ['package.json', 0],
    ['jsr.json', 20],
    ['src/index.ts', 30],
    ['src/hono.ts', 120],
    ['src/hono-base.ts', 410],
    ['src/context.ts', 380],
    ['src/compose.ts', 72],
    ['src/request.ts', 260],
    ['src/types.ts', 540],
    ['src/middleware/cors/index.ts', 110],
    ['src/middleware/logger/index.ts', 70],
    ['src/middleware/jwt/index.ts', 20],
    ['src/middleware/jwt/jwt.ts', 95],
    ['src/helper/cookie/index.ts', 130],
    ['src/helper/streaming/index.ts', 20],
    ['src/helper/streaming/sse.ts', 75],
    ['src/adapter/bun/index.ts', 60],
    ['src/adapter/cloudflare-workers/index.ts', 40, ['@cloudflare/workers-types']],
    ['src/adapter/aws-lambda/handler.ts', 230, ['aws-lambda']],
    ['src/router/reg-exp-router/router.ts', 190],
    ['src/router/reg-exp-router/node.ts', 110],
    ['src/router/trie-router/router.ts', 70],
    ['src/router/trie-router/node.ts', 180],
    ['src/router/smart-router/router.ts', 60],
    ['src/utils/url.ts', 140],
    ['src/utils/body.ts', 95],
    ['src/utils/cookie.ts', 120],
    ['src/utils/jwt/jwt.ts', 150],
    ['src/utils/jwt/jws.ts', 90],
    ['src/utils/mime.ts', 85],
    ['src/utils/html.ts', 60],
    ['src/jsx/index.ts', 40],
    ['src/jsx/base.ts', 170],
    ['src/jsx/dom/index.ts', 30],
    ['src/jsx/dom/render.ts', 230],
  ],
  imports: [
    ['src/index.ts', 'src/hono.ts', 're-export'],
    ['src/hono.ts', 'src/hono-base.ts', 'static'],
    ['src/hono-base.ts', 'src/compose.ts', 'static'],
    ['src/hono-base.ts', 'src/context.ts', 'static'],
    ['src/hono-base.ts', 'src/utils/url.ts', 'static'],
    ['src/context.ts', 'src/request.ts', 'static'],
    ['src/context.ts', 'src/types.ts', 'type-only'],
    ['src/context.ts', 'src/utils/mime.ts', 'dynamic'],
    ['src/request.ts', 'src/utils/body.ts', 'static'],
    ['src/request.ts', 'src/utils/url.ts', 'static'],
    ['src/hono.ts', 'src/router/smart-router/router.ts', 'static'],
    ['src/router/smart-router/router.ts', 'src/router/reg-exp-router/router.ts', 'static'],
    ['src/router/smart-router/router.ts', 'src/router/trie-router/router.ts', 'static'],
    ['src/router/reg-exp-router/router.ts', 'src/router/reg-exp-router/node.ts', 'static'],
    ['src/router/trie-router/router.ts', 'src/router/trie-router/node.ts', 'static'],
    ['src/middleware/jwt/index.ts', 'src/middleware/jwt/jwt.ts', 're-export'],
    ['src/middleware/jwt/jwt.ts', 'src/utils/jwt/jwt.ts', 'static'],
    ['src/utils/jwt/jwt.ts', 'src/utils/jwt/jws.ts', 'static'],
    ['src/middleware/jwt/jwt.ts', 'src/context.ts', 'type-only'],
    ['src/middleware/cors/index.ts', 'src/types.ts', 'type-only'],
    ['src/middleware/logger/index.ts', 'src/utils/url.ts', 'static'],
    ['src/helper/cookie/index.ts', 'src/utils/cookie.ts', 'static'],
    ['src/helper/streaming/index.ts', 'src/helper/streaming/sse.ts', 're-export'],
    ['src/helper/streaming/sse.ts', 'src/context.ts', 'type-only'],
    ['src/adapter/bun/index.ts', 'src/hono.ts', 'type-only'],
    ['src/adapter/cloudflare-workers/index.ts', 'src/hono.ts', 'type-only'],
    ['src/adapter/aws-lambda/handler.ts', 'src/hono.ts', 'type-only'],
    ['src/jsx/index.ts', 'src/jsx/base.ts', 're-export'],
    ['src/jsx/base.ts', 'src/utils/html.ts', 'static'],
    ['src/jsx/dom/index.ts', 'src/jsx/dom/render.ts', 're-export'],
    ['src/jsx/dom/render.ts', 'src/jsx/base.ts', 'static'],
  ],
});

const zustand = build({
  repoId: 2,
  files: [
    ['package.json', 0],
    ['rollup.config.mjs', 80],
    ['src/index.ts', 5],
    ['src/vanilla.ts', 110],
    ['src/react.ts', 70, ['react']],
    ['src/shallow.ts', 5],
    ['src/traditional.ts', 60, ['use-sync-external-store']],
    ['src/middleware.ts', 10],
    ['src/middleware/devtools.ts', 260],
    ['src/middleware/persist.ts', 420],
    ['src/middleware/immer.ts', 50, ['immer']],
    ['src/middleware/redux.ts', 50],
    ['src/middleware/subscribeWithSelector.ts', 70],
    ['src/middleware/combine.ts', 20],
    ['src/react/shallow.ts', 25, ['react']],
    ['src/vanilla/shallow.ts', 70],
  ],
  imports: [
    ['src/index.ts', 'src/vanilla.ts', 're-export'],
    ['src/index.ts', 'src/react.ts', 're-export'],
    ['src/react.ts', 'src/vanilla.ts', 'static'],
    ['src/traditional.ts', 'src/vanilla.ts', 'static'],
    ['src/middleware.ts', 'src/middleware/devtools.ts', 're-export'],
    ['src/middleware.ts', 'src/middleware/persist.ts', 're-export'],
    ['src/middleware.ts', 'src/middleware/immer.ts', 're-export'],
    ['src/middleware.ts', 'src/middleware/redux.ts', 're-export'],
    ['src/middleware.ts', 'src/middleware/subscribeWithSelector.ts', 're-export'],
    ['src/middleware.ts', 'src/middleware/combine.ts', 're-export'],
    ['src/middleware/persist.ts', 'src/vanilla.ts', 'type-only'],
    ['src/middleware/devtools.ts', 'src/vanilla.ts', 'type-only'],
    ['src/middleware/redux.ts', 'src/middleware/devtools.ts', 'type-only'],
    ['src/middleware/immer.ts', 'src/vanilla.ts', 'type-only'],
    ['src/shallow.ts', 'src/vanilla/shallow.ts', 're-export'],
    ['src/shallow.ts', 'src/react/shallow.ts', 're-export'],
    ['src/react/shallow.ts', 'src/vanilla/shallow.ts', 'static'],
  ],
});

for (const [name, g] of [
  ['hono', hono],
  ['zustand', zustand],
]) {
  writeFileSync(
    new URL(`../fixtures/${name}.sample.graph.json`, import.meta.url),
    JSON.stringify(g, null, 2) + '\n',
  );
  console.log(name, g.nodes.length, 'nodes', g.edges.length, 'edges');
}
