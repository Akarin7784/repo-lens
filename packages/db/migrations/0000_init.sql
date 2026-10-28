CREATE TABLE `analysis_task` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`job_id` varchar(64) NOT NULL,
	`repo_id` bigint NOT NULL,
	`commit_sha` char(40),
	`stage` enum('queued','cloning','scanning','parsing','graph_ready','summarizing','embedding','done','failed') DEFAULT 'queued',
	`progress` tinyint DEFAULT 0,
	`error_code` varchar(64),
	`error_msg` varchar(1024),
	`attempts` int DEFAULT 0,
	`stats` json,
	`started_at` datetime,
	`finished_at` datetime,
	CONSTRAINT `analysis_task_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_job` UNIQUE(`job_id`),
	CONSTRAINT `uk_repo_commit` UNIQUE(`repo_id`,`commit_sha`)
);
--> statement-breakpoint
CREATE TABLE `chat_message` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`session_id` bigint NOT NULL,
	`role` enum('user','assistant') NOT NULL,
	`content` mediumtext,
	`citations` json,
	`dropped_citations` int DEFAULT 0,
	`retrieval_ids` json,
	`latency_ms` int,
	`created_at` datetime DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `chat_message_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `chat_session` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`repo_id` bigint NOT NULL,
	`user_key` varchar(64),
	`title` varchar(255),
	`created_at` datetime DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `chat_session_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `edge` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`repo_id` bigint NOT NULL,
	`commit_sha` char(40) NOT NULL,
	`level` enum('file','module','dir','symbol') NOT NULL,
	`type` enum('imports','calls','contains') NOT NULL,
	`kind` enum('static','dynamic','type-only','re-export','require'),
	`src_id` varchar(255) NOT NULL,
	`dst_id` varchar(255) NOT NULL,
	`src_file_id` bigint,
	`weight` int DEFAULT 1,
	`confidence` decimal(3,2) DEFAULT '1.00',
	CONSTRAINT `edge_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `file` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`repo_id` bigint NOT NULL,
	`commit_sha` char(40) NOT NULL,
	`path` varchar(1024) NOT NULL,
	`path_hash` char(40) NOT NULL,
	`lang` varchar(16),
	`loc` int,
	`content_hash` char(64),
	`module_id` varchar(255),
	`dir_path` varchar(1024),
	`external_deps` json,
	CONSTRAINT `file_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_path` UNIQUE(`repo_id`,`commit_sha`,`path_hash`)
);
--> statement-breakpoint
CREATE TABLE `llm_usage` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`repo_id` bigint,
	`task_id` bigint,
	`session_id` bigint,
	`purpose` enum('summary','embed','chat','rerank','verify') NOT NULL,
	`model` varchar(64),
	`tokens_in` int,
	`tokens_out` int,
	`cost_micro_usd` int,
	`cache_hit` tinyint DEFAULT 0,
	`ok` tinyint DEFAULT 1,
	`created_at` datetime DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `llm_usage_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `repo` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`url` varchar(512) NOT NULL,
	`owner` varchar(128),
	`name` varchar(128),
	`default_ref` varchar(128),
	`last_commit` char(40),
	`lang_main` varchar(32),
	`status` enum('new','ready','failed') DEFAULT 'new',
	`is_demo` tinyint DEFAULT 0,
	`created_at` datetime DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `repo_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_url` UNIQUE(`url`)
);
--> statement-breakpoint
CREATE TABLE `summary` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`repo_id` bigint NOT NULL,
	`level` enum('function','file','dir','repo') NOT NULL,
	`target_id` varchar(255) NOT NULL,
	`input_hash` char(64) NOT NULL,
	`model` varchar(64),
	`content` text,
	`tokens_in` int,
	`tokens_out` int,
	`created_at` datetime DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `summary_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_target` UNIQUE(`repo_id`,`level`,`target_id`)
);
--> statement-breakpoint
CREATE TABLE `symbol` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`repo_id` bigint NOT NULL,
	`file_id` bigint NOT NULL,
	`name` varchar(255) NOT NULL,
	`kind` enum('function','class','method','interface','type','var'),
	`start_line` int,
	`end_line` int,
	`exported` tinyint,
	`signature` varchar(1024),
	`parent_symbol_id` bigint,
	CONSTRAINT `symbol_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_repo` ON `analysis_task` (`repo_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_session` ON `chat_message` (`session_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_user` ON `chat_session` (`user_key`,`id`);--> statement-breakpoint
CREATE INDEX `idx_src` ON `edge` (`repo_id`,`commit_sha`,`level`,`src_id`);--> statement-breakpoint
CREATE INDEX `idx_dst` ON `edge` (`repo_id`,`commit_sha`,`level`,`dst_id`);--> statement-breakpoint
CREATE INDEX `idx_srcfile` ON `edge` (`src_file_id`);--> statement-breakpoint
CREATE INDEX `idx_hash` ON `file` (`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_repo_time` ON `llm_usage` (`repo_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_day` ON `llm_usage` (`created_at`,`purpose`);--> statement-breakpoint
CREATE INDEX `idx_input` ON `summary` (`input_hash`);--> statement-breakpoint
CREATE INDEX `idx_file` ON `symbol` (`file_id`);--> statement-breakpoint
CREATE INDEX `idx_name` ON `symbol` (`repo_id`,`name`);