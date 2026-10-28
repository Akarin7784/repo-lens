# 构建上下文为仓库根目录
FROM node:20-alpine AS build
# tree-sitter 无 musl 预编译时需本地编译
RUN apk add --no-cache python3 make g++ && corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm turbo run build --filter=@repolens/worker...
FROM node:20-alpine
# 流水线用 git 浅克隆
RUN apk add --no-cache git
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
