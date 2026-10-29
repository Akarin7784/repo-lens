# RAG 中文验收集(留出集)

T-214 的独立验收集。**不参与调参**;调参只用 [`RAG_TUNING_QUESTIONS.md`](./RAG_TUNING_QUESTIONS.md) 的 12 题。本文件只放题目和标准答案,不放任何调参或检索结果;题目定稿后不再改,要改需架构师同意并注明日期。

- 仓库:`honojs/hono` @ `ed1d5f72135ccf7e09c17d64dc4af7588dd3e491`(演示主仓库,与调参题同一 commit)。
- 判定:取检索结果前 5 条切块;**任一条**切块的文件属于该题「应命中文件」,且(列了符号时)切块范围覆盖或属于所列符号之一,该题记为命中。只命中「可接受」列的不算。
- **达标线:8 题中前 5 条命中不少于 6 题(即三分之二),与 `WEEK2_PLAN.md` D4 一致。**
- 文件和符号已在上述 commit 的源码里核对存在。

## 约束(架构师 2026-10-29 定)

1. 调参和改写提示词(包括其中的示例)里不得出现留出集的题目原话或其中文关键词组合;一旦出现,这套题不再独立,结果作废。
2. 留出集在调参全部结束后只跑一次;结果与调参题结果分开写(另起文档或节,不写在本文件)。
3. 写结果时:8 道留出题合计命中数单独一行,用于达标判定;「演示冒烟题」单独一行,照实写,不计入达标线。

## 留出集(8 题,计入达标线)

| # | 题目 | 来源 | 应命中文件 / 符号 | 可接受(不计分) |
|---|---|---|---|---|
| H1 | 中间件是怎么串联执行的? | 演示脚本原题(FRONTEND_DESIGN §9,1:40) | `src/compose.ts` 的 `compose` | `src/hono-base.ts` 的 `#dispatch` |
| H2 | Context 对象是做什么的? | 演示 1:40 段点开核心文件时的追问(由脚本推出,非原文) | `src/context.ts` 的 `Context` 类 | `src/hono-base.ts` 的 `#dispatch`(创建 Context 处) |
| H3 | 一个请求从进来到返回响应,在 Hono 里经过了哪些步骤? | 演示 1:40 段讲解主流程时的追问(由脚本推出,非原文) | `src/hono-base.ts` 的 `fetch` / `#dispatch`;`src/compose.ts` 的 `compose` | `src/context.ts` 的 `Context` |
| H4 | 中间件之间怎么传递数据? | 接 H1 的演示追问(由脚本推出,非原文) | `src/context.ts` 的 `set` / `get` / `var` | `src/types.ts` 的 `Env` |
| H5 | 怎么限制请求体的大小? | 非演示 | `src/middleware/body-limit/index.ts` 的 `bodyLimit` | — |
| H6 | 如何给每个请求生成一个请求 ID? | 非演示 | `src/middleware/request-id/request-id.ts` 的 `requestId` | — |
| H7 | 怎么防御 CSRF 攻击? | 非演示 | `src/middleware/csrf/index.ts` 的 `csrf` | — |
| H8 | 如何自己写一个可复用、带类型的中间件? | 非演示 | `src/helper/factory/index.ts` 的 `createMiddleware` | `src/types.ts` 的 `MiddlewareHandler` |

## 演示冒烟题(不计入达标线,每次都跑,结果照实写)

| # | 题目 | 来源 | 应命中文件 / 符号 |
|---|---|---|---|
| S1 | 路由匹配在哪个文件? | 演示脚本原题(同上,定位类追问) | `src/router/smart-router/router.ts` 的 `match`;`src/router/reg-exp-router/router.ts` / `matcher.ts` 的 `match`;`src/router/trie-router/router.ts` 的 `match` |

## 说明

- 换题记录(架构师 2026-10-29 改判,采纳面试助手意见):原 H2「路由匹配在哪个文件?」改写成英文后与调参题英 2「where are route parameters matched in the router」几乎是同一问题,也与中 3 同属路由,移为演示冒烟题 S1;原 H4「Hono 默认用的是哪个路由器?为什么要组合多个路由器?」同样落在路由,改写后与英 2 实质重叠,一并换掉。新 H2、H4 都不涉及路由。
- 8 题中 H1~H4 与演示相关(H1 是演示脚本原题,H2~H4 由演示流程推出),满足「至少一半」。
- 与调参题的对照:H2/H4 落在 `src/context.ts`,调参题没有以它为目标的题;H3 与英 4(错误与 not found 处理)同在 `src/hono-base.ts`,但问的是请求主流程而不是错误处理,应命中符号不同(`fetch` / `#dispatch` 与 `compose`,不含 `errorHandler` / `notFoundHandler`)。
