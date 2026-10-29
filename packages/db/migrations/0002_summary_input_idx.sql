-- 摘要跨 commit 复用的逐节点查询 (repo_id, level, target_id, input_hash) 的复合索引。可重复执行(MariaDB 10.x / MySQL 8.4):
-- 先查 information_schema,已存在则执行 DO 0 空语句;同一连接内用 PREPARE/EXECUTE。
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'summary' AND INDEX_NAME = 'idx_reuse');--> statement-breakpoint
SET @q := IF(@c = 0, 'CREATE INDEX `idx_reuse` ON `summary` (`repo_id`,`level`,`target_id`,`input_hash`)', 'DO 0');--> statement-breakpoint
PREPARE s1 FROM @q;--> statement-breakpoint
EXECUTE s1;--> statement-breakpoint
DEALLOCATE PREPARE s1;
