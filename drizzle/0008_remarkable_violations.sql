ALTER TABLE `investments` ADD `funded_at` integer;--> statement-breakpoint
-- Backfill existing rows: prior tranches are by definition funded — we only
-- just introduced the pending/uncalled concept. funded_at = entry_date.
UPDATE `investments` SET `funded_at` = `entry_date` WHERE `funded_at` IS NULL;--> statement-breakpoint
-- Re-NULL the two pending allocations recorded earlier today before the
-- column existed (Attotude Series C, IRIS convertible note).
UPDATE `investments` SET `funded_at` = NULL WHERE `id` IN (
  '8d47660f-b2f8-4780-a6ad-ff15f12dc4a3',
  '7e2504d6-b476-482f-bd66-7f2f09692fac'
);
