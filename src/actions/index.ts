import { defineAction, ActionError } from 'astro:actions';
import { z } from 'astro:schema';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { accounts, balanceSnapshots, institutions } from '../db/schema';

const institutionKinds = ['bank', 'brokerage', 'credit_card', 'retirement', 'crypto', 'other'] as const;
const accountKinds = ['checking', 'savings', 'brokerage', 'credit_card', 'retirement', 'crypto', 'loan', 'other'] as const;

export const server = {
  addAccount: defineAction({
    accept: 'form',
    input: z.object({
      institutionName: z.string().trim().min(1, 'Institution name required'),
      institutionKind: z.enum(institutionKinds).default('other'),
      accountName: z.string().trim().min(1, 'Account name required'),
      accountKind: z.enum(accountKinds).default('other'),
      isLiability: z.preprocess((v) => v === 'on' || v === true || v === 'true', z.boolean()).default(false),
      balanceDollars: z.coerce.number().finite(),
    }),
    async handler(input) {
      const d = db(env.DB);
      const normalized = input.institutionName.trim();

      const existing = await d
        .select()
        .from(institutions)
        .where(sql`lower(${institutions.name}) = lower(${normalized})`)
        .limit(1);

      let inst = existing[0];
      if (!inst) {
        const rows = await d.insert(institutions).values({
          name: normalized,
          kind: input.institutionKind,
        }).returning();
        inst = rows[0];
      }
      if (!inst) throw new ActionError({ code: 'INTERNAL_SERVER_ERROR', message: 'Institution upsert failed' });

      const [acct] = await d.insert(accounts).values({
        institutionId: inst.id,
        name: input.accountName.trim(),
        kind: input.accountKind,
        isLiability: input.isLiability,
      }).returning();
      if (!acct) throw new ActionError({ code: 'INTERNAL_SERVER_ERROR', message: 'Account insert failed' });

      await d.insert(balanceSnapshots).values({
        accountId: acct.id,
        balanceCents: Math.round(input.balanceDollars * 100),
        asOf: Math.floor(Date.now() / 1000),
      });

      return { accountId: acct.id };
    },
  }),

  recordBalance: defineAction({
    accept: 'form',
    input: z.object({
      accountId: z.string().min(1),
      balanceDollars: z.coerce.number().finite(),
    }),
    async handler(input) {
      const d = db(env.DB);
      const [acct] = await d.select().from(accounts).where(eq(accounts.id, input.accountId)).limit(1);
      if (!acct) throw new ActionError({ code: 'NOT_FOUND', message: 'Account not found' });
      await d.insert(balanceSnapshots).values({
        accountId: acct.id,
        balanceCents: Math.round(input.balanceDollars * 100),
        asOf: Math.floor(Date.now() / 1000),
      });
      return { ok: true };
    },
  }),
};
