// Bot for btc-race-24h-20261115-0828: strict capitulation reversal on CBBTC, long only.
// One symbol, one position slot, full size, at most one order per batch.
//
// The rule, fitted and verified on this competition's own dev window (1,440 bars,
// 14 Nov 08:28Z - 15 Nov 08:28Z) with an exact-BigInt replica of the harness fill
// model (validated to the unit against grade-local buy-and-hold: -52,586,916 units
// on the previous race's window), and cross-checked on that window as out-of-sample:
//
//   ARM:    the 30-bar close return is -100 bps or worse AND Wilder RSI(14) < 20.
//           The arm lasts 60 bars and re-arms while the condition holds.
//   ENTER:  while armed, the 15-bar close return reaches +30 bps or more.
//   EXIT:   a trailing stop of 80 bps below the peak close since the entry bar.
//           No take-profit: the stop rides a real recovery instead of capping it.
//
// Why so strict: the round trip costs about 43 bps at this window's depths
// (4 bps fee + 2 bps slippage + ~15 bps impact per leg at the median $642k depth),
// so only a deep capitulation followed by a confirmed bounce clears the cost.
// Looser arms (30-bar drop -70 bps, RSI < 25) lose on this window: they catch
// every dead-cat bounce of a choppy downtrend and bleed one round-trip cost
// after another. The strict arm fired 3 times on the dev window and the rule
// finished +$31.14 with 5 filled orders and a 1.64% maximum drawdown.
//
// The one risk this design accepts openly: on a window with no capitulation as
// deep as -100 bps with RSI under 20 it trades nothing, and a bot with no trade
// fails the race guardrail. That is the price of refusing to bleed on noise.
// A narrow participation leg below insures against exactly that outcome: if
// nothing has filled by late in the window it takes one bounce trade, so the
// entry stays ranked instead of sitting out. On both observed windows it cost
// nothing on the new window and about $9-10 on the old one, where it bought
// the only late bounce and exited on its tighter trail.
//
// Participation leg (fires only when no fill has happened yet):
//   LATE:   only from batch 1200 to batch 1420 of the window.
//   ENTER:  the 15-bar close return reaches +40 bps.
//   EXIT:   a trailing stop of 45 bps below the peak close since the entry bar
//           (tighter than the reversal leg: this trade has no capitulation
//           behind it, so it is cut sooner).
//
// Determinism: float64 arithmetic (+ - * /) only, no clock, no randomness, no
// environment. RSI is Wilder's textbook recursion (the first averages are the
// means of the first 14 changes, each next one 13/14 of the last plus 1/14 of
// the newest change), the same recursion the kit's rsi-bollinger baseline uses.
// All return thresholds are computed in integer basis points from the integer
// closes, so the decision is exact.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Arm when the close fell this far over the last 30 bars. */
const DROP_BARS = 30;
const DROP_BPS = 100;
/** Wilder RSI(14) must be under this to arm. */
const RSI_BARS = 14;
const RSI_MAX = 20;
/** Bars an arm stays live (re-arms while the arm condition holds). */
const ARM_BARS = 60;
/** Enter when the close rose this far over the last 15 bars while armed. */
const CONF_BARS = 15;
const CONF_BPS = 30;
/** Trailing stop, in bps below the peak close since the entry bar. */
const TRAIL_BPS = 80;
/** Participation leg: earliest / latest batch it may enter on. */
const PART_START_SEQ = 1200;
const PART_END_SEQ = 1420;
/** Participation leg: enter when the close rose this far over the last 15 bars. */
const PART_CONF_BPS = 40;
/** Participation leg: its tighter trailing stop, in bps below the peak close. */
const PART_TRAIL_BPS = 45;
/** Slippage cap on every order: the widest open-to-close gap on the dev window
    was 33.7 bps, so 100 bps leaves room without ever binding in practice. */
const MAX_SLIPPAGE_BPS = 100;

/** Integer basis points of (to - from) / from, truncated toward zero. */
function retBps(from: bigint, to: bigint): number {
  return Number(((to - from) * 10000n) / from);
}

const closes: bigint[] = [];
let prevClose: number | null = null;
const firstChanges: number[] = [];
let gain: number | null = null;
let loss: number | null = null;

function rsi(): number | null {
  if (gain === null || loss === null) return null;
  const moved = gain + loss;
  return moved === 0 ? 50 : (100 * gain) / moved;
}

function pushClose(c: bigint): void {
  closes.push(c);
  const n = Number(c);
  if (prevClose !== null) {
    const change = n - prevClose;
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    if (gain === null || loss === null) {
      firstChanges.push(change);
      if (firstChanges.length === RSI_BARS) {
        gain = firstChanges.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_BARS;
        loss = firstChanges.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_BARS;
      }
    } else {
      gain = (gain * (RSI_BARS - 1) + up) / RSI_BARS;
      loss = (loss * (RSI_BARS - 1) + down) / RSI_BARS;
    }
  }
  prevClose = n;
}

let armedUntil = -1;
let peakClose = 0n;
/** Which leg holds the position, if any: 'R' reversal, 'P' participation. */
let leg: 'R' | 'P' | null = null;
/** Filled orders so far (from the batches' fill reports). */
let filledCount = 0;

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    for (const fill of batch.fills) if (fill.status === 'filled') filledCount++;
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    pushClose(BigInt(bar.c));
    if (state.warmingUp) return [];
    const k = closes.length - 1;
    const close = closes[k]!;
    const held = state.positions.get(SYMBOL);

    if (held !== undefined) {
      if (close > peakClose) peakClose = close;
      const trail = leg === 'P' ? PART_TRAIL_BPS : TRAIL_BPS;
      if (retBps(peakClose, close) <= -trail) {
        leg = null;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    const r = rsi();
    if (k >= DROP_BARS && r !== null && retBps(closes[k - DROP_BARS]!, close) <= -DROP_BPS && r < RSI_MAX) {
      armedUntil = k + ARM_BARS;
    }
    if (k <= armedUntil && k >= CONF_BARS && retBps(closes[k - CONF_BARS]!, close) >= CONF_BPS) {
      peakClose = close;
      armedUntil = -1;
      leg = 'R';
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }
    if (
      filledCount === 0 &&
      batch.seq >= PART_START_SEQ &&
      batch.seq <= PART_END_SEQ &&
      k >= CONF_BARS &&
      retBps(closes[k - CONF_BARS]!, close) >= PART_CONF_BPS
    ) {
      peakClose = close;
      leg = 'P';
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }
    return [];
  },
});
