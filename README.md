# RepoLens

输入一个 GitHub 仓库地址,生成可交互的架构图,并用自然语言提问,答案附带经过校验的文件与行号引用,同时在图上高亮对应位置。

> 状态:开发中(第 1 周:TypeScript 仓库的解析与基础图)。

- 架构与接口约定:[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 后端与 AI 设计:[docs/BACKEND_AI_DESIGN.md](docs/BACKEND_AI_DESIGN.md)
- 前端与交互设计:[docs/FRONTEND_DESIGN.md](docs/FRONTEND_DESIGN.md)
- 界面风格:[docs/DESIGN_STYLE.md](docs/DESIGN_STYLE.md)
- 开发进度:[docs/PROGRESS.md](docs/PROGRESS.md)
- 协作规范:[CONTRIBUTING.md](CONTRIBUTING.md)

## 支持范围

**第 1 周仅支持 TypeScript 仓库**(`.ts`/`.tsx`);其他语言提交时 `POST /api/repos` 返回 422 `UNSUPPORTED_LANGUAGE`。多语言通过 `packages/analyzer` 的 `LanguageAnalyzer` registry 在后续扩展。

## 本地开发

需要 Node.js 20(`.nvmrc` 与 `engines` 固定为 20,CI 和三个 Dockerfile 都用 `node:20`)、pnpm 10、Docker(可选,起 MySQL/Redis/Qdrant)。

```bash
pnpm install
cp .env.example .env
docker compose up -d mysql redis qdrant   # 基础设施
pnpm build && pnpm test && pnpm lint && pnpm typecheck   # 新 clone 必须先 build:api 的 dev 脚本运行的是 dist
pnpm dev                                   # turbo run dev:web http://localhost:3000 + api(node --watch dist/index.js)
```

> 注意(已实测):turbo 默认 strict env 模式,`pnpm dev` 不会把 shell 里的 `DATABASE_URL`/`REDIS_URL` 等传给 api,api 会报「DATABASE_URL 未设置」退出;worker 没有 dev 脚本。需要后端时在另一个终端直接启动:`DATABASE_URL=... REDIS_URL=... pnpm --filter @repolens/api start`(端口 `API_PORT`,默认 4000)和 `pnpm --filter @repolens/worker start`。

## 目录

| 路径                            | 职责                                                         |
| ------------------------------- | ------------------------------------------------------------ |
| `apps/web`                      | Next.js App Router:首页、图与问答界面                        |
| `apps/api`                      | Fastify:REST + SSE(`/health` 已可用)                         |
| `apps/worker`                   | BullMQ:clone → scan → parse → graph 流水线                   |
| `apps/mcp`                      | MCP Server(W4)                                               |
| `packages/shared`               | zod schema:GraphData、SSE 事件、进度阶段、API DTO,前后端共用 |
| `packages/analyzer`             | LanguageAnalyzer、TypeScriptAnalyzer(T-002)                  |
| `packages/rag` / `agent` / `db` | 检索、问答 agent、Drizzle schema(后续任务)                   |

## 许可证

MIT

### 关于本机 Node 24

开发机目前是 Node 24,而 CI 与镜像是 Node 20。纯 JS 代码两者无差异,但原生绑定(如 tree-sitter)按 Node ABI 编译,24 上能装不代表 20 上能跑。以 CI 的 `smoke` 任务(镜像内真实运行)为准;本地建议 `nvm use` 切到 20 再验证。提交前请用 Node 20 跑一遍测试(本机 Node 24 复现不出 Node 20 下的问题)。`engines` 写成 `>=20 <21`,pnpm 在 Node 24 上只会警告不会报错(未开启 engine-strict)。
