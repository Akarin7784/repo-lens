// T-005 后续:真实业务链路冒烟。api → MySQL 8.4 → Redis(BullMQ)→ worker → 图接口。
// 只用 Node 20 自带 fetch,不引入依赖。接口与 PR #10「最小调用方式」一致。
const BASE = process.env.API_BASE ?? 'http://localhost:4000';
const REPO_URL = 'https://github.com/pmndrs/zustand';
const REF = '382d29c485e67018c06e75ec7235130d0968522c'; // 固定 commit,与 #10 实测一致
const TIMEOUT_MS = Number(process.env.SMOKE_ANALYZE_TIMEOUT ?? 180) * 1000;
const MIN_NODES = 10; // #10 实测 23,下限放宽

const fail = (msg, extra) => {
  console.error(`SMOKE FAIL: ${msg}`);
  if (extra !== undefined) console.error(typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2));
  process.exit(1);
};

const t0 = Date.now();
const res = await fetch(`${BASE}/api/repos`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ repoUrl: REPO_URL, ref: REF }),
});
const sub = await res.json().catch(() => null);
console.log(`SMOKE submit_status=${res.status} body=${JSON.stringify(sub)}`);
if (![200, 202].includes(res.status) || !sub?.jobId) fail('提交任务失败', sub);
if (sub.commitSha !== REF) fail(`commitSha 不一致:${sub.commitSha}`);

// 订阅 SSE,等 graph_ready 与 done;stage_error 立即失败
const events = [];
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
let graphReady = null, done = null;
try {
  const r = await fetch(`${BASE}/api/jobs/${encodeURIComponent(sub.jobId)}/events`, {
    headers: { accept: 'text/event-stream' }, signal: ctrl.signal,
  });
  if (!r.ok || !r.body) fail(`SSE 返回 ${r.status}`);
  const dec = new TextDecoder();
  let buf = '';
  outer: for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      let event = 'message'; const data = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue; // 注释/心跳
      let payload; try { payload = JSON.parse(data.join('\n')); } catch { payload = data.join('\n'); }
      events.push({ event, payload, t: Date.now() - t0 });
      if (event === 'progress') console.log(`SMOKE progress +${Date.now() - t0}ms stage=${payload.stage}`);
      if (event === 'stage_error') fail('收到 stage_error', events);
      if (event === 'graph_ready') graphReady = payload;
      if (event === 'done') { done = payload; break outer; }
    }
  }
} catch (e) {
  if (ctrl.signal.aborted) fail(`${TIMEOUT_MS / 1000}s 内未收到 done`, events);
  fail(`SSE 异常:${e}`, events);
} finally { clearTimeout(timer); ctrl.abort(); }
if (!done) fail('SSE 提前结束,未收到 done', events);
if (done.status !== 'done') fail(`done.status=${done.status}`, events);
if (!graphReady) fail('done 之前未收到 graph_ready', events);
console.log(`SMOKE analyze_ms=${Date.now() - t0} stats=${JSON.stringify(done.stats ?? null)}`);

// 图接口校验(手写,规则对应 packages/shared 的 GraphDataSchema 关键约束)
function checkGraph(g, label) {
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges) || typeof g.meta !== 'object') fail(`${label} 结构不对`, g);
  if (g.meta.commitSha !== REF) fail(`${label} meta.commitSha=${g.meta.commitSha}`);
  const ids = new Set();
  for (const n of g.nodes) {
    if (!/^(m|d|f):/.test(n.id)) fail(`${label} 节点 id 前缀非法:${n.id}`);
    if (!['module', 'dir', 'file'].includes(n.type)) fail(`${label} 节点 type 非法`, n);
    if (n.id[0] !== n.type[0]) fail(`${label} id 前缀与 type 不符`, n);
    if (ids.has(n.id)) fail(`${label} 节点 id 重复:${n.id}`);
    ids.add(n.id);
  }
  for (const e of g.edges) {
    if (e.type !== 'imports') fail(`${label} 边 type 不是 imports`, e);
    if (!ids.has(e.source) || !ids.has(e.target)) fail(`${label} 边端点不在 nodes 里`, e);
    if (!e.aggregated && e.source.startsWith('f:') && e.target.startsWith('f:') && !e.srcFileId)
      fail(`${label} 文件级边缺 srcFileId`, e);
  }
  console.log(`SMOKE graph[${label}] nodes=${g.nodes.length} edges=${g.edges.length}`);
  return g;
}
const getGraph = async (q) => {
  const r = await fetch(`${BASE}${graphReady.graphUrl}${q}`);
  const body = await r.json().catch(() => null);
  if (r.status !== 200) fail(`图接口 ${q || '(root)'} 返回 ${r.status}`, body);
  return body;
};
const root = checkGraph(await getGraph(''), 'root');
const all = [...root.nodes];
const modules = root.nodes.filter((n) => n.type === 'module');
let fileEdges = 0;
for (const m of modules) {
  const g = checkGraph(await getGraph(`?parentId=${encodeURIComponent(m.id)}`), m.id);
  all.push(...g.nodes);
  fileEdges += g.edges.filter((e) => e.srcFileId).length;
}
const uniq = new Set(all.map((n) => n.id)).size;
console.log(`SMOKE graph_total_nodes=${uniq} file_edges_with_srcFileId=${fileEdges}`);
if (uniq < MIN_NODES) fail(`节点总数 ${uniq} < ${MIN_NODES}`);
if (fileEdges < 1) fail('展开后没有任何带 srcFileId 的文件级边');
console.log('SMOKE ANALYZE PASS');
