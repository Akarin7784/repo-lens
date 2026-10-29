/* global process */
/**
 * API 地址两种接法(FRONTEND_DESIGN.md §6):
 * 1. 浏览器直连:构建时设 NEXT_PUBLIC_API_BASE_URL=http://api-host:4000(要求 API 允许跨域)。
 * 2. 同源代理:NEXT_PUBLIC_API_BASE_URL 留空,构建时设 API_PROXY_TARGET=http://api:4000,
 *    由 Next 把 /api/* 转发过去(当前 API 未开 CORS,本地联调用这种)。
 */
const proxy = process.env.API_PROXY_TARGET?.replace(/\/+$/, '');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@repolens/shared'],
  // SSE 走代理时不能被压缩缓冲
  compress: false,
  ...(proxy
    ? { rewrites: async () => [{ source: '/api/:path*', destination: `${proxy}/api/:path*` }] }
    : {}),
};
export default nextConfig;
