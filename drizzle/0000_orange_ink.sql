CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`institution_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`is_liability` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`plaid_account_id` text,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `balance_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`balance_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`as_of` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fund_details` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`committed_cents` integer DEFAULT 0 NOT NULL,
	`called_cents` integer DEFAULT 0 NOT NULL,
	`distributed_cents` integer DEFAULT 0 NOT NULL,
	`carry_pct` real,
	`carry_vested_pct` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `illiquid_assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`security_id` text NOT NULL,
	`quantity_text` text NOT NULL,
	`value_cents` integer NOT NULL,
	`cost_basis_cents` integer,
	`as_of` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `illiquid_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`notes` text,
	`archived_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `institutions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`plaid_institution_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `investments` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`security_type` text,
	`round_label` text,
	`shares` integer,
	`price_per_share_cents` integer,
	`cost_basis_cents` integer NOT NULL,
	`entry_date` integer NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `illiquid_assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `plaid_items` (
	`id` text PRIMARY KEY NOT NULL,
	`plaid_item_id` text NOT NULL,
	`access_token_encrypted` text NOT NULL,
	`institution_plaid_id` text NOT NULL,
	`institution_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`cursor` text,
	`last_sync_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plaid_items_plaid_item_id_unique` ON `plaid_items` (`plaid_item_id`);--> statement-breakpoint
CREATE TABLE `plaid_sync_log` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`synced_at` integer NOT NULL,
	`kind` text NOT NULL,
	`ok` integer NOT NULL,
	`raw_json` text NOT NULL,
	`error` text,
	FOREIGN KEY (`item_id`) REFERENCES `plaid_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `securities` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`ticker` text,
	`cusip` text,
	`plaid_security_id` text,
	`illiquid_asset_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`illiquid_asset_id`) REFERENCES `illiquid_assets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `securities_plaid_security_id_unique` ON `securities` (`plaid_security_id`);--> statement-breakpoint
CREATE TABLE `valuations` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`investment_id` text,
	`as_of` integer NOT NULL,
	`value_cents` integer NOT NULL,
	`basis` text,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `illiquid_assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`investment_id`) REFERENCES `investments`(`id`) ON UPDATE no action ON DELETE cascade
);
