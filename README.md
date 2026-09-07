# OVU

**A perpetuals research desk that argues with itself.**

OVU reads BTC, ETH and SOL perpetual futures on Binance for four structural
patterns, then produces a trading plan that includes the evidence *against* the
trade, the risk maths, and a signal ID you can look up later to find out whether
it was right.

Built for the Binance Agent OS Mini Hackathon (Track A).

---

## What's actually real

This section is the point, so it comes first. It is updated only when something
starts working — never in advance.

**Real right now** — 86 tests passing:

- **MCP server**, seven tools over stdio: `scan`, `trending`, `analyze`, `plan`,
  `positioning`, `signal`, `resolve`. `npm run probe` spawns the server through
  the real MCP client and calls every one of them. `npm run http` serves the same
  tools over Streamable HTTP (`POST /mcp`, `GET /health`) so Agent OS can add OVU
  as a custom connector — one server definition, two transports.
- **Signal log.** Every `plan` call records its setup under a signal ID, and
  `resolve` reports what became of each one — read from candle history only.
  When invalidation and target both fall inside one candle the order is
  unknowable, so it reports the loss.
- **Plans.** `npm run plan` turns a signal report into entry, invalidation,
  three targets, reward/risk, and a size — or refuses and says why. Levels come
  from structure, not percentages: the invalidation is the price that proves the
  thesis wrong, buffered by a quarter of ATR, and targets are prior pivots.
  Where structure runs out, the final target is labelled a `3R extension`
  instead of being passed off as a level price has traded.
- **Signal IDs.** A stable, readable identifier per setup — `BTC-RF-75ad`.
  Derived only from data, never the clock, so reading the same setup twice gives
  the same ID while a genuinely different level gives a new one.
- **The four signals**, symmetric and deterministic, each carrying its own
  counterexamples. `npm run scan` runs them across BTC, ETH and SOL on live data
  and prints every reading with its source endpoint. A 12-coin meme desk
  (DOGE, SHIB, PEPE, BONK, FLOKI, WIF, POPCAT, TURBO, MEW, BRETT, MEME, PNUT)
  rides the same engine: `npm run trending` ranks them by 24h move with volume
  and open-interest context, and `analyze`/`plan` accept any of those symbols.
- **Snapshot layer.** One fetch per symbol into a plain object, so signals are
  pure functions with no network in them — which is what makes the fixtures in
  `test/fixtures.mjs` able to pin down exactly what should and shouldn't fire.
- **Data layer.** All nine Binance public futures endpoints below, wrapped one
  function each, returning numbers instead of the strings Binance sends.
  Verified live against BTCUSDT, ETHUSDT and SOLUSDT — `npm run smoke` checks
  all 27 combinations and prints what came back.
- **HTTP layer.** Explicit DNS resolution with a public-DNS path, because some
  machines refuse to resolve Binance hostnames. TLS still validates against the
  real hostname. No dependencies.
- **Indicators.** EMA (seeded from an SMA, warmup left as `null` rather than
  guessed), true range, ATR with Wilder smoothing, confirmed swing pivots,
  baseline volume, percent change. Written out rather than imported so every
  number a signal reports traces to arithmetic you can read.
- **Risk gate.** Position sizing from risk-per-unit, worst case in quote
  currency, and approximate isolated-margin liquidation price. It refuses
  rather than warns: stop on the wrong side of entry, size under the exchange
  minimum quantity, notional under the exchange minimum, risk fraction over
  25%, and — the one that matters — leverage that would liquidate the position
  before its own stop triggers.

**Not real yet:**

- No live track record to speak of. The log starts empty; entries accumulate as
  `plan` is called. Two days of it will not prove anything and the tool says so.

---

## Why it's different

Every AI trading tool asserts a signal and moves on. Two things here don't:

**Counterexamples are an output, not a disclaimer.** Every plan carries a section
listing the specific readings that argue against it, with the numbers attached.
If open interest is falling while price falls, OVU says so and explains that this
argues exhaustion rather than fresh conviction — even when that weakens its own
setup.

**Every signal gets a stable ID.** Same inputs, same ID. Later you ask OVU what
happened to it, and it tells you honestly, including when it was wrong. The log
starts empty on 2026-09-06 and fills forward. There is no backtest and no claimed
win rate, because three days of data proves nothing.

---

## What it does not do

OVU never places a trade. It holds no API keys and no credentials, and it has no
code path that can reach a Binance trading endpoint.

That isn't caution, it's the platform: Binance Agent OS authenticates through a
browser OAuth consent screen and requires human confirmation on every write. So
OVU researches, and `binance-mcp-server` executes in the same client with your
confirmation. The two sit side by side.

---

## Planned

Four signals, each deterministic, each with a defined counterexample:

1. **Rebound failure** — price reclaims a level, gets rejected, closes back
   through it. Reports the level, the rejection, and the bounce size as a
   fraction of the prior leg.
2. **Trend suppression** — a sequence of lower highs with each bounce smaller
   than the last. Measured as decaying amplitude, not eyeballed.
3. **Funding pressure** — which side is paying to hold, and whether that agrees
   with what price is doing.
4. **Positioning shift** — open interest against price direction, cross-checked
   with the top-trader long/short ratio and taker flow.

