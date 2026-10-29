# 向量化锁 TTL / 等待上限标定(#60 评审遗留)

测量时间:2026-10-29 16:34–16:58(UTC+8),测速期间没有同时运行其他重任务。

## 条件
- 仓库:honojs/hono @ ed1d5f7,analyzer 切块后共 1434 块
- 模型:Xenova/multilingual-e5-small,fp32,本地 ONNX(transformers.js),batch 16,输入带 `passage: ` 前缀
- 机器:8 核 Linux 测试机;本机没有 docker,无法用 `--cpus` 限核
- 限核方法:用 `taskset -c` 绑核,同时把 ONNX 的 `intraOpNumThreads` 设成与核数相同、`interOpNumThreads=1`;另外用 `process.cpuUsage()` 计算 CPU 秒,并读取 `/proc/self/status` 的 Cpus_allowed_list,确认限核实际生效
- 计时只覆盖 embed 循环,不含模型加载和 analyzer

## 结果
| 配置 | Cpus_allowed | 平均占用核数 | 耗时 (s) | 块/秒 | 峰值 RSS (MB) |
|---|---|---|---|---|---|
| taskset 0 + 1 线程 | 0 | 0.99 | 400.6 | **3.6** | 1555 |
| taskset 0-1 + 2 线程 | 0-1 | 1.95 | 205.7 | 7.0 | 1574 |
| 不限核,默认线程数 | 0-7 | 6.65 | 77.0 | 18.6 | 1647 |

早先「1 核 13.5 块/秒、8 核 12.2 块/秒」那组数据作废:当时只用了 taskset,没有固定线程数,也没有核对实际 CPU 占用;8 核那次还与 tsc 同时运行。

## 结论
- 持有者每 TTL/3 心跳续期,向量化耗时不再受 TTL 限制,所以 TTL 只决定持有者崩溃后多久释放。默认值从 1800 改为 **300 秒**(崩溃后最多阻塞 5 分钟,心跳间隔 100 秒)。
- 等待上限 `EMBEDDING_LOCK_MAX_WAIT_SEC` 默认 **3600 秒**。worker 限 1.5 CPU,保守按单核 3.6 块/秒估算,可覆盖约 1.3 万块(约为 hono 的 9 倍)。超时后本任务 `embeddingStatus=failed`,图与摘要照常可用。
- 未确认:worker 容器内(`cpus: 1.5`)的实际速率;zod 等更大仓库的块数。
