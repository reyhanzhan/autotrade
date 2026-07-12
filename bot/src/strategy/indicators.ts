import type { Candle } from "../shared/types.js";

/** Wilder-style ATR. */
export function computeATR(candles: Candle[], period: number): number | undefined {
  if (candles.length < period + 1) return;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }
  return atr;
}

export function computeEMA(candles: Candle[], period: number): number | undefined {
  if (candles.length < period) return;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i]!.close * k + ema * (1 - k);
  }
  return ema;
}

/** Wilder's ADX */
export function computeADX(candles: Candle[], period: number = 14): number | undefined {
  if (candles.length < period * 2) return undefined;
  
  const trs: number[] = [];
  const pdms: number[] = [];
  const ndms: number[] = [];
  
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    
    let pdm = 0;
    let ndm = 0;
    if (upMove > downMove && upMove > 0) pdm = upMove;
    if (downMove > upMove && downMove > 0) ndm = downMove;
    pdms.push(pdm);
    ndms.push(ndm);
  }
  
  let smoothedTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedPDM = pdms.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedNDM = ndms.slice(0, period).reduce((a, b) => a + b, 0);
  
  const dxs: number[] = [];
  
  let pdi = smoothedTR === 0 ? 0 : (smoothedPDM / smoothedTR) * 100;
  let ndi = smoothedTR === 0 ? 0 : (smoothedNDM / smoothedTR) * 100;
  let dx = (pdi + ndi) === 0 ? 0 : Math.abs(pdi - ndi) / (pdi + ndi) * 100;
  dxs.push(dx);
  
  for (let i = period; i < trs.length; i++) {
    smoothedTR = smoothedTR - (smoothedTR / period) + trs[i]!;
    smoothedPDM = smoothedPDM - (smoothedPDM / period) + pdms[i]!;
    smoothedNDM = smoothedNDM - (smoothedNDM / period) + ndms[i]!;
    
    pdi = smoothedTR === 0 ? 0 : (smoothedPDM / smoothedTR) * 100;
    ndi = smoothedTR === 0 ? 0 : (smoothedNDM / smoothedTR) * 100;
    dx = (pdi + ndi) === 0 ? 0 : Math.abs(pdi - ndi) / (pdi + ndi) * 100;
    dxs.push(dx);
  }
  
  if (dxs.length < period) return undefined;
  
  let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) {
    adx = (adx * (period - 1) + dxs[i]!) / period;
  }
  
  return adx;
}

/** Wilder's RSI */
export function computeRSI(candles: Candle[], period: number = 14): number | undefined {
  if (candles.length < period + 1) return undefined;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const diff = candles[i]!.close - candles[i - 1]!.close;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  let rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));
  
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i]!.close - candles[i - 1]!.close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    
    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));
  }
  
  return rsi;
}
