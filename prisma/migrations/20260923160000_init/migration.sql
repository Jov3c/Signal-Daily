-- CreateTable
CREATE TABLE `users` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(255) NULL,
    `display_name` VARCHAR(120) NULL,
    `avatar_url` VARCHAR(1024) NULL,
    `role` ENUM('USER', 'ADMIN') NOT NULL DEFAULT 'USER',
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `provider` VARCHAR(40) NOT NULL,
    `provider_account_id` VARCHAR(255) NOT NULL,
    `access_token_encrypted` TEXT NULL,
    `refresh_token_encrypted` TEXT NULL,
    `expires_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `auth_accounts_user_id_idx`(`user_id`),
    UNIQUE INDEX `auth_accounts_provider_provider_account_id_key`(`provider`, `provider_account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `email_otp_codes` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(255) NOT NULL,
    `code_hash` VARCHAR(128) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `request_ip_hash` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `email_otp_codes_email_expires_at_idx`(`email`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `refresh_token_hash` VARCHAR(128) NOT NULL,
    `user_agent_hash` VARCHAR(128) NULL,
    `ip_hash` VARCHAR(128) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sessions_refresh_token_hash_key`(`refresh_token_hash`),
    INDEX `sessions_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_preferences` (
    `user_id` BIGINT UNSIGNED NOT NULL,
    `theme` ENUM('LIGHT', 'DARK', 'SYSTEM') NOT NULL DEFAULT 'SYSTEM',
    `article_font_size` ENUM('SMALL', 'DEFAULT', 'LARGE') NOT NULL DEFAULT 'DEFAULT',
    `default_translation` BOOLEAN NOT NULL DEFAULT false,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sources` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `type` ENUM('RSS', 'X_USER', 'GITHUB_REPO', 'HACKER_NEWS', 'HUGGINGFACE', 'MANUAL_URL') NOT NULL,
    `kind` ENUM('OFFICIAL', 'PERSON', 'MEDIA', 'COMMUNITY', 'DEVELOPER', 'GOVERNMENT', 'TREND') NOT NULL,
    `tier` ENUM('S', 'A', 'B', 'C') NOT NULL DEFAULT 'B',
    `official` BOOLEAN NOT NULL DEFAULT false,
    `base_url` VARCHAR(2048) NULL,
    `feed_url` VARCHAR(2048) NULL,
    `external_id` VARCHAR(255) NULL,
    `language` CHAR(5) NULL,
    `priority` TINYINT NOT NULL DEFAULT 50,
    `trust_score` DECIMAL(4, 1) NOT NULL DEFAULT 7.0,
    `fetch_interval_seconds` INTEGER NOT NULL DEFAULT 1800,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `config` JSON NULL,
    `last_fetched_at` DATETIME(3) NULL,
    `next_fetch_at` DATETIME(3) NULL,
    `last_success_at` DATETIME(3) NULL,
    `last_error_at` DATETIME(3) NULL,
    `last_error_code` VARCHAR(120) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sources_slug_key`(`slug`),
    INDEX `sources_enabled_next_fetch_at_idx`(`enabled`, `next_fetch_at`),
    INDEX `sources_type_enabled_idx`(`type`, `enabled`),
    INDEX `sources_kind_tier_enabled_idx`(`kind`, `tier`, `enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `people` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `x_handle` VARCHAR(255) NULL,
    `avatar_url` VARCHAR(2048) NULL,
    `bio` TEXT NULL,
    `category` VARCHAR(120) NULL,
    `verified_source` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `people_slug_key`(`slug`),
    UNIQUE INDEX `people_x_handle_key`(`x_handle`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `topics` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `topics_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `raw_items` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `source_id` BIGINT UNSIGNED NOT NULL,
    `external_id` VARCHAR(512) NULL,
    `original_url` VARCHAR(2048) NOT NULL,
    `canonical_url` VARCHAR(2048) NOT NULL,
    `canonical_url_hash` CHAR(64) NOT NULL,
    `title_raw` TEXT NULL,
    `body_raw` LONGTEXT NULL,
    `payload` JSON NULL,
    `language` CHAR(5) NULL,
    `published_at` DATETIME(3) NULL,
    `fetched_at` DATETIME(3) NOT NULL,
    `content_hash` CHAR(64) NULL,
    `status` ENUM('FETCHED', 'NORMALIZED', 'DUPLICATE', 'READY_FOR_ANALYSIS', 'FAILED') NOT NULL,
    `failure_code` VARCHAR(120) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `raw_items_source_id_external_id_idx`(`source_id`, `external_id`),
    INDEX `raw_items_canonical_url_hash_idx`(`canonical_url_hash`),
    INDEX `raw_items_content_hash_idx`(`content_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `canonical_title` VARCHAR(500) NOT NULL,
    `summary` TEXT NULL,
    `primary_content_id` BIGINT UNSIGNED NULL,
    `status` VARCHAR(40) NOT NULL,
    `first_seen_at` DATETIME(3) NOT NULL,
    `last_seen_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `events_last_seen_at_idx`(`last_seen_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `event_evidence` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `event_id` BIGINT UNSIGNED NOT NULL,
    `content_id` BIGINT UNSIGNED NULL,
    `source_id` BIGINT UNSIGNED NULL,
    `evidence_type` ENUM('PRIMARY_SOURCE', 'OFFICIAL_CONFIRMATION', 'SUPPORTING_SOURCE', 'SOCIAL_CONFIRMATION', 'RELATED_DISCUSSION') NOT NULL,
    `title` VARCHAR(700) NULL,
    `url` VARCHAR(2048) NOT NULL,
    `url_hash` CHAR(64) NOT NULL,
    `published_at` DATETIME(3) NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT false,
    `confidence` DECIMAL(4, 3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `event_evidence_event_id_is_primary_idx`(`event_id`, `is_primary`),
    INDEX `event_evidence_event_id_source_id_idx`(`event_id`, `source_id`),
    INDEX `event_evidence_source_id_published_at_idx`(`source_id`, `published_at`),
    UNIQUE INDEX `event_evidence_event_id_url_hash_key`(`event_id`, `url_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contents` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `source_id` BIGINT UNSIGNED NOT NULL,
    `author_person_id` BIGINT UNSIGNED NULL,
    `event_id` BIGINT UNSIGNED NULL,
    `raw_item_id` BIGINT UNSIGNED NULL,
    `type` ENUM('ARTICLE', 'X_POST', 'GITHUB_REPO', 'GITHUB_RELEASE', 'HN_STORY', 'MODEL', 'SHORT_POST') NOT NULL,
    `title` VARCHAR(700) NOT NULL,
    `summary` TEXT NULL,
    `body_original` LONGTEXT NULL,
    `body_translated` LONGTEXT NULL,
    `language` CHAR(5) NOT NULL,
    `original_url` VARCHAR(2048) NOT NULL,
    `image_url` VARCHAR(2048) NULL,
    `published_at` DATETIME(3) NULL,
    `pipeline_status` ENUM('INGESTED', 'ANALYZING', 'REVIEW_PENDING', 'APPROVED', 'REJECTED', 'ARCHIVED') NOT NULL,
    `importance_score` DECIMAL(4, 1) NULL,
    `novelty_score` DECIMAL(4, 1) NULL,
    `relevance_score` DECIMAL(4, 1) NULL,
    `credibility_score` DECIMAL(4, 1) NULL,
    `density_score` DECIMAL(4, 1) NULL,
    `read_value_score` DECIMAL(4, 1) NULL,
    `final_score` DECIMAL(5, 2) NULL,
    `recommendation_reason` TEXT NULL,
    `ai_analysis` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `contents_raw_item_id_key`(`raw_item_id`),
    INDEX `contents_pipeline_status_final_score_published_at_idx`(`pipeline_status`, `final_score`, `published_at`),
    INDEX `contents_source_id_published_at_idx`(`source_id`, `published_at`),
    INDEX `contents_event_id_idx`(`event_id`),
    FULLTEXT INDEX `contents_title_summary_body_translated_idx`(`title`, `summary`, `body_translated`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `content_topics` (
    `content_id` BIGINT UNSIGNED NOT NULL,
    `topic_id` BIGINT UNSIGNED NOT NULL,
    `confidence` DECIMAL(4, 3) NOT NULL,

    PRIMARY KEY (`content_id`, `topic_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `event_contents` (
    `event_id` BIGINT UNSIGNED NOT NULL,
    `content_id` BIGINT UNSIGNED NOT NULL,
    `relation` VARCHAR(20) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `event_contents_content_id_key`(`content_id`),
    PRIMARY KEY (`event_id`, `content_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `editorial_reviews` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `content_id` BIGINT UNSIGNED NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'DEFERRED') NOT NULL DEFAULT 'PENDING',
    `publish_featured` BOOLEAN NOT NULL DEFAULT false,
    `include_daily_candidate` BOOLEAN NOT NULL DEFAULT false,
    `admin_note` TEXT NULL,
    `reviewed_by_user_id` BIGINT UNSIGNED NULL,
    `reviewed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `editorial_reviews_content_id_key`(`content_id`),
    INDEX `editorial_reviews_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `featured_items` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `content_id` BIGINT UNSIGNED NOT NULL,
    `custom_title` VARCHAR(700) NULL,
    `custom_summary` TEXT NULL,
    `sort_weight` INTEGER NOT NULL DEFAULT 0,
    `published_at` DATETIME(3) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `featured_items_content_id_key`(`content_id`),
    INDEX `featured_items_active_published_at_idx`(`active`, `published_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `daily_editions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `business_date` DATE NOT NULL,
    `edition_no` INTEGER NULL,
    `status` ENUM('DRAFT', 'REVIEWING', 'SCHEDULED', 'PUBLISHED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `headline` VARCHAR(700) NULL,
    `scheduled_at` DATETIME(3) NULL,
    `published_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `daily_editions_business_date_key`(`business_date`),
    UNIQUE INDEX `daily_editions_edition_no_key`(`edition_no`),
    INDEX `daily_editions_status_business_date_idx`(`status`, `business_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `daily_sections` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `edition_id` BIGINT UNSIGNED NOT NULL,
    `type` ENUM('FRONT_PAGE', 'AI', 'PRODUCT', 'DEVELOPMENT', 'TECH', 'X_VOICES', 'BRIEFS') NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `sort_order` INTEGER NOT NULL,

    UNIQUE INDEX `daily_sections_edition_id_sort_order_key`(`edition_id`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `daily_items` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `section_id` BIGINT UNSIGNED NOT NULL,
    `content_id` BIGINT UNSIGNED NOT NULL,
    `display_style` ENUM('LEAD', 'MAJOR', 'STANDARD', 'BRIEF') NOT NULL,
    `sort_order` INTEGER NOT NULL,
    `custom_headline` VARCHAR(700) NULL,
    `custom_excerpt` TEXT NULL,

    UNIQUE INDEX `daily_items_section_id_content_id_key`(`section_id`, `content_id`),
    UNIQUE INDEX `daily_items_section_id_sort_order_key`(`section_id`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bookmarks` (
    `user_id` BIGINT UNSIGNED NOT NULL,
    `content_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`user_id`, `content_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reading_progress` (
    `user_id` BIGINT UNSIGNED NOT NULL,
    `resource_type` VARCHAR(30) NOT NULL,
    `resource_id` BIGINT UNSIGNED NOT NULL,
    `progress` DECIMAL(5, 4) NOT NULL,
    `last_position` VARCHAR(255) NULL,
    `completed_at` DATETIME(3) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`user_id`, `resource_type`, `resource_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_runs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `content_id` BIGINT UNSIGNED NULL,
    `task_type` ENUM('LANGUAGE_DETECT', 'TRANSLATE', 'CLASSIFY', 'SCORE', 'DEDUP_VERIFY', 'EVENT_CLUSTER', 'DAILY_DRAFT') NOT NULL,
    `provider` VARCHAR(80) NOT NULL,
    `model` VARCHAR(120) NOT NULL,
    `prompt_version` VARCHAR(80) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED') NOT NULL,
    `input_tokens` INTEGER NULL,
    `output_tokens` INTEGER NULL,
    `estimated_cost_usd` DECIMAL(12, 6) NULL,
    `duration_ms` INTEGER NULL,
    `error_code` VARCHAR(120) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_runs_content_id_task_type_idx`(`content_id`, `task_type`),
    INDEX `ai_runs_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_runs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `job_type` VARCHAR(120) NOT NULL,
    `job_key` VARCHAR(255) NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD') NOT NULL,
    `started_at` DATETIME(3) NOT NULL,
    `finished_at` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `error_code` VARCHAR(120) NULL,
    `metadata` JSON NULL,

    INDEX `job_runs_job_type_status_started_at_idx`(`job_type`, `status`, `started_at`),
    INDEX `job_runs_job_key_idx`(`job_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_notifications` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `type` VARCHAR(80) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `body` TEXT NOT NULL,
    `target_url` VARCHAR(2048) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'UNREAD',
    `email_status` VARCHAR(20) NOT NULL DEFAULT 'NONE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `read_at` DATETIME(3) NULL,

    INDEX `admin_notifications_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `auth_accounts` ADD CONSTRAINT `auth_accounts_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_preferences` ADD CONSTRAINT `user_preferences_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `raw_items` ADD CONSTRAINT `raw_items_source_id_fkey` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_evidence` ADD CONSTRAINT `event_evidence_event_id_fkey` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_evidence` ADD CONSTRAINT `event_evidence_content_id_fkey` FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_evidence` ADD CONSTRAINT `event_evidence_source_id_fkey` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contents` ADD CONSTRAINT `contents_source_id_fkey` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contents` ADD CONSTRAINT `contents_author_person_id_fkey` FOREIGN KEY (`author_person_id`) REFERENCES `people`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contents` ADD CONSTRAINT `contents_event_id_fkey` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contents` ADD CONSTRAINT `contents_raw_item_id_fkey` FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_topics` ADD CONSTRAINT `content_topics_content_id_fkey` FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_topics` ADD CONSTRAINT `content_topics_topic_id_fkey` FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_contents` ADD CONSTRAINT `event_contents_event_id_fkey` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_contents` ADD CONSTRAINT `event_contents_content_id_fkey` FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `editorial_reviews` ADD CONSTRAINT `editorial_reviews_content_id_fkey` FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `featured_items` ADD CONSTRAINT `featured_items_content_id_fkey` FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `daily_sections` ADD CONSTRAINT `daily_sections_edition_id_fkey` FOREIGN KEY (`edition_id`) REFERENCES `daily_editions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `daily_items` ADD CONSTRAINT `daily_items_section_id_fkey` FOREIGN KEY (`section_id`) REFERENCES `daily_sections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `daily_items` ADD CONSTRAINT `daily_items_content_id_fkey` FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bookmarks` ADD CONSTRAINT `bookmarks_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bookmarks` ADD CONSTRAINT `bookmarks_content_id_fkey` FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reading_progress` ADD CONSTRAINT `reading_progress_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_runs` ADD CONSTRAINT `ai_runs_content_id_fkey` FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

