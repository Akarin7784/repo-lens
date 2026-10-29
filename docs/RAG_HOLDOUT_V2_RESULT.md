# holdout v2 运行结果(zod)

- 运行时间:2026-10-29 18:43:15 (Asia/Shanghai),只运行一次,未使用 `--force`
- main 提交:`8db5d0dc0de0860287c2163e05a6c67523591a25`(干净 worktree,`pnpm install --frozen-lockfile` 与 `pnpm build --force` 通过)
- zod 提交:`b1f6ba06c5de0e600640917615e5df70fa73f060`;运行前 `git -C zod-v2 status --porcelain` 输出为空(`porcelain=[]`)
- chunker=2,embed-text=1,模型 `Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78`,提示词 rw-3
- digest:`9bfb5fa19046676dbbfe87bf586edddfce129ea1b7e4473dc913fa19fa2f4d6b`,块数 2991(向量为预分析时生成,digest 匹配复用)
- llm:deepseek / deepseek-flash(改写调用 10 次,803 µUSD)
- 开跑前预检:用调参集「中1」经同一 `rewriteQuery` 做了一次真实 DeepSeek 调用,`used=true`,82 µUSD;预算配置 `DAILY_LLM_BUDGET_CENTS`=500、`LLM_TASK_BUDGET_CENTS`=30(默认值),脚本内网关日预算 100 美分
- 口径:前 5 是前 5 个**切块**而非前 5 个文件,同一文件多个切块各占一位,与调参集一致;按完整路径判定,v3 路径不算
- 判定线:前 5 ≥7/10 且首位 ≥4/10
- 输出说明:`EVAL group V` 行里的「仅向量(原问题,无改写)基线」在 v2 分支中未被累加(脚本缺陷),其 0/10 不是实测值,不应引用

## 按题汇总(从输出提取)

| 题 | hit5 | top1 | 首个命中名次 |
|---|---|---|---|
| V1 | 1 | 0 | 3 |
| V2 | 0 | 0 | 无 |
| V3 | 1 | 1 | 1 |
| V4 | 1 | 1 | 1 |
| V5 | 1 | 0 | 2 |
| V6 | 0 | 0 | 无 |
| V7 | 0 | 0 | 无 |
| V8 | 0 | 0 | 无 |
| V9 | 1 | 1 | 1 |
| V10 | 0 | 0 | 无 |

总计:前 5 5/10,首位 3/10。判定:**未达线**。

## 脚本原样输出

