# The harness: the map

How a question is answered (`packages/harness/src/ask.ts`, `harness.ts`, `scan.ts`, `trench.ts`, `brain.ts`). Change
this map when the code changes.

## How an answer runs

1. **Kind.** Code reads what the question is about. Regexes come first, then Jev for what they read as unsure. There
   are ten kinds: token, wallet, caller, narrative, defi, prediction, claim, larp, self and general, and at most two per
   question. A follow-up keeps the coin in view (`coinInView`).
2. **Code reads first.** Before the model starts, code reads what that kind always needs (below). The model gets it as
   the scan block (a coin's dossier with each line's level) and the reads block. It never reads those again, except
   narrower. A read still running is named with its arguments, and the model's call with the same arguments joins it.
3. **The model** gets:
   - the system prompt (`harnessSystem`): the first paragraph, how she works, the trench read, what is true, her voice,
     the visual blocks, the hard rules and the reply's form;
   - the status message (the time, and the about text on a question about herself);
   - the plan's playbook: what this kind of answer covers and which function goes deeper on what;
   - the functions offered for this kind, with a limit of calls.

   Four rounds of calls at most; slow searches are leashed once the quick calls of their round are back; the last
   ~50 s of the budget is kept for the write.
4. **After it.** The leak check, function names taken out, the token card's level (the dossier's worst), the
   `clusters` holder map drawn by code from the chain's holder links (`clustermap.ts`: the model only places the fence),
   the redaction guard, the data links behind what the answer used. With no model answer, code's short answer from the
   dossier or the rounds' data (`scanBrief`, `dataBrief`).

## What code reads before the model, by kind

| kind | code reads |
|---|---|
| a coin (token, claim, caller or self with a coin named) | the scan: market (DEX Screener), RugCheck's risk report, authorities, the lp lock, largest holders, the dev. The deep reads: `sol_launch`, `sol_token_origin`, `sol_money_trail` (the dev, when its bag left), `sol_holder_links`, `sol_holder_spread`, `meme_narrative`, `meme_metas`, `ct_calls`, `x_ideas`; and where its wallets were seen before (`walletmem.ts`) |
| narrative | the board: `meme_runners`, `meme_metas`, `x_ideas`, `ct_calls` (narratives), DEX Screener's metas (the hub) |
| larp | the coin's own links first (`project_links`), then at once `github_repo`, `site_age`, `page_snapshot` of its site, `x_account`, the posts on x that test its story, the news of its site, and the transactions its site shows looked up on the chain; code's cross-checks of them (`larp_checks`) |
| any, when it asks what people say | `social_mentions` on its cashtag, Top, the last 7 days |

## The functions offered, by kind

Every kind but self also has the data hub: `hub_find`, `hub_call` and `hub_rpc`.

