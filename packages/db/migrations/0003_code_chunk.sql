-- T-214:切块元数据表 code_chunk(关键词检索与引用校验的数据源;向量在 Qdrant)。可重复执行(MariaDB 10.x / MySQL 8.4):
-- 先查 information_schema,已存在则执行 DO 0 空语句;同一连接内用 PREPARE/EXECUTE。
-- 与 ARCHITECTURE 原 DDL 的差异:不建 FULLTEXT ngram(MariaDB 无 ngram 解析器),关键词打分在进程内做(BM25,见 packages/rag/src/retrieval.ts)。
SET @t := (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'code_chunk');--> statement-breakpoint
SET @q := IF(@t = 0, 'CREATE TABLE `code_chunk` (`id` bigint AUTO_INCREMENT NOT NULL, `repo_id` bigint NOT NULL, `commit_sha` char(40) NOT NULL, `path` varchar(1024) NOT NULL, `symbol` varchar(255), `start_line` int NOT NULL, `end_line` int NOT NULL, `content` mediumtext NOT NULL, `content_hash` char(64) NOT NULL, `qdrant_point_id` char(36) NOT NULL, `created_at` datetime DEFAULT CURRENT_TIMESTAMP, CONSTRAINT `code_chunk_id` PRIMARY KEY(`id`))', 'DO 0');--> statement-breakpoint
PREPARE s1 FROM @q;--> statement-breakpoint
EXECUTE s1;--> statement-breakpoint
DEALLOCATE PREPARE s1;--> statement-breakpoint
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'code_chunk' AND INDEX_NAME = 'idx_repo_commit');--> statement-breakpoint
SET @q := IF(@c = 0, 'CREATE INDEX `idx_repo_commit` ON `code_chunk` (`repo_id`,`commit_sha`)', 'DO 0');--> statement-breakpoint
PREPARE s2 FROM @q;--> statement-breakpoint
EXECUTE s2;--> statement-breakpoint
DEALLOCATE PREPARE s2;
