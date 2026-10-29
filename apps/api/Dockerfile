# 构建上下文为仓库根目录
FROM node:20-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm turbo run build --filter=@repolens/api...
FROM node:20-alpine
# 不带 ref 提交时 githost 在 api 进程内执行 git ls-remote 解析 HEAD,运行时镜像必须带 git
RUN apk add --no-cache git
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]
