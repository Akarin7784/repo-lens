# 构建上下文为仓库根目录
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm turbo run build --filter=@repolens/api...
FROM node:20-alpine
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]
