/* global process, console, fetch */
// 经 web 代理访问 api:web 的 /api/* 必须由 Next rewrites 转发到 api。
// 期望 /api/repos/999999 得到 api 的 404 REPO_NOT_FOUND JSON,而不是 Next 自己的 404 页面。
const WEB = process.env.WEB_BASE ?? 'http://localhost:3000';
const url = `${WEB}/api/repos/999999`;
const res = await fetch(url, { headers: { accept: 'application/json' } });
const ct = res.headers.get('content-type') ?? '';
const text = await res.text();
let body = null;
try {
  body = JSON.parse(text);
} catch {
  /* 非 JSON */
}
console.log(`SMOKE web_proxy_status=${res.status} content_type=${ct}`);
const ok =
  res.status === 404 &&
  ct.includes('application/json') &&
  body?.error?.code === 'REPO_NOT_FOUND' &&
  typeof body?.error?.message === 'string';
if (!ok) {
  console.error(
    `SMOKE FAIL: 经 web 访问到的不是 api 的响应(可能是 Next 404 页面或 rewrites 未指向 api)\n` +
      `  GET ${url}\n  status=${res.status}\n  content-type=${ct}\n` +
      `  body[0..200]=${JSON.stringify(text.slice(0, 200))}`,
  );
  process.exit(1);
}
console.log('SMOKE web_proxy=ok');
