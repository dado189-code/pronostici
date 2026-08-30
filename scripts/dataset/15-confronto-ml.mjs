// scripts/dataset/15-confronto-ml.mjs
// Integra le previsioni ML (Python/LightGBM) con Dixon-Coles (v1/v2) e il
// mercato: bootstrap, analisi per lega, draw, disagreement, error
// correlation, EV/ROI/CLV. Punti 19-27 della richiesta.

import { readFileSync, writeFileSync } from 'node:fs';
import { LEGHE } from './00-config.mjs';

function csv(testo) {
  const righe = testo.trim().split(/\r?\n/);
  const intest = righe[0].split(',');
  return righe.slice(1).map(r => { const c = r.split(','); return Object.fromEntries(intest.map((h, i) => [h.trim(), c[i]])); });
}

const mlRaw = csv(readFileSync('data/ml/previsioni-ml-test-raw.csv', 'utf8'));
const mlCal = csv(readFileSync('data/ml/previsioni-ml-test-calibrated.csv', 'utf8'));
const wf = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const wf2 = JSON.parse(readFileSync('data/dataset/previsioni-v2-candidate.json', 'utf8'));
const reportMl = JSON.parse(readFileSync('data/ml/report-ml.json', 'utf8'));

const mlRawByMatch = new Map(mlRaw.map(r => [r.match_id, { P1: +r.p_home, PX: +r.p_draw, P2: +r.p_away, esito: r.target }]));
const mlCalByMatch = new Map(mlCal.map(r => [r.match_id, { P1: +r.p_home, PX: +r.p_draw, P2: +r.p_away }]));
const v2ByMatch = new Map(wf2.previsioni.map(p => [p.match_id, p.modelV2]));

const righe = [];
for (const p1 of wf.previsioni) {
  const ml = mlRawByMatch.get(p1.match_id);
  if (!ml) continue; // solo TEST, e solo dove ML ha prodotto una previsione
  const mlc = mlCalByMatch.get(p1.match_id);
  const v2 = v2ByMatch.get(p1.match_id);
  righe.push({ match_id: p1.match_id, league: p1.league, season: p1.season, date: p1.date, esito: p1.esito,
    modelA: p1.modelA, modelV2: v2 || null, market: p1.market, modelML: ml, modelMLcal: mlc });
}
console.log(`Righe TEST confrontabili (v1+ML entrambi presenti): ${righe.length} (v1 TEST aveva ${wf.previsioni.filter(p => p.match_id.includes('2526') || true).length} totali nel file, ML aveva ${mlRaw.length})`);

