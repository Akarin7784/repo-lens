# RAG 中文验收集(holdout)

T-214 的独立验收集。**这些题不参与调参**,调参只用 `/workspace/backend-dev/notes/embedding-bench.md` 里的 12 题(中英各 6)。调参全部结束后只跑一次,结果和 12 题的结果一起写进 `docs/`(另起文档或节,不写在本文件)。本文件只放题目和标准答案,不放任何调参或检索结果;题目定稿后不再改,要改需架构师同意并注明日期。

- 仓库:`honojs/hono` @ `ed1d5f72135ccf7e09c17d64dc4af7588dd3e491`(演示主仓库,与 bench 同一 commit)。
- 判定:取检索结果前 5 条切块;**任一条**切块的文件属于该题「应命中文件」,且(列了符号时)切块范围覆盖或属于所列符号之一,该题记为命中。只命中「可接受」列的不算。
- **达标线:命中题数 ≥ 题数的 2/3,本集 8 题即至少 6 题命中。**
- 文件和符号已在上述 commit 的源码里核对存在。

| # | 题目 | 来源 | 应命中文件 / 符号 | 可接受(不计分) |
|---|---|---|---|---|
| H1 | 中间件是怎么串联执行的? | 演示脚本原题(FRONTEND_DESIGN §9,1:40) | `src/compose.ts` 的 `compose` | `src/hono-base.ts` 的 `#dispatch` |
| H2 | 路由匹配在哪个文件? | 演示脚本原题(同上,定位类追问) | `src/router/smart-router/router.ts` 的 `match`;`src/router/reg-exp-router/router.ts` / `matcher.ts` 的 `match`;`src/router/trie-router/router.ts` 的 `match` | `src/router.ts` 的 `Router` 接口 |
| H3 | 一个请求从进来到返回响应,在 Hono 里经过了哪些步骤? | 演示 1:40 段讲解主流程时的追问(由脚本推出,非原文) | `src/hono-base.ts` 的 `fetch` / `#dispatch`;`src/compose.ts` 的 `compose` | `src/context.ts` 的 `Context` |
| H4 | Hono 默认用的是哪个路由器?为什么要组合多个路由器? | 演示问答环节的定位类追问(由脚本推出,非原文) | `src/hono.ts`(构造函数里的 `SmartRouter` + `RegExpRouter` + `TrieRouter`);`src/router/smart-router/router.ts` | `src/preset/*.ts` |
| H5 | 怎么限制请求体的大小? | 非演示 | `src/middleware/body-limit/index.ts` 的 `bodyLimit` | — |
| H6 | 如何给每个请求生成一个请求 ID? | 非演示 | `src/middleware/request-id/request-id.ts` 的 `requestId` | — |
| H7 | 怎么防御 CSRF 攻击? | 非演示 | `src/middleware/csrf/index.ts` 的 `csrf` | — |
| H8 | 如何自己写一个可复用、带类型的中间件? | 非演示 | `src/helper/factory/index.ts` 的 `createMiddleware` | `src/types.ts` 的 `MiddlewareHandler` |

约束(架构师 2026-10-29 定):
1. 调参和改写提示词(包括其中的示例)里不得出现 H1~H8 的题目原话或其中文关键词组合;一旦出现,这套题不再独立,结果作废。
2. 写结果时 H2 单独列一行,和其余 7 题分开写(其余 7 题的命中数 + H2 是否命中);达标线仍按 8 题合计,前 5 条命中不少于 6 题。

说明:
- 演示脚本中能直接取到的问题只有 H1、H2 两道;H3、H4 是按演示脚本流程推出的追问。8 题中 4 题与演示相关,满足「至少一半」。
- H2 与调参集的「路由参数是怎么解析的」话题相近,但问的是位置而不是解析过程,应命中的符号也不同;架构师已裁定保留 H2(2026-10-29)。
- 所有题目都是纯中文、不含英文术语(CSRF 除外),用来检验「中文改写为英文查询」这条链路。
