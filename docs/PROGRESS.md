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
| T-001 | Monorepo 脚手架、CI、docker-compose、`packages/shared` 的 zod 类型 | 架构师 | 待开始 | - |
| T-002 | `LanguageAnalyzer` 接口、registry、`TypeScriptAnalyzer` | 后端与AI设计师 | 待开始(依赖 T-001) | - |
| T-003 | API 与 Worker:`POST /api/repos`、任务 SSE、clone 与文件树 | 后端与AI设计师 | 待开始(依赖 T-001) | - |
| T-004 | Web:设计令牌、首页、基于 fixture 的图渲染(React Flow + elkjs) | 前端可视化设计师 | 待开始(依赖 T-001) | - |

## 日志
- 2026-10-29 03:3x:仓库建立,三份设计文档和 Claude 风格规范提交到 `docs/`,拆分第 1 周任务。
