# 构建上下文为仓库根目录
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /app
# rewrites 在构建时固定(next.config.mjs);compose 里 api 服务名为 api
ARG API_PROXY_TARGET=http://api:4000
ENV API_PROXY_TARGET=$API_PROXY_TARGET
COPY . .
RUN pnpm install --frozen-lockfile && pnpm turbo run build --filter=@repolens/web...
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
CMD ["node", "apps/web/server.js"]
