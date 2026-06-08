// ============================================================================
// types.ts — Domain types shared across the bot.
// ============================================================================

/** A single OHLCV candle. Prices are stored as numbers (sufficient for BTC
 *  precision; if you trade pairs where price < 0.0001 you should swap to a
 *  decimal lib like decimal.js). */
export interface Candle {
  openTime: number;    // ms epoch
  closeTime: number;   // ms epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;   // true only for finalized candles
}

export type Side = "LONG" | "SHORT";
export type OrderSide = "BUY" | "SELL";

/** A pivot/swing point in the market structure. */
export interface SwingPoint {
  index: number;       // index into the candle array
  time: number;        // ms epoch
  price: number;
  kind: "HIGH" | "LOW";
}

/** Result of structure analysis at a point in time. */
export interface StructureState {
  trend: "BULLISH" | "BEARISH" | "RANGING";
  lastSwingHigh?: SwingPoint;
  lastSwingLow?: SwingPoint;
  /** True when the most recent candle just broke a prior swing in the trend
   *  direction (continuation). */
  bos?: Side;
  /** True when the most recent candle just broke a prior swing against the
   *  trend (potential reversal). */
  choch?: Side;
}

/** A detected Order Block. */
export interface OrderBlock {
  side: Side;          // LONG = bullish OB (demand), SHORT = bearish OB (supply)
  index: number;       // candle index that formed the OB
  time: number;
  low: number;         // zone low
  high: number;        // zone high
  mitigated: boolean;  // true if price has revisited it since formation
}

/** A detected Fair Value Gap. */
export interface FairValueGap {
  side: Side;          // LONG = bullish FVG (gap above), SHORT = bearish FVG
  startIndex: number;
  time: number;
  low: number;
  high: number;
  filled: boolean;     // true once price has fully traded through it
}

/** A trade signal produced by the strategy. The execution layer consumes these. */
export interface TradeSignal {
  symbol: string;
  interval: string;
  side: Side;
  kind: string;             // "OB_TAP_LONG" | "FVG_TAP_SHORT" | ...
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;       // 0..1
  context: {
    structure: StructureState;
    orderBlock?: OrderBlock;
    fvg?: FairValueGap;
    fibonacci?: {
      impulseLow: number;
      impulseHigh: number;
      goldenLow: number;
      goldenHigh: number;
      invalidation: number;
      structureTarget: number;
      riskReward: number;
    };
    multiTimeframe?: Array<{
      interval: string;
      trend: StructureState["trend"];
      requiredTrend: StructureState["trend"];
    }>;
  };
}
