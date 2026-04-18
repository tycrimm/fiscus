ALTER TABLE `accounts` ADD `owner` text DEFAULT 'joint' NOT NULL;--> statement-breakpoint
ALTER TABLE `illiquid_assets` ADD `owner` text DEFAULT 'joint' NOT NULL;