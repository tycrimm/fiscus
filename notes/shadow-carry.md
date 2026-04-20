# Shadow carry — concept to consider

## The gap

`get_net_worth` and every concentration chart in this app track only SBS positions. They ignore carry on the SHV fund's positions — which is a real, untracked economic exposure running alongside every SBS name.

## The structural relationship

SBS and carry are not independent. For a given deal:

- SBS value at multiple M: `1% × GP-check × M`
- Carry at multiple M:     `1% × 25% × (M−1) × Fund-total-check`

Setting them equal:

```
GP-check / Fund-total-check  =  0.25 × (M−1)/M
```

At SHV, the GP typically puts up ~¼ of the fund's check (partner-heavy structure). Under that assumption:

```
Carry / SBS  ≈  (M−1) / M
```

| Multiple | Carry / SBS |
| --- | --- |
| 1× | 0 |
| 2× | 0.50 |
| 5× | 0.80 |
| 10× | 0.90 |
| 14× | 0.93 |

So on big winners, carry approximately doubles the economic exposure. On flat/down names it adds nothing.

## What this implies for the portfolio today

Applying `(M−1)/M` to each SBS position's current mark:

| Name | M | Carry ≈ |
| --- | --- | --- |
| OpenAI | 13.9× | ~$1.44M |
| Aria | 4.3× | ~$408K |
| Celero | 2.3× | ~$153K |
| Attotude | 4.6× | ~$112K |
| Ramp | 1.3× | ~$33K |
| Others (~1× or less) | — | ~$0 |
| **Total** | | **~$2.15M** |

Net worth including shadow carry: ~$6.87M (vs $4.72M tracked). OpenAI exposure goes from ~33% → ~44% of NW. SHV-as-a-platform goes from ~66% → ~76% of NW.

## Caveats — why this isn't just "add it to the balance sheet"

1. **Timing.** SBS can (often) realize via secondary before the fund distributes. Carry only realizes on fund waterfall distributions — hurdle, return-of-capital, potential clawback. Same underlying, very different cash timing.
2. **Cross-portfolio offset.** Losers in the same fund reduce the carry pool. The per-deal numbers above assume deal-by-deal carry attribution, which is a simplification.
3. **Tax shape differs.** Carry is ordinary LTCG through the GP entity and is not QSBS-eligible. SBS *can* be QSBS-eligible for some names, but not all — e.g. OpenAI (via SH Presidio, inherited from IO) is not QSBS.
4. **Not a tracked asset, conceptually.** It's a derived memo number — computed from SBS × `(M−1)/M` — not a thing you can value independently.

## Options for surfacing this (none yet built)

- **Memo column on private-investment detail page.** Next to each SBS name, show `shadow carry ≈ $X` and `total exposure = SBS + shadow`. No schema change needed — pure derived field.
- **Aggregate tile on net worth page.** Tracked NW vs tracked + shadow NW. Makes the concentration story honest.
- **Leave it out.** Memory-only concept; recompute when thinking about a specific name. Cheapest.

No action required — just capturing the idea before it evaporates.
