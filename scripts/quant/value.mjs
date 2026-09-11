import {finite, probability} from './math.mjs';
export const MIN_EV = 0.03;
export function removeMargin(odds) {
  if (!Array.isArray(odds) || odds.length < 2) throw new TypeError('Servono tutti gli esiti mutuamente esclusivi del mercato');
  odds.forEach(q => { finite(q, 'quota', 1); if (q === 1) throw new RangeError('Quota deve superare 1'); });
  const implied = odds.map(q => 1 / q), sum = implied.reduce((a, b) => a + b, 0);
  return {probabilities: implied.map(p => p / sum), overround: sum - 1, method: 'proportional', isTrueProbability: false};
}
export function expectedValue(p, odds) {
  probability(p); finite(odds, 'quota', 1);
  if (odds === 1) throw new RangeError('Quota deve superare 1');
  return p * odds - 1;
}
export function quarterKelly(p, odds, bankroll = 0) {
  const ev = expectedValue(p, odds);
  finite(bankroll, 'bankroll', 0);
  const rawFraction = 0.25 * ev / (odds - 1);
  const fraction = Math.max(0, rawFraction);
  return {rawFraction, fraction, percent: fraction * 100, stake: bankroll * fraction};
}
export function evaluateValue({modelProbability, odds, marketProbability, bankroll = 0}) {
  probability(marketProbability, 'probabilità mercato');
  const ev = expectedValue(modelProbability, odds);
  const qualifies = ev >= MIN_EV - 1e-12;
  const kelly = quarterKelly(modelProbability, odds, bankroll);
  return {ev, edge: modelProbability - marketProbability, qualifies, threshold: MIN_EV,
    fairOdds: modelProbability === 0 ? null : 1 / modelProbability,
    kelly, suggestedFraction: qualifies ? kelly.fraction : 0, suggestedStake: qualifies ? kelly.stake : 0,
    assumption: 'Probabilità modello affidabile; singola posizione, senza esposizioni correlate o commissioni.'};
}
