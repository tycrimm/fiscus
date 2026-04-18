CREATE TABLE `expected_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`direction` text NOT NULL,
	`label` text NOT NULL,
	`account_id` text,
	`illiquid_asset_id` text,
	`owner` text DEFAULT 'joint' NOT NULL,
	`amount_low_cents` integer,
	`amount_expected_cents` integer NOT NULL,
	`amount_high_cents` integer,
	`cadence` text NOT NULL,
	`next_expected_at` integer NOT NULL,
	`ends_at` integer,
	`notes` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`illiquid_asset_id`) REFERENCES `illiquid_assets`(`id`) ON UPDATE no action ON DELETE set null
);
