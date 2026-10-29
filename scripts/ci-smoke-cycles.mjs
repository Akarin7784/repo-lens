/* global process, console, fetch, setTimeout */
// 环检测冒烟(inCycle 与图投影同源):分析一个带已知环的仓库,断言 /graph 的边与 /nodes 都给出 inCycle:true。
// 仓库:honojs/hono 固定 commit(演示仓库;CI runner 有网络,走与 zustand 相同的真实 GitHub 浅克隆,不用本地 fixture)。
// 已知环(本地 analyzer 实测,共 5 个 SCC / 12 个文件):src/helper/streaming/index.ts ↔ src/helper/streaming/text.ts。
// 只用 Node 20 自带 fetch;CI 用 FakeLlm,不需要任何密钥。
const BASE = process.env.API_BASE ?? 'http://localhost:4000';
const REPO_URL = 'https://github.com/honojs/hono';
const REF = 'ed1d5f72135ccf7e09c17d64dc4af7588dd3e491';
const TIMEOUT_MS = Number(process.env.SMOKE_CYCLES_TIMEOUT ?? 240) * 1000;
const DIR = 'd:src/helper/streaming';
const CYCLE_FILES = ['f:src/helper/streaming/index.ts', 'f:src/helper/streaming/text.ts'];
const NON_CYCLE_FILE = 'f:src/hono.ts';

const fail = (msg, extra) => {
  console.error(`SMOKE FAIL: ${msg}`);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
  process.exit(1);
};
const t0 = Date.now();
const res = await fetch(`${BASE}/api/repos`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ repoUrl: REPO_URL, ref: REF }),
});
const sub = await res.json().catch(() => null);
if (![200, 202].includes(res.status) || !sub?.repoId) fail(`提交 hono 失败 ${res.status}`, sub);
let st;
for (;;) {
  st = await (await fetch(`${BASE}/api/repos/${sub.repoId}`)).json();
  if (st.status === 'done') break;
  if (st.status === 'failed') fail('hono 分析失败', st);
  if (Date.now() - t0 > TIMEOUT_MS) fail(`${TIMEOUT_MS / 1000}s 内未完成`, st);
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`SMOKE cycles analyze_ms=${Date.now() - t0} stats=${JSON.stringify(st.stats)}`);

const gr = await fetch(`${BASE}/api/repos/${sub.repoId}/graph?parentId=${encodeURIComponent(DIR)}`);
const g = await gr.json().catch(() => null);
if (gr.status !== 200) fail(`GET graph ${DIR} → ${gr.status}`, g);
const cyc = g.edges.filter((e) => e.inCycle === true);
console.log(
  `SMOKE cycles graph[${DIR}] edges=${g.edges.length} inCycle=${cyc.map((e) => e.id).join(',')}`,
);
for (const [a, b] of [CYCLE_FILES, [...CYCLE_FILES].reverse()])
  if (!cyc.some((e) => e.source === a && e.target === b))
    fail(`${a} -> ${b} 缺 inCycle:true 边`, g.edges);

for (const id of [...CYCLE_FILES, NON_CYCLE_FILE]) {
  const r = await fetch(`${BASE}/api/repos/${sub.repoId}/nodes/${encodeURIComponent(id)}`);
  const d = await r.json().catch(() => null);
  if (r.status !== 200) fail(`GET nodes/${id} → ${r.status}`, d);
  const want = id !== NON_CYCLE_FILE;
  console.log(`SMOKE cycles node ${id} inCycle=${d.inCycle}`);
  if (d.inCycle !== want) fail(`${id} inCycle 应为 ${want}`, d);
}
console.log('SMOKE CYCLES PASS');
