/* global process */
/**
 * API 地址两种接法(FRONTEND_DESIGN.md §6):
 * 1. 浏览器直连:构建时设 NEXT_PUBLIC_API_BASE_URL=http://api-host:4000(要求 API 允许跨域)。
 * 2. 同源代理:NEXT_PUBLIC_API_BASE_URL 留空,构建时设 API_PROXY_TARGET=http://api:4000,
 *    由 Next 把 /api/* 转发过去(当前 API 未开 CORS,本地联调用这种)。
 */
const proxy = process.env.API_PROXY_TARGET?.replace(/\/+$/, '');

/**
 * T-230:`*.dev.tsx` 页面(假数据预览,如 app/dev/chat/page.dev.tsx)只在 `next dev` 时注册为路由;
 * `next build` 的 pageExtensions 不含 dev.tsx,这些文件不会被打包进生产产物。
 * @param {string} phase
 * @returns {import('next').NextConfig}
 */
const nextConfig = (phase) => ({
  pageExtensions:
    phase === 'phase-development-server'
      ? ['dev.tsx', 'tsx', 'ts', 'jsx', 'js']
      : ['tsx', 'ts', 'jsx', 'js'],
  output: 'standalone',
  transpilePackages: ['@repolens/shared'],
  // SSE 走代理时不能被压缩缓冲
  compress: false,
  ...(proxy
    ? { rewrites: async () => [{ source: '/api/:path*', destination: `${proxy}/api/:path*` }] }
    : {}),
});
export default nextConfig;
