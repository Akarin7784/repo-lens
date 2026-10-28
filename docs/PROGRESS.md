# 开发进度记录

由项目管理角色维护。每合并一个 PR、每完成一个里程碑都在这里记一条。时间为北京时间。

## 里程碑
| 周 | 目标 | 状态 |
|---|---|---|
| W1 | TS 解析与基础图:脚手架、clone 与文件树、`TypeScriptAnalyzer`、依赖图 JSON、前端出图、任务与 SSE 进度 | 进行中 |
| W2 | 分层摘要、节点详情、Qdrant 索引 | 未开始 |
| W3 | 代码 RAG 问答、引用校验、图上高亮联动 | 未开始 |
| W4 | MCP 服务、预解析示例仓库、演示脚本与兜底视频、README | 未开始 |

## 第 1 周任务
| 编号 | 任务 | 负责 | 状态 | PR |
|---|---|---|---|---|
| T-001 | Monorepo 脚手架、CI、docker-compose、`packages/shared` 的 zod 类型 | 架构师 | 已合并 | [#5](https://github.com/Akarin7784/repo-lens/pull/5) |
| T-002 | `LanguageAnalyzer` 接口、registry、`TypeScriptAnalyzer` | 后端与AI设计师 | 已合并 | [#7](https://github.com/Akarin7784/repo-lens/pull/7) |
| T-003 | API 与 Worker:`POST /api/repos`、任务 SSE、clone 与文件树 | 后端与AI设计师 | 开发中(基于 #7) | - |
| T-004 | Web:设计令牌、首页、基于 fixture 的图渲染(React Flow + elkjs) | 前端可视化设计师 | 开发中 | - |
| T-005 | CI 冒烟任务:真实构建镜像、起 compose、请求 `/health` | 架构师 | 可开工,第 1 周内完成 | - |

## 第 1 周未验证项
- 镜像构建和 `docker compose up` 尚未真实验证(PR #5 合并时就已知),由 T-005 补上。
- 本机 Node 24 与 CI、Dockerfile 的 Node 20 不一致,CI 已固定 20,T-005 里一并写明。
- Docker 镜像内 `tree-sitter`(0.22.4,原生绑定)能否安装并运行尚未验证,由 T-005 的 CI 冒烟任务在镜像里真实加载并解析一小段 TS 代码来验证。
- 语法错误文件数(tree-sitter-typescript 不支持部分语法):zustand 5 个、hono 8 个(共 450 个文件)、zod 4 个(共 522 个文件)。import 仍能提取,只影响这些文件的符号和切块。

## 日志
- 2026-10-29 03:3x:仓库建立,三份设计文档和 Claude 风格规范提交到 `docs/`,拆分第 1 周任务。
- 2026-10-29 03:5x:T-001 合并(PR #5,squash,提交 c31061f)。评审时我在干净环境里独立跑了 install(frozen-lockfile)、lint、typecheck、build、test,全部通过;逐项核对 `packages/shared` 与设计结论一致(无 `verified`/`reset`,`droppedCitations`,`error` 四个错误码)。确认四点:聚合边为 `type:'imports'` + `aggregated:true`(与此前口头约定的 `type:'aggregated'` 不同,以 shared 为准,已通知前端);`x:` 节点 `path` 为包名;详情 `kind` 允许 `dir`/`external`;compose 数据服务只绑 `127.0.0.1`。遗留:Dockerfile 与 `docker compose up` 尚未在有 Docker 的环境验证;T-002 起注意本机 Node 24 与 CI/镜像 Node 20 的原生绑定一致性。同时修复 CONTRIBUTING.md 被格式化后一条说明并入编号的问题。
- 2026-10-29 04:0x:T-002 合并(PR #7,squash,提交 f07ce85)。评审时独立跑了 install、lint、typecheck、build、test,全部通过,并自己 clone 三个演示仓库跑 analyzer 基准,结果与 PR 描述一致。实测规模(全量图,未排除测试和文档):

  | 仓库 | commit | 源码文件 | 节点 module/dir/file | 边 | 环 | 耗时 |
  |---|---|---|---|---|---|---|
  | zustand | 382d29c | 49 | 65(4/12/49) | 73 | 0 | 约 0.19 秒 |
  | hono | ed1d5f7 | 450 | 571(9/112/450) | 1147 | 5 | 约 1.3 秒 |
  | zod | b1f6ba0 | 522 | 582(9/51/522) | 849 | 1 | 约 1.3 秒 |

  结论:hono 和 zod 超过 300 节点,默认只出 module 层并按 `parentId` 懒加载是必须的。对 T-003 的要求:scanning 默认排除测试、文档、示例和隐藏目录(zod 扫进了 `.claude/skills`),规则公开并重测节点数;资源类 import 只计数不进图;单文件超时和并发写进任务或后续项。三处与后端文档的差异(`srcFileId` 用 `f:<path>`、构造函数接收文件集、全量图由 T-003 投影)按 shared 为准,待架构师确认后同步 `BACKEND_AI_DESIGN.md`。tree-sitter 固定为 0.22.4(0.25.1 在 Node 20 段错误)。
