# OVU — perpetuals research desk

## Context

**Deadline: Sept 8, 23:59 UTC.** It is Saturday Sept 5, ~17:38 UTC — about **3 days 6 hours**.

Target: Binance Agent OS Mini Hackathon, Track A ($20k). Submission is a video/demo plus GitHub, a repost, and the survey.

**What it is:** an MCP server that studies BTC, ETH and SOL perpetuals for four specific structural patterns — failed rebounds, suppressed trends, funding pressure and positioning shifts — and produces trading plans that include the arguments *against* themselves, sized risk, and a signal ID you can audit later.

**Why it wins:** every other entry will assert a signal. This one publishes the counter-case and a receipt.

Three deliberate choices, all from the same instinct:

1. **Counterexamples are a first-class output.** Every plan names the readings that contradict it. Not a disclaimer — a section, with numbers.
2. **Every signal gets a stable ID.** Later you look it up and OVU tells you what happened, including when it was wrong.
3. **It goes deep on one thing.** Four patterns read properly, across three assets, rather than everything read shallowly — and it says "nothing here" when nothing is there.

Two naming/scoping decisions, both settled:

- **No "ASP."** That's OKX vocabulary and would read as copy-paste on a Binance submission.
- **Not framed around bear markets.** The patterns are direction-agnostic in principle and occur on every timeframe in every market, including inside uptrends. Nothing in the product requires a market regime to be true, and nothing in the pitch mentions one. That also means it stays demoable on Monday regardless of what BTC does — which is the practical reason as much as the honest one.


## Verified: all data is free, public, and works

Tested live against `fapi.binance.com` at 17:28 UTC. No API key, no auth, no account.

| Endpoint | Gives | Status |
|---|---|---|
| `/fapi/v1/klines` | Candles per timeframe | works |
| `/fapi/v1/premiumIndex` | Mark price + current funding | 200 |
| `/fapi/v1/fundingRate` | Funding history | 200 |
| `/fapi/v1/openInterest` | Live open interest | 200 |
| `/futures/data/openInterestHist` | OI over time — the "holdings changes" input | 200 |
| `/futures/data/topLongShortPositionRatio` | How large accounts are positioned | 200 |
| `/futures/data/takerlongshortRatio` | Aggressive buy vs sell flow | 200 |
| `/fapi/v1/depth` | Order book | works |

Local shells can't resolve Binance hosts, so dev scripts need `curl --resolve` or a fixed resolver. CloudFront IPs rotate — resolve at runtime, never hardcode. Railway has no such problem.

**The live readings right now already describe a setup:** BTC mark $80,031 with top traders 67.8% long at a 2.11 long/short ratio, funding hovering near zero (last print +0.0015%, prior one negative), and open interest drifting down from 106,828 to 106,601 BTC. Crowded longs into weakness, with no fresh short fuel — and the OI decline is itself the counterexample. That is the product, working, on today's data.

## The four signals

Keep it to four. Each is deterministic, each reports the number that produced it, and each has a defined counterexample.

**1. Rebound failure.** Price rallies into a declining EMA or a prior supply shelf, gets rejected, and closes back below the level it reclaimed. Reports the level, the rejection candle, and how far the bounce got as a fraction of the prior leg down.
*Counterexample:* the rejection came on below-average volume, or the close held above the level on a higher timeframe.

**2. Trend suppression.** A sequence of lower highs with a bearish EMA stack, where each bounce is smaller than the last. Quantified as decaying bounce amplitude, not eyeballed.
*Counterexample:* the most recent bounce was *larger* than the prior one — decay broken, suppression weakening.

**3. Funding pressure.** Funding positive while price makes lower highs means longs are paying to be wrong. Reports current funding, the recent trend in it, and the implied crowd.
*Counterexample:* funding is negative or flipping negative — shorts are the crowded side, which raises squeeze risk against a short plan.

**4. Positioning shift.** Open interest rising into falling price means fresh positions and fuel for continuation. Cross-checked against the top-trader long/short ratio and taker flow.
*Counterexample:* OI falling into falling price — that's capitulation and exhaustion, not fresh conviction. Continuation is less likely.

Each signal reports a direction rather than assuming one: a failed rebound below resistance and a failed breakdown above support are the same computation with the sign flipped. Build it symmetric from the start — it's the same code either way, and it means no market condition can leave OVU with nothing to say.

Signals are reported individually with a plain verdict. **No weighted score out of 100** — arbitrary weights are the first thing a judge pokes at, and the counterexample section does the honest work a score pretends to do.

## What a plan contains

- Direction, entry zone, invalidation level, targets, R:R
- The evidence, each item with its number and its source endpoint
- **Counterexamples** — the specific readings arguing against this trade, stated plainly
- Risk: size for the given stake and stop, worst case in dollars, and distance to liquidation at the chosen leverage
- **Signal ID** — a stable hash of asset, timeframe, signal type, timestamp and levels
- Later: resolution. Did it invalidate, hit target, or expire?

