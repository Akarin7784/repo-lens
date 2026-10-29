-- T-211c:summary 按 commit 存,新增 source。可重复执行(MariaDB 10.x / MySQL 8.4):
-- 每步先查 information_schema,已完成则执行 DO 0 空语句;同一连接内用 PREPARE/EXECUTE。
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'summary' AND COLUMN_NAME = 'commit_sha');--> statement-breakpoint
SET @q := IF(@c = 0, 'ALTER TABLE `summary` ADD `commit_sha` char(40) NOT NULL DEFAULT '''' AFTER `target_id`', 'DO 0');--> statement-breakpoint
PREPARE s1 FROM @q;--> statement-breakpoint
EXECUTE s1;--> statement-breakpoint
DEALLOCATE PREPARE s1;--> statement-breakpoint
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'summary' AND COLUMN_NAME = 'source');--> statement-breakpoint
SET @q := IF(@c = 0, 'ALTER TABLE `summary` ADD `source` enum(''llm'',''rule'') NOT NULL DEFAULT ''llm'' AFTER `model`', 'DO 0');--> statement-breakpoint
PREPARE s2 FROM @q;--> statement-breakpoint
EXECUTE s2;--> statement-breakpoint
DEALLOCATE PREPARE s2;--> statement-breakpoint
-- 回填:旧行归到仓库 last_commit;规则摘要 source=rule(只改未回填的行,重复执行无副作用)
UPDATE `summary` s JOIN `repo` r ON r.`id` = s.`repo_id` SET s.`commit_sha` = r.`last_commit` WHERE s.`commit_sha` = '' AND r.`last_commit` IS NOT NULL;--> statement-breakpoint
UPDATE `summary` SET `source` = 'rule' WHERE `model` = 'rule' AND `source` <> 'rule';--> statement-breakpoint
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'summary' AND INDEX_NAME = 'uk_target_commit');--> statement-breakpoint
SET @q := IF(@c = 0, 'ALTER TABLE `summary` ADD CONSTRAINT `uk_target_commit` UNIQUE(`repo_id`,`level`,`target_id`,`commit_sha`)', 'DO 0');--> statement-breakpoint
PREPARE s3 FROM @q;--> statement-breakpoint
EXECUTE s3;--> statement-breakpoint
DEALLOCATE PREPARE s3;--> statement-breakpoint
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'summary' AND INDEX_NAME = 'uk_target');--> statement-breakpoint
SET @q := IF(@c > 0, 'ALTER TABLE `summary` DROP INDEX `uk_target`', 'DO 0');--> statement-breakpoint
PREPARE s4 FROM @q;--> statement-breakpoint
EXECUTE s4;--> statement-breakpoint
DEALLOCATE PREPARE s4;
