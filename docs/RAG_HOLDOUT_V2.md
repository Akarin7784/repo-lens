# RAG 验收题 holdout v2（中文）

> **冻结声明(面试助手,2026-10-29 17:3x Asia/Shanghai):** 本文件在后端对 zod 做任何调参之前提交,提交后题目不再修改;要改需架构师同意并在此注明日期。题目全文来自绿色三角形,未改动内容(仅排版)。
>
> **出题人如实说明:** 13 个参考文件都确认存在;V2、V3、V6、V7、V8 读过实现;V1、V4、V5、V9、V10 只确认了符号定义位置,没细读函数体;V4 的 `to-json-schema.ts` 和 `json-schema-generator.ts` 只确认文件存在,属备选。V1、V3、V4 的中文说法与文件名关键词对得比较直接,偏容易,区分度不高,但保留(演示也会这样问)。
>
> **验收规则(架构师 2026-10-29 补充,题目文字不变):**
>
> 1. 通过线:前 5 命中至少 7/10,首位命中至少 4/10。V1、V3、V4 偏容易,所以不放低。
> 2. 命中按完整路径比对,不按文件名;zod 的 v3 与 v4 有同名文件,v3 路径一律不算命中。
> 3. 只在后端归因和调参结束、改动已提交以后跑一次 v2,结果不论好坏都原样写进 docs,不再调参。不达标则进入外部 embedding 决策,由架构师处理。评测用的 zod 固定在上述 commit,预分析也在这个 commit 上跑。


- 仓库:https://github.com/colinhacks/zod
- Commit:`b1f6ba06c5de0e600640917615e5df70fa73f060`(所有路径和符号都已在这个 commit 核对)
- 出题日期:2026-10-29(Asia/Shanghai)
- 出题人:绿色三角形(未看过 repo-lens 的评测代码和题目)
- 范围:只考 v4(`packages/zod/src/v4/`);v3 的同名实现不算命中
- 命中判定:前 5 个检索结果里有任一参考文件就算命中(文件级)。首位命中单独统计。符号只作参考,不计分。
- 使用规则:先冻结题目再调参;这套题只跑一次,跑完不再用来调参。

| 编号 | 类型 | 问题 | 参考文件(任一命中即可) | 参考符号 | 理由 |
|---|---|---|---|---|---|
| V1 | 定位 | 邮箱格式的正则是在哪里定义的? | `packages/zod/src/v4/core/regexes.ts` | `email` | 所有内置字符串格式的正则都集中定义在这里 |
| V2 | 定位 | 默认的英文报错文案(比如“太短”“类型不对”)是在哪里写的? | `packages/zod/src/v4/locales/en.ts` | `too_small` 分支 / `Invalid input: expected` | 英文 locale 按 issue code 生成默认消息 |
| V3 | 定位 | 把字符串自动转换成数字或日期这种“强制转换”是在哪里实现的? | `packages/zod/src/v4/classic/coerce.ts`;`packages/zod/src/v4/core/api.ts` | `_coercedNumber` | classic 层暴露入口,core/api 里构造 coerce 标记 |
| V4 | 定位 | 把校验规则导出成 JSON Schema 的功能在哪? | `packages/zod/src/v4/core/json-schema-processors.ts`;`packages/zod/src/v4/core/to-json-schema.ts`;`packages/zod/src/v4/core/json-schema-generator.ts` | `toJSONSchema` | 入口函数和各类型的转换处理器都在这几个文件 |
| V5 | 流程 | 调用 parse 校验失败后,是怎么把问题收集起来并抛出错误的? | `packages/zod/src/v4/core/parse.ts`;`packages/zod/src/v4/core/errors.ts` | `_parse`、`$ZodError` | parse 运行 schema 收集 issues 后构造错误对象并抛出 |
| V6 | 流程 | 一条报错最终显示哪条消息,是按什么优先级决定的(自定义消息、全局配置、语言包)? | `packages/zod/src/v4/core/util.ts` | `finalizeIssue` | 依次尝试 issue 自带消息、schema/ctx 的 error、全局 customError、localeError |
| V7 | 流程 | 先校验再转换、再接着校验这种管道链式处理是怎么执行的? | `packages/zod/src/v4/core/schemas.ts` | `$ZodPipe`、`$ZodTransform` | pipe 先跑 in 再把结果交给 out,transform 在这里定义 |
| V8 | 概念 | 根据某个字段的值区分不同对象类型的联合类型,是怎么快速选中分支的? | `packages/zod/src/v4/core/schemas.ts` | `$ZodDiscriminatedUnion` | 用各分支的 propValues 建立判别值到分支的查找表 |
| V9 | 概念 | 给 schema 附加描述、示例这类元数据是怎么存放和查询的? | `packages/zod/src/v4/core/registries.ts` | `$ZodRegistry`、`globalRegistry` | 注册表把元数据映射到 schema,全局注册表挂在 globalThis |
| V10 | 概念 | 这个库内部的类型实例是怎么构造和做类型判断的(类似 instanceof 的机制)? | `packages/zod/src/v4/core/core.ts` | `$constructor`、`_zod.traits` | $constructor 用 traits 集合实现初始化和 instanceof 判断 |