```text
EVAL versions chunker=2 embedText=1 model=Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78 prompt=rw-3 digest=9bfb5fa19046
EVAL vectors reused (digest match)
EVAL v2 start main=8db5d0dc0de0860287c2163e05a6c67523591a25 zod=b1f6ba06c5de0e600640917615e5df70fa73f060 chunks=2991 chunker=2 embedText=1 model=Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78 prompt=rw-3 digest=9bfb5fa19046676dbbfe87bf586edddfce129ea1b7e4473dc913fa19fa2f4d6b llm=deepseek/deepseek-flash
EVAL V1 hit5=1 top1=0 firstHitRank=3 retrieval=hybrid rewrite=used q="邮箱格式的正则是在哪里定义的?" rw="email regex regular expression validateEmail EmailValidator pattern"
   want: packages/zod/src/v4/core/regexes.ts
   1. packages/zod/src/v3/types.ts:617-617 emailRegex [vector,keyword]
   2. packages/zod/src/v4/core/schemas.ts:500-506 $ZodEmail [vector,keyword]
   3. packages/zod/src/v4/core/regexes.ts:52-53 rfc5322Email [vector,keyword] ✓
   4. packages/zod/src/v4/core/regexes.ts:59-60 browserEmail [vector,keyword] ✓
   5. packages/zod/src/v4/core/regexes.ts:48-49 html5Email [vector,keyword] ✓
EVAL V2 hit5=0 top1=0 firstHitRank=无 retrieval=hybrid rewrite=used q="默认的英文报错文案(比如“太短”“类型不对”)是在哪里写的?" rw="validation error errors message default messages validator ValidationError too short invalid type"
   want: packages/zod/src/v4/locales/en.ts
   1. packages/zod/src/v3/ZodError.ts:152-168 ZodIssueOptionalMessage [vector,keyword]
   2. packages/zod/src/v3/ZodError.ts:111-114 ZodInvalidStringIssue [vector,keyword]
   3. packages/zod/src/v4/core/errors.ts:182-193 $ZodIssue [vector,keyword]
   4. packages/zod/src/v3/types.ts:1042-1048 ZodString._regex [vector,keyword]
   5. packages/zod/src/v3/ZodError.ts:88-109 StringValidation [vector,keyword]
EVAL V3 hit5=1 top1=1 firstHitRank=1 retrieval=hybrid rewrite=used q="把字符串自动转换成数字或日期这种“强制转换”是在哪里实现的?" rw="coercion coerce type conversion cast string number date Coercion castValue convertType"
   want: packages/zod/src/v4/classic/coerce.ts ; packages/zod/src/v4/core/api.ts
   1. packages/zod/src/v4/classic/coerce.ts:10-12 number [vector,keyword] ✓
   2. packages/zod/src/v4/core/api.ts:861-870 _coercedDate [vector,keyword] ✓
   3. packages/zod/src/v4/core/api.ts:625-632 _coercedNumber [vector,keyword] ✓
   4. packages/zod/src/v4/classic/coerce.ts:24-24 ZodCoercedDate [vector,keyword] ✓
   5. packages/zod/src/v4/classic/coerce.ts:25-27 date [vector,keyword] ✓
EVAL V4 hit5=1 top1=1 firstHitRank=1 retrieval=hybrid rewrite=used q="把校验规则导出成 JSON Schema 的功能在哪?" rw="validation rule rules validator Validator export JSON Schema toJSONSchema"
   want: packages/zod/src/v4/core/json-schema-processors.ts ; packages/zod/src/v4/core/to-json-schema.ts ; packages/zod/src/v4/core/json-schema-generator.ts
   1. packages/zod/src/v4/core/json-schema-processors.ts:886-934 toJSONSchema [keyword,exact] ✓
   2. packages/zod/src/v4/core/schemas.ts:1150-1167 $ZodCreditCard [vector,keyword]
   3. packages/zod/src/v4/core/json-schema.ts:45-45 _JSONSchema [vector,keyword]
   4. packages/zod/src/v4/core/to-json-schema.ts:84-86 RegistryToJSONSchemaParams [vector,keyword] ✓
   5. packages/zod/src/v4/core/to-json-schema.ts:79-79 ToJSONSchemaParams [vector,keyword] ✓
EVAL V5 hit5=1 top1=0 firstHitRank=2 retrieval=hybrid rewrite=used q="调用 parse 校验失败后,是怎么把问题收集起来并抛出错误的?" rw="parse validation validate error errors collect collectErrors throw ValidationError"
   want: packages/zod/src/v4/core/parse.ts ; packages/zod/src/v4/core/errors.ts
   1. packages/zod/src/v3/types.ts:87-108 handleResult [vector,keyword]
   2. packages/zod/src/v4/core/parse.ts:137-149 validate [vector,keyword] ✓
   3. packages/zod/src/v4/core/schemas.ts:17-26 ParseContext [vector,keyword]
   4. packages/zod/src/v3/types.ts:2959-2984 handleResults [vector,keyword]
   5. packages/zod/src/v4/core/parse.ts:151-172 validateFallback [vector,keyword] ✓
EVAL V6 hit5=0 top1=0 firstHitRank=无 retrieval=hybrid rewrite=used q="一条报错最终显示哪条消息,是按什么优先级决定的(自定义消息、全局配置、语言包)?" rw="error message messages errorMessage priority precedence custom global config locale language pack resolve"
   want: packages/zod/src/v4/core/util.ts
   1. packages/zod/src/v4/classic/schemas.ts:14-16 _ensureDefaultLocale [vector,keyword]
   2. packages/zod/src/v3/helpers/parseUtil.ts:6-41 makeIssue [vector,keyword]
   3. packages/zod/src/v4/core/core.ts:192-208 $ZodConfig [vector,keyword]
   4. packages/zod/src/v3/types.ts:123-143 processCreateParams [vector,keyword]
   5. packages/zod/src/v4/classic/compat.ts:44-48 setErrorMap [vector,keyword]
EVAL V7 hit5=0 top1=0 firstHitRank=无 retrieval=hybrid rewrite=used q="先校验再转换、再接着校验这种管道链式处理是怎么执行的?" rw="validation validate validator Validation transform transformer Transform pipeline chain chainable execute"
   want: packages/zod/src/v4/core/schemas.ts
   1. packages/zod/src/v4/core/parse.ts:137-149 validate [vector,keyword]
   2. packages/zod/src/v4/core/compile.ts:2187-2220 generatePipeCheck [vector,keyword]
   3. packages/tsc/generate.ts:184-197 GenerateExtendChainParams [vector,keyword]
   4. packages/zod/src/v4/core/compile.ts:783-908 generateStringFormatCheck [vector,keyword]
   5. packages/zod/src/v4/core/parse.ts:174-178 $ValidateAsync [vector,keyword]
EVAL V8 hit5=0 top1=0 firstHitRank=无 retrieval=hybrid rewrite=used q="根据某个字段的值区分不同对象类型的联合类型,是怎么快速选中分支的?" rw="discriminated union tagged union discriminant field type narrowing switch branch select"
   want: packages/zod/src/v4/core/schemas.ts
   1. packages/zod/src/v4/core/compile.ts:1864-1913 generateDiscriminatedUnionCheck [vector,keyword]
   2. packages/zod/src/v3/types.ts:5074-5074 discriminatedUnionType [vector,keyword]
   3. packages/zod/src/v4/classic/schemas.ts:1843-1858 discriminatedUnion [vector,keyword]
   4. packages/zod/src/v4/core/api.ts:1270-1285 _discriminatedUnion [vector,keyword]
   5. packages/zod/src/v4/mini/schemas.ts:1190-1204 discriminatedUnion [vector,keyword]
EVAL V9 hit5=1 top1=1 firstHitRank=1 retrieval=hybrid rewrite=used q="给 schema 附加描述、示例这类元数据是怎么存放和查询的?" rw="schema metadata meta attach description example store query SchemaMeta getMetadata"
   want: packages/zod/src/v4/core/registries.ts
   1. packages/zod/src/v4/core/registries.ts:79-85 JSONSchemaMeta [vector,keyword] ✓
   2. packages/zod/src/v4/core/json-schema-generator.ts:51-54 JSONSchemaGenerator.metadataRegistry [vector,keyword]
   3. packages/zod/src/v4/core/api.ts:1758-1768 meta [vector,keyword]
   4. packages/zod/src/v4/core/registries.ts:60-72 $ZodRegistry.get [vector,keyword] ✓
   5. packages/zod/src/v4/mini/schemas.ts:1918-1918 meta [vector,keyword]
EVAL V10 hit5=0 top1=0 firstHitRank=无 retrieval=hybrid rewrite=used q="这个库内部的类型实例是怎么构造和做类型判断的(类似 instanceof 的机制)?" rw="type instance construct type check instanceof Type Instance isInstanceOf typeOf constructor"
   want: packages/zod/src/v4/core/core.ts
   1. packages/zod/src/v4/classic/schemas.ts:2850-2861 ZodInstanceOf [vector,keyword]
   2. packages/zod/src/v3/types.ts:5049-5055 instanceOfType [vector,keyword]
   3. packages/zod/src/v4/classic/schemas.ts:2863-2888 _instanceof [vector,keyword]
   4. packages/zod/src/v4/mini/schemas.ts:1925-1944 _instanceof [vector,keyword]
   5. packages/zod/src/v4/classic/schemas.ts:2843-2849 ZodInstanceOf [vector,keyword]
EVAL group V: top5 5/10 top1 3/10 | 仅向量(原问题,无改写)基线 top5 0/10 top1 0/10
EVAL v2 summary failed=0 main=8db5d0dc0de0860287c2163e05a6c67523591a25 zod=b1f6ba06c5de0e600640917615e5df70fa73f060 chunks=2991 digest=9bfb5fa19046676dbbfe87bf586edddfce129ea1b7e4473dc913fa19fa2f4d6b llm=deepseek/deepseek-flash
EVAL v2 total top5=5/10 top1=3/10 chunks=2991 llm=deepseek rewriteCalls=10 costMicroUsd=803 prompt=rw-3 chunker=2 embedText=1 revision=761b726dd34fb83930e26aab4e9ac3899aa1fa78
```