function oneHot(e) { return e === 'H' ? [1, 0, 0] : e === 'D' ? [0, 1, 0] : [0, 0, 1]; }
function brierRow([ph, pd, pa], e) { const [oh, od, oa] = oneHot(e); return (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2; }
function logLossRow([ph, pd, pa], e) { const p = e === 'H' ? ph : e === 'D' ? pd : pa; return -Math.log(Math.max(p, 1e-10)); }
function rpsRow([ph, pd, pa], e) { const [oh, od, oa] = oneHot(e); return 0.5 * ((ph - oh) ** 2 + (ph + pd - oh - od) ** 2); }
function media(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

const probA = r => [r.modelA.P1, r.modelA.PX, r.modelA.P2];
const probMLraw = r => [r.modelML.P1, r.modelML.PX, r.modelML.P2];
const probMLcal = r => [r.modelMLcal.P1, r.modelMLcal.PX, r.modelMLcal.P2];
const probMkt = r => [r.market.P1, r.market.PX, r.market.P2];

// ---------------------------------------------------------------- 19: tabella confronto TEST
function metriche(rows, prob) {
  return { n: rows.length, brier: +media(rows.map(r => brierRow(prob(r), r.esito))).toFixed(4),
    logLoss: +media(rows.map(r => logLossRow(prob(r), r.esito))).toFixed(4), rps: +media(rows.map(r => rpsRow(prob(r), r.esito))).toFixed(4) };
}
const conMkt = righe.filter(r => r.market);
const conV2 = righe.filter(r => r.modelV2);
const tabellaConfronto = {
  'football-v1-baseline': metriche(righe, probA),
  'football-v2-candidate': metriche(conV2, r => [r.modelV2.P1, r.modelV2.PX, r.modelV2.P2]),
  'football-ml-v1-raw': metriche(righe, probMLraw),
  'football-ml-v1-calibrated': metriche(righe, probMLcal),
  'market-closing-no-vig': metriche(conMkt, probMkt)
};
console.log('\n=== TABELLA CONFRONTO TEST 2025/26 ===');
console.table(tabellaConfronto);

// ---------------------------------------------------------------- 20: bootstrap ML vs v1
function mulberry32(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bootstrap(rows, fBase, fAltro, metricaFn, nIter = 2000, seed = 123) {
  const rnd = mulberry32(seed);
  const diff = rows.map(r => metricaFn(fAltro(r), r.esito) - metricaFn(fBase(r), r.esito));
  const n = diff.length; const medie = [];
  for (let it = 0; it < nIter; it++) { let s = 0; for (let k = 0; k < n; k++) s += diff[Math.floor(rnd() * n)]; medie.push(s / n); }
  medie.sort((a, b) => a - b);
  const m = diff.reduce((a, b) => a + b, 0) / n;
  const basso = medie[Math.floor(nIter * 0.025)], alto = medie[Math.floor(nIter * 0.975)];
  const includeZero = basso <= 0 && alto >= 0;
  let verdetto = includeZero ? 'INCONCLUSIVE' : (m < 0 && alto < 0 ? (Math.abs(m) > 0.005 ? 'SIGNIFICANT' : 'LIKELY') : 'NEGATIVE');
  return { n_match: n, differenza_media: +m.toFixed(5), ic95: [+basso.toFixed(5), +alto.toFixed(5)], verdetto };
}
const bootstrapOut = {
  'ML-raw vs v1': { brier: bootstrap(righe, probA, probMLraw, brierRow), logLoss: bootstrap(righe, probA, probMLraw, logLossRow), rps: bootstrap(righe, probA, probMLraw, rpsRow) },
  'ML-calibrated vs v1': { brier: bootstrap(righe, probA, probMLcal, brierRow), logLoss: bootstrap(righe, probA, probMLcal, logLossRow), rps: bootstrap(righe, probA, probMLcal, rpsRow) }
};
console.log('\n=== BOOTSTRAP ML vs v1-baseline (TEST) ===');
console.log(JSON.stringify(bootstrapOut, null, 1));

// ---------------------------------------------------------------- 21: per lega
const perLega = {};
for (const lega of LEGHE) {
  const rows = righe.filter(r => r.league === lega.nome);
  perLega[lega.nome] = { v1: metriche(rows, probA), ml_raw: metriche(rows, probMLraw), ml_calibrated: metriche(rows, probMLcal) };
}

// ---------------------------------------------------------------- 22/23: stato partita e confidence bucket
function statoPartita(r) {
  const [ph, pd, pa] = probA(r);
  const max = Math.max(ph, pd, pa);
  if (pd === max) return 'balanced (pareggio favorito)';
  if (max > 0.65) return ph === max ? 'heavy favorite home' : 'heavy favorite away';
  if (max < 0.45) return 'underdog/equilibrata';
  return ph === max ? 'favorite home' : 'favorite away';
}
const perStato = {};
for (const r of righe) { const s = statoPartita(r); (perStato[s] ||= []).push(r); }
const statoOut = Object.fromEntries(Object.entries(perStato).map(([s, rows]) => [s, { n: rows.length, v1: metriche(rows, probA), ml_raw: metriche(rows, probMLraw) }]));

const bucketConfidence = { '40-50%': [], '50-60%': [], '60-70%': [], '70%+': [] };
for (const r of righe) {
  const maxP = Math.max(...probA(r));
  const b = maxP < 0.5 ? '40-50%' : maxP < 0.6 ? '50-60%' : maxP < 0.7 ? '60-70%' : '70%+';
  bucketConfidence[b].push(r);
}
const confidenceOut = Object.fromEntries(Object.entries(bucketConfidence).map(([b, rows]) => [b, {
  n: rows.length, brier_v1: rows.length ? +media(rows.map(r => brierRow(probA(r), r.esito))).toFixed(4) : null,
  accuracy_v1: rows.length ? +(rows.filter(r => { const [ph, pd, pa] = probA(r); const max = Math.max(ph, pd, pa); const pred = ph === max ? 'H' : pd === max ? 'D' : 'A'; return pred === r.esito; }).length / rows.length * 100).toFixed(1) : null
}]));

// ---------------------------------------------------------------- 11/K: draw performance
function ece(rows, campo, esitoLettera) {
  const bucket = Array.from({ length: 10 }, () => ({ n: 0, sommaP: 0, positivi: 0 }));
  for (const r of rows) { const p = campo(r); const idx = Math.min(9, Math.floor(p * 10)); bucket[idx].n++; bucket[idx].sommaP += p; if (r.esito === esitoLettera) bucket[idx].positivi++; }
  let e = 0, n = 0;
  for (const b of bucket) if (b.n) { e += b.n * Math.abs(b.sommaP / b.n - b.positivi / b.n); n += b.n; }
  return n ? +(e / n).toFixed(4) : null;
}
const drawOut = {
  brier_draw_v1: +media(righe.map(r => (r.modelA.PX - (r.esito === 'D' ? 1 : 0)) ** 2)).toFixed(4),
  brier_draw_ml_raw: +media(righe.map(r => (r.modelML.PX - (r.esito === 'D' ? 1 : 0)) ** 2)).toFixed(4),
  ece_draw_v1: ece(righe, r => r.modelA.PX, 'D'), ece_draw_ml_raw: ece(righe, r => r.modelML.PX, 'D'),
  predicted_draw_pct_v1: +(media(righe.map(r => r.modelA.PX)) * 100).toFixed(1),
  predicted_draw_pct_ml: +(media(righe.map(r => r.modelML.PX)) * 100).toFixed(1),
  observed_draw_pct: +(righe.filter(r => r.esito === 'D').length / righe.length * 100).toFixed(1)
};

// ---------------------------------------------------------------- 26: disagreement DC vs ML
const disagreement = righe.map(r => {
  const [ph1, pd1, pa1] = probA(r), [ph2, pd2, pa2] = probMLraw(r);
  const maxDiff = Math.max(Math.abs(ph1 - ph2), Math.abs(pd1 - pd2), Math.abs(pa1 - pa2));
  return { ...r, maxDiff };
});
const bucketDisagreement = { '<3pp': [], '3-5pp': [], '5-10pp': [], '>10pp': [] };
for (const r of disagreement) {
  const d = r.maxDiff * 100;
  const b = d < 3 ? '<3pp' : d < 5 ? '3-5pp' : d < 10 ? '5-10pp' : '>10pp';
  bucketDisagreement[b].push(r);
}
const disagreementOut = Object.fromEntries(Object.entries(bucketDisagreement).map(([b, rows]) => [b, {
  n: rows.length,
  brier_v1: rows.length ? +media(rows.map(r => brierRow(probA(r), r.esito))).toFixed(4) : null,
  brier_ml: rows.length ? +media(rows.map(r => brierRow(probMLraw(r), r.esito))).toFixed(4) : null,
  chi_ha_ragione: rows.length ? (media(rows.map(r => brierRow(probA(r), r.esito))) < media(rows.map(r => brierRow(probMLraw(r), r.esito))) ? 'Dixon-Coles' : 'ML') : null
}]));

// ---------------------------------------------------------------- 27: error correlation
const errV1 = righe.map(r => brierRow(probA(r), r.esito));
const errML = righe.map(r => brierRow(probMLraw(r), r.esito));
function correlazionePearson(x, y) {
  const mx = media(x), my = media(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return +(num / Math.sqrt(dx * dy)).toFixed(3);
}
const errorCorrelation = correlazionePearson(errV1, errML);

// ---------------------------------------------------------------- 25: EV/ROI/CLV con ML calibrated
function selezioni(rows, prob) {
  const out = [];
  for (const r of rows) {
    if (!r.market) continue;
    const p = prob(r); const quote = [r.market.closing_home, r.market.closing_draw, r.market.closing_away]; const lettere = ['H', 'D', 'A'];
    let migliore = null;
    for (let k = 0; k < 3; k++) { if (!(quote[k] > 1)) continue; const ev = p[k] * quote[k] - 1; if (!migliore || ev > migliore.ev) migliore = { esito: lettere[k], ev, prob: p[k], quota: quote[k] }; }
    if (migliore) out.push({ ...r, selezione: migliore });
  }
  return out;
}
function perf(sel, soglia) {
  const g = sel.filter(s => s.selezione.ev >= soglia);
  if (!g.length) return { bets: 0 };
  let vinte = 0, pl = 0, quoteSomma = 0; const serie = [];
  for (const s of g) { const vince = s.selezione.esito === s.esito; const r = vince ? s.selezione.quota - 1 : -1; pl += r; serie.push(r); quoteSomma += s.selezione.quota; if (vince) vinte++; }
  let picco = 0, cum = 0, maxDD = 0; for (const r of serie) { cum += r; picco = Math.max(picco, cum); maxDD = Math.max(maxDD, picco - cum); }
  return { bets: g.length, hit_rate_pct: +(vinte / g.length * 100).toFixed(1), average_odds: +(quoteSomma / g.length).toFixed(2), roi_pct: +(pl / g.length * 100).toFixed(2), max_drawdown: +maxDD.toFixed(2) };
}
function clv(sel) {
  const conAp = sel.filter(s => { const ap = s.selezione.esito === 'H' ? s.market.opening_home : s.selezione.esito === 'D' ? s.market.opening_draw : s.market.opening_away; return ap > 1; });
  if (!conAp.length) return { disponibile: false };
  let somma = 0, batte = 0;
  for (const s of conAp) { const ap = s.selezione.esito === 'H' ? s.market.opening_home : s.selezione.esito === 'D' ? s.market.opening_draw : s.market.opening_away; somma += ap / s.selezione.quota - 1; if (ap > s.selezione.quota) batte++; }
  return { n: conAp.length, clv_medio_pct: +(somma / conAp.length * 100).toFixed(2), pct_batte_chiusura: +(batte / conAp.length * 100).toFixed(1) };
}
const SOGLIE = [0, 0.02, 0.05, 0.075, 0.10];
const selMLcal = selezioni(righe, probMLcal);
const evOut = { per_soglia: {}, clv: clv(selMLcal.filter(s => s.selezione.ev >= 0)) };
for (const s of SOGLIE) evOut.per_soglia[`EV>=${(s * 100).toFixed(1)}%`] = perf(selMLcal, s);

writeFileSync('data/backtests/confronto-ml-finale.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  n_righe_confrontabili: righe.length,
  formula_ml: reportMl.algoritmo, feature_finali: reportMl.feature_finali, hyperparameters: reportMl.hyperparameters_finali,
  calibrazione_scelta: reportMl.calibrazione_scelta, calib_test_confronto_onesto: reportMl.calib_test_confronto_onesto,
  tabella_confronto_TEST: tabellaConfronto,
  bootstrap_ML_vs_v1: bootstrapOut,
  per_lega_TEST: perLega,
  per_stato_partita: statoOut,
  per_confidence_bucket: confidenceOut,
  draw_analysis: drawOut,
  disagreement_DC_vs_ML: disagreementOut,
  error_correlation_pearson: errorCorrelation,
  ev_clv_ML_calibrated: evOut,
  shap_top20: reportMl.shap_top20
}, null, 1));

console.log('\nPer lega:', JSON.stringify(perLega, null, 1));
console.log('\nDraw:', JSON.stringify(drawOut, null, 1));
console.log('\nDisagreement:', JSON.stringify(disagreementOut, null, 1));
console.log('\nError correlation (Pearson, Brier v1 vs Brier ML):', errorCorrelation);
console.log('\nEV/CLV ML calibrated:', JSON.stringify(evOut, null, 1));
