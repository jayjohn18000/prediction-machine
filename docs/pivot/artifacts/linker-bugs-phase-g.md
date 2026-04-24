# Linker Bugs Surfaced During A3 Audit (Phase G Feedback)

_Generated during the 2026-04-23 owner-review pass of the A3 resolution-equivalence audit. All 20 families below were deactivated in `pmci.market_links` (status='removed') and classified `non_equivalent` in `a3-resolution-equivalence-audit.csv`. **Do not act on these during the pivot** — they are feedback for Phase G linker-fix work when the pivot unblocks._

## Summary

20 bilateral sports families were flagged as linker errors during A3 review, not resolution-rules mismatches. All have the same underlying failure mode: the matcher linked markets on **partial participant overlap** (one shared team name) instead of **full-fixture identity**. This produces "families" where the two sides are on different underlying events.

## Failure modes observed

### Mode 1 — per-game moneyline: shared-one-team linker bug (19 families)

Across K-League, Chinese Super League, Brasileirão, Danish Superliga, and MLB, the linker produced bilateral families where Kalshi and Polymarket markets share exactly one team name but have different opponents. Examples:

- **3121, 3122** — Kalshi "A's vs New York Mets" ↔ Polymarket "Athletics vs New York Yankees". (Mets vs Yankees mismatch.)
- **3123, 3126** — Kalshi "Gimcheon Sangmu vs FC Anyang" ↔ Poly "Bucheon vs Gimcheon Sangmu" / "Gwangju vs FC Anyang". (One team shared, other differs.)
- **3124** — Kalshi "Fluminense vs Flamengo" ↔ Poly "Fluminense vs Chapecoense". (Flamengo vs Chapecoense mismatch.)
- **3125** — Kalshi "Randers vs Copenhagen" ↔ Poly "Silkeborg IF vs Randers". (Copenhagen vs Silkeborg mismatch.)
- **3127** — Kalshi "Daejeon Citizen vs Gangwon" ↔ Poly "Gangwon vs FC Seoul". (Daejeon vs FC Seoul mismatch.)
- **3128** — Kalshi "Incheon Utd vs Ulsan HD" ↔ Poly "Ulsan HD vs Daejeon Hana". (Incheon vs Daejeon Hana mismatch.)
- **3129, 3130** — Kalshi "Pohang Steelers vs Jeju SK" ↔ Poly "Jeonbuk vs Pohang" / "Incheon United vs Jeju SK". (Jeju and Pohang respectively share one team with a different opponent.)
- **3131** — Kalshi "Shenzhen Peng City vs Yunnan Yukun" ↔ Poly "Dalian Yingbo vs Yunnan Yukun". (Shenzhen Peng City vs Dalian Yingbo mismatch.)
- **3132, 3133** — Kalshi "Beijing Guoan vs Chengdu Rongcheng" ↔ Poly "Chengdu vs Zhejiang" / "Beijing Guoan vs Tianjin Jinmen Hu". (Each shares one team.)
- **3134** — Kalshi "Tianjin Jinmen Tiger vs Qingdao Hainiu" ↔ Poly "Qingdao Hainiu vs Shandong Taishan". (Tianjin vs Shandong mismatch.)
- **3135** — Kalshi "Shanghai Shenhua vs Shanghai Port" ↔ Poly "Henan vs Shanghai Shenhua". (Shanghai Port vs Henan mismatch.)
- **3136** — Kalshi "Qingdao West Coast vs Liaoning Tieren" ↔ Poly "Shenzhen Xinpengcheng vs Liaoning Tieren". (Qingdao West Coast vs Shenzhen mismatch.)
- **3137** — Kalshi "Chongqing vs Wuhan Three Towns" ↔ Poly "Chongqing vs Qingdao Xihaian". (Wuhan vs Qingdao mismatch.)
- **3138** — Kalshi "Santos vs Atletico Mineiro" ↔ Poly "EC Bahia vs Santos". (Atletico Mineiro vs EC Bahia mismatch.)
- **3139** — Kalshi "Mirassol vs Bahia" ↔ Poly "São Paulo vs Mirassol". (Bahia vs São Paulo mismatch.)

In addition to the fixture mismatch, even where fixtures hypothetically aligned, these are **different market types**: Kalshi is a 2-way moneyline ("Team A wins? Yes/No") while the matched Polymarket side is a binary draw market ("Will the match end in a draw? Yes/No"). These resolve on different questions about the same underlying game and would produce spurious "arb" signals if left in the universe.

### Mode 2 — multi-market parser + linker bug (1 family)

- **3120** — Kalshi "Nashville at Charlotte: Totals" (single umbrella totals market; parser also ate the `: Totals` suffix into `home_team = "Charlotte: Totals"`) linked to **five** distinct Polymarket markets on the same game: Both Teams to Score, O/U 1.5, O/U 2.5, O/U 3.5, O/U 4.5. Game dates off-by-one. Cannot be reconciled to a single bilateral fixture.

## Suggested Phase G investigation order

1. **Tighten participant matching.** The linker appears to treat participant overlap as an OR rather than an AND. A correct fixture identity requires both participants present on both sides.
2. **Normalize team-name aliases before matching.** "A's" ↔ "Athletics"; "New York M" ↔ "New York Mets". Without an alias map, near-misses like Mets/Yankees or Fluminense/Flamengo are indistinguishable to the current matcher.
3. **Guard against many-to-one family explosions.** Family 3120 glommed five Polymarket markets to one Kalshi market. The schema should enforce at most one market per (family, provider) for canonical bilateral pairs, or introduce a `family_kind` discriminator for umbrella-vs-specific markets.
4. **Fix the title parser that wrote `"Charlotte: Totals"` into `home_team`.** Suggests the Kalshi title-parsing path splits on ` at ` without stripping the market-type suffix (`: Totals`, `: Moneyline`, etc.) first.

## Do not act on this during the pivot

Per `docs/pivot/dependency-map.md`, linker/matcher/proposer tuning is out of scope during the backtest pivot. These findings are documented now so that when the pivot unblocks (GREEN or YELLOW decision per the success rubric), Phase G has a clean starting-point without re-diagnosing.
