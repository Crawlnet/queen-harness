# The visual blocks

An answer is markdown. Where a picture says it better, it carries a fenced block: its kind after the opening ```, its
JSON from the next line. A UI draws them; a plain renderer shows them as code. The model is told the same shapes
(`harness.ts` `BLOCKS`); `token` and `clusters` are built by code, the rest by the model from the data it read.

| kind | built by | shape |
|---|---|---|
| `token` | code (`scan.ts` `tokenBlock`), the model adds `verdict.text` | `{"symbol", "name", "chain", "address", "price", "change24h", "mcap", "fdv", "liquidity", "volume24h", "holders", "age", "checks": [{"label", "status": "ok\|warn\|bad\|na", "value"}], "verdict": {"level": "high\|mixed\|low", "text"}, "links": [{"label", "url"}]}` |
| `clusters` | code (`clustermap.ts`): the model writes the fence with `{}` | `{"title", "unit": "pct", "nodes": [{"id", "label", "value", "kind", "note", "url"}], "links": [{"from", "to", "label"}]}`: every holder (its share as `value`), funder and tie from `sol_holder_links` |
| `flow` | the model | `{"title", "nodes": [{"id", "label", "kind", "tag", "url"}], "edges": [{"from", "to", "amount", "count", "time"}], "note"}` |
| `timeline` | the model | `{"title", "events": [{"time", "title", "detail", "kind", "amount", "url"}]}` |
| `chart` | the model | `{"type": "line\|area\|bar", "title", "unit", "x": [...], "series": [{"name", "values"}], "markers": [{"x", "label"}]}` or `{"type": "pie\|bubbles", "title", "unit", "items": [{"label", "value", "kind", "note"}]}` |
| `posts` | the model, verbatim from the posts search | `{"title", "posts": [{"author", "handle", "followers", "text", "time", "url", "likes", "reposts", "replies", "views"}]}` |
| `wallet` | the model | `{"address", "label", "chain", "total", "holdings": [{"asset", "value", "pct"}], "pnl": {"realized", "unrealized"}, "activity": [{"time", "action", "amount", "asset", "value"}]}` |
| `odds` | the model | `{"question", "outcomes": [{"name", "price"}], "volume", "url"}` |

Addresses, mints and transaction ids appear in the answer's text in inline code, in full.
