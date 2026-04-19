-- Rename illiquid_assets → private_investments and the two FK columns that named it explicitly.
-- SQLite ≥3.25 auto-updates FK references on RENAME TABLE, so fund_details/investments/valuations
-- inherit the new target name without a rebuild.

ALTER TABLE `illiquid_assets` RENAME TO `private_investments`;--> statement-breakpoint
ALTER TABLE `expected_flows` RENAME COLUMN `illiquid_asset_id` TO `private_investment_id`;--> statement-breakpoint
ALTER TABLE `securities` RENAME COLUMN `illiquid_asset_id` TO `private_investment_id`;