Signals are symmetric: a failed rebound below resistance and a failed breakdown
above support are the same computation with the sign flipped. There is no score
out of 100 — arbitrary weights are the first thing worth attacking, and the
counterexample section does that job honestly.

Six MCP tools: `scan`, `analyze`, `plan`, `positioning`, `signal`, `resolve` —
plus `trending`, the meme-discovery seventh. Every tool answer follows the same
shape (verdict, evidence with sources, full counter-case, one next step), ends
with a fixed not-financial-advice notice, and says plainly when a live read fails
instead of inventing the missing numbers.

---

## Data

Every input is Binance public futures data. No API key, no account, no auth.

| Endpoint | Used for |
|---|---|
| `/fapi/v1/klines` | Candles per timeframe |
| `/fapi/v1/premiumIndex` | Mark price, current funding |
| `/fapi/v1/fundingRate` | Funding history |
| `/fapi/v1/openInterest` | Live open interest |
| `/futures/data/openInterestHist` | Open interest over time |
| `/futures/data/topLongShortPositionRatio` | Large-account positioning |
| `/futures/data/takerlongshortRatio` | Aggressive buy vs sell flow |
| `/fapi/v1/depth` | Order book |
| `/fapi/v1/exchangeInfo` | Tick size, quantity step, minimum notional |

Minimum notional, read live rather than assumed: **BTCUSDT 50, ETHUSDT 20,
SOLUSDT 5** USDT. A $50 stake is legal on all three at 1x, which is worth
knowing before planning around leverage.

---

## How this relates to Binance Agent OS

Binance describes Agent OS as bringing together "Binance APIs, Binance Wallet
Agentic Hub, Binance x402, Binance Skill Hub, and support for the Model Context
Protocol." OVU is built on two of those: it runs entirely on Binance's futures
APIs, and it is itself an MCP server.

What it deliberately does not do is authenticate to
`https://agent.binance.com/mcp/agentic`, and that's worth explaining rather than
glossing over.

Per Binance's documentation, that endpoint authenticates through a browser OAuth
consent screen, issues no API keys, and requires the user to confirm every write.
Probing it confirms a standard MCP OAuth surface — PKCE with S256, public client,
no dynamic registration, `client_id_metadata_document_supported`. All of which is
a sound design, and all of which means a headless research process has no place
in it. **OVU needs none of it**: every input it uses is public market data, so it
works for anyone who clones this repo, with nothing to connect and nothing to
authorise.

If you want to act on a plan, add Binance's own server alongside OVU:

```bash
claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
```

Then the split is:

| | |
|---|---|
| **OVU** | Reads public market data, computes signals, sizes risk, keeps the log. No credentials. |
| **`binance-mcp-server`** | Reads your Agentic sub-account and executes, asking you to confirm each time. |
| **Your AI client** | Carries a plan from one to the other. |

Trading happens inside an *Agentic virtual sub* account you fund by hand from the
Binance web UI — there is no testnet, so keep it small. There is no withdrawal
scope at any point, and Binance provides its own emergency stop under
**Profile → Dashboard → Sub-account → Account Management** that disconnects every
agent and cancels everything. OVU deliberately does not reimplement it; theirs is
stronger.

**OVU has no order endpoint and holds no keys.** That isn't a statement of intent,
it's a fact about the code — there is no signing function in this repository.

## Setup

No dependencies for the research engine. Node 20 or newer.

```bash
npm install                  # @modelcontextprotocol/sdk and zod only
node --test                  # 86 unit tests, no network
npm run smoke                # proves every live endpoint responds
npm run scan                 # all four signals on live BTC/ETH/SOL
npm run trending             # which of the 12 memes is moving
npm run plan                 # a full plan for BTCUSDT, 1h, 50 stake
npm run plan ETHUSDT 4h 200 3   # symbol, timeframe, stake, leverage
npm run probe                # spawns the MCP server and calls all seven tools
npm run http                 # serve the tools over HTTP (PORT=3000) for hosting
```

Add OVU to your agent client. Local stdio is fastest (no cold starts, signal log
stays in this folder); the hosted URL is the same tools over HTTP, for clients
that can't reach your machine — including Agent OS custom connectors.

**Claude Code:**

```bash
claude mcp add ovu -- node /absolute/path/to/ovu/src/mcp/server.mjs
claude mcp add ovu-live --transport http https://ovu-02yo.onrender.com/mcp
```

**Cursor** — `~/.cursor/mcp.json` (or `.cursor/mcp.json` in this repo):

```json
{
  "mcpServers": {
    "ovu": {
      "command": "node",
      "args": ["/absolute/path/to/ovu/src/mcp/server.mjs"]
    },
    "ovu-live": {
      "url": "https://ovu-02yo.onrender.com/mcp"
    }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.ovu]
command = "node"
args = ["/absolute/path/to/ovu/src/mcp/server.mjs"]

[mcp_servers.ovu-live]
url = "https://ovu-02yo.onrender.com/mcp"
```

Then ask: *"use OVU trending — what's moving among the memes?"*

If Binance hostnames don't resolve on your machine, `src/data/http.mjs` falls
back to public DNS automatically. Nothing to configure.

---

## Not promised

No win rate. No profit factor. No backtest results. No claim that these signals
are profitable. The strategy is unvalidated, and the signal log exists so that
claim can eventually be tested against evidence rather than asserted.

Trading perpetual futures with leverage can lose more than you put in.
