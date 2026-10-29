/**
 * API 地址(FRONTEND_DESIGN.md §6):
 * - `NEXT_PUBLIC_API_BASE_URL`:浏览器直接请求的 API 根地址,例如 `http://localhost:4000`。
 *   构建时内联;留空表示同源(配合 next.config.mjs 里 `API_PROXY_TARGET` 的 rewrites 代理)。
 * 末尾的 `/` 会被去掉。
 */
export function apiBase(): string {
  return (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');
}