## MCP tool surface — 6 tools

| Tool | Does |
|---|---|
| `scan` | All three assets, which signals are firing, ranked by strength |
| `analyze` | One asset in full — every signal, every counterexample, the positioning picture |
| `plan` | A trading plan for a given asset and stake, with sizing and liquidation distance |
| `positioning` | The funding / OI / long-short / taker-flow picture on its own |
| `signal` | Look up a signal ID: what it said, and where it stands now |
| `resolve` | Every past signal and how it turned out — the honest track record |

## Execution

OVU never trades. Agent OS requires human confirmation on every write and issues no API keys, so unattended execution is impossible by design — and here that's a feature, not a limitation. OVU researches; `binance-mcp-server` executes in the same client with your confirmation.

For the video you can still show a real trade: OVU produces the plan and the size, you tell Binance's MCP to place it, you confirm. That needs an Agentic sub-account funded manually with real money — there is no testnet. **Check BTCUSDT perp minimum notional first**; a small stake may require leverage to be legal, and leverage makes the liquidation-distance number load-bearing rather than decorative.

Execution is optional for the submission. The research half stands alone and needs no money at all.

## Files

Greenfield at `C:\Users\Emmanuel\ovu`.

```
src/mcp/server.ts        MCP server, tool registration
src/mcp/tools.ts         the 6 tools — thin wrappers, no logic
src/data/futures.ts      the verified endpoints, one function each
src/engine/indicators.ts EMA, ATR, swing highs/lows, volume average
src/engine/signals.ts    the four signals + their counterexamples
src/engine/risk.ts       sizing, worst case, liquidation distance
src/engine/plan.ts       assembles a plan, mints the signal ID
src/store/signals.ts     signal log + resolution
README.md                "What's actually real / Not real yet"
```

Carry over CONVO's README pattern — the honest **"What's actually real / Not real yet"** section up top. It's the most trust-building thing in that repo and it costs twenty minutes.

## Install budget — your call before I run anything

| Package | For | Size |
|---|---|---|
| `@modelcontextprotocol/sdk` | The MCP server. Not optional | ~6 MB |
| `zod` | Validates tool inputs. SDK dependency anyway | ~3 MB |
| `typescript` + `tsx` | Type safety on the risk maths, no build step | ~55 MB |

**~64 MB total.** Runtime only, plain JavaScript, is ~9 MB if you'd rather.

Not installing: no indicator library (EMA/ATR/swings are ~80 lines and you should be able to read them), no test framework (`node:test` is built in), no HTTP client (`fetch` is native), no database driver for now — the signal log starts as a JSON file and only needs Postgres if it outgrows that.

Confirmed working: `registry.npmjs.org` 200, `api.github.com` 200. Node v24.15.0, npm 11.12.1.

## Days

**Tonight** — `data/futures.ts` against the verified endpoints, then `engine/indicators.ts` and `engine/risk.ts`. All pure, all testable with `node --test`, no MCP wiring yet.

**Sunday** — `engine/signals.ts`: the four signals with their counterexamples, tested against live BTC/ETH/SOL data. Then `engine/plan.ts` and signal IDs. By end of day OVU produces a full plan from the terminal.

**Monday** — Wrap it as an MCP server, wire the 6 tools, run it inside Claude Code. Signal log and `resolve`. Optionally connect `binance-mcp-server` and show a confirmed trade.

**Tuesday morning** — Video, README, submit. Don't leave the video late; it's half the score.

## The demo — 90 seconds

1. `scan` — three assets, what's firing, ranked.
2. `analyze BTC` — the evidence with real numbers: top traders 67.8% long, funding near zero, OI falling.
3. The counterexample section, read out loud. *"OI is falling into this decline, which argues exhaustion rather than fresh shorts. This is the main case against the trade."*
4. `plan BTC 50` — entry, invalidation, targets, size, worst case in dollars, distance to liquidation.
5. Signal ID appears. `signal BTC-RF-7A2C` → what it said and where it stands.
6. Optional: hand the plan to Binance's MCP, confirm, trade lands.

The beat that lands is step 3. Every other submission tells the judge why it's right.

## Verification

- `node --test` on `indicators.ts` and `risk.ts`. Risk tests must include the refusals: stop on the wrong side of entry, size below exchange minimum, leverage putting liquidation inside the stop.
- Signals tested against live data for all three assets, and against a stretch of history where the pattern clearly did and did not occur. A signal that fires on everything is broken.
- Counterexample coverage: every signal must emit at least one counterexample or explicitly state none applies. A plan with an empty counter-case is a bug.
- Signal IDs must be stable — same inputs, same ID — and `resolve` must never claim an outcome the data doesn't show.
- End to end in Claude Code: `scan` → `analyze` → `plan` → `signal`.

## Not promised

No win rate, no profit factor, no backtest performance claims, no assertion that the signals are profitable. The README states plainly that the strategy is unvalidated and the signal log is being collected forward from Sept 6. A small honest record beats a large invented one.