| kind | calls | functions |
|---|---|---|
| token | 8 | `token_pairs` `dex_pair_lookup` `pool_snapshot` `sol_ticker_mint` `token_risk_flags` `sol_launch` `sol_token_origin` `sol_holder_links` `sol_holder_spread` `sol_largest_accounts` `sol_money_trail` `sol_account_basics` `sol_balance_changes` `meme_narrative` `social_mentions` `news_pages` `call_frontrun` `page_snapshot` |
| wallet | 10 | `sol_account_basics` `sol_money_trail` `sol_balance_changes` `sol_recent_signatures` `sol_asset_card` `sol_token_origin` `sol_launch` `token_pairs` `dex_pair_lookup` |
| caller | 8 | `call_frontrun` `caller_side_wallets` `pump_callouts` `ct_calls` `social_mentions` `sol_money_trail` `sol_launch` `sol_holder_links` `token_risk_flags` `meme_narrative` `token_pairs` `dex_pair_lookup` |
| narrative | 6 | `meme_metas` `meme_runners` `meme_narrative` `x_ideas` `ct_calls` `fresh_pools` (only when new pairs are asked for) `social_mentions` `news_pages` `dex_pair_lookup` `token_pairs` |
| defi | 6 | `protocol_tvl` `top_protocols` `chain_tvl_ranking` `protocol_fees_revenue` `dex_volume_ranking` `yield_pools` `stablecoin_supply` `unlock_schedule` `token_pairs` `dex_pair_lookup` `news_pages` `social_mentions` `page_snapshot` |
| prediction | 4 | `prediction_odds` `news_pages` `social_mentions` `dex_pair_lookup` `token_pairs` |
| claim | 6 | `social_mentions` `news_pages` `page_snapshot` `dex_pair_lookup` `token_pairs` `token_risk_flags` `sol_account_basics` `sol_largest_accounts` `sol_holder_links` `sol_token_origin` `sol_launch` `sol_money_trail` `call_frontrun` `protocol_tvl` `prediction_odds` |
| larp | 10 | `project_links` `github_repo` `site_age` `page_snapshot` `x_account` `social_mentions` `news_pages` `meme_narrative` `x_ideas` `ct_calls` `dex_pair_lookup` `token_pairs` `sol_token_origin` `sol_launch` `sol_money_trail` `sol_balance_changes` |
| self | 4 | `token_pairs` `dex_pair_lookup` `sol_largest_accounts` `sol_holder_links` `news_pages` `social_mentions` (and the about text) |
| general | 6 | `news_pages` `social_mentions` `dex_pair_lookup` `token_pairs` `protocol_tvl` `prediction_odds` `meme_metas` `x_ideas` `page_snapshot` |

A function whose key is not set is not offered: the plan keeps only what the tools layer lists.

## One function a job

- **A coin's market:** `token_pairs` (a known token's totals and pools), `dex_pair_lookup` (a search by name or
  ticker), `pool_snapshot` (one pool's buyers and sellers, real volume or not), `sol_ticker_mint` (the real mint behind
  a ticker).
- **Its safety:** `token_risk_flags` (RugCheck, GoPlus), `sol_lp_lock` (the scan's own: whether its liquidity can be
  pulled).
- **Its launch and dev:** `sol_launch` (bundle, snipers, the dev's buy and what they hold now), `sol_token_origin` (its
  creator and what the creator holds now).
- **Its holders:** `sol_largest_accounts` (the ranked list), `sol_holder_links` (clusters among the top 20 by funder and
  transfers), `sol_holder_spread` (a cabal spread thin past the top).
- **A wallet:** where its money went (`sol_money_trail`), what it is (`sol_account_basics`), its transactions
  (`sol_recent_signatures`, `sol_balance_changes`).
- **Callers:** `call_frontrun` (who bought before one call), `caller_side_wallets` (one caller's pattern across calls),
  `pump_callouts` (pump.fun's own callouts with their times), `ct_calls` (what crypto twitter calls now).
- **What runs:** migrations by story (`meme_metas`), what just ran (`meme_runners`), one coin's story
  (`meme_narrative`), ideas on x before their coins (`x_ideas`), the newest pools (`fresh_pools`).
- **Pages and posts:** `social_mentions` (posts on x), `news_pages` (the web), `page_snapshot` (a page's text, links
  and the addresses it names), `project_links`, `github_repo`, `site_age` and `x_account` (a larp check's).
- **DeFi and odds:** `protocol_tvl`, `top_protocols`, `chain_tvl_ranking`, `protocol_fees_revenue`,
  `dex_volume_ranking`, `yield_pools`, `stablecoin_supply`, `unlock_schedule`, `prediction_odds`.
- **The data hub:** what none of these covers (wallet labels, an evm wallet, order books, funding, bridges) and any of
  153 chains' raw reads (`hub_rpc`).

## Rules that hold across kinds

- **Credit.** Whose data it is is said by its primary site ("dex screener shows"); the chain's reads are on-chain.
- **Functions and internals.** No function's name in an answer, and no internals: servers, keys, vendors.
- **The card.** A coin check ends with the token card code built. Its level is the dossier's worst.
- **Numbers.** Every number comes from the dossier, a function's result or the asker's message, as returned.
- **No advice.** A risk read is never "safe", never a pick, never a price target.
