// scripts/dataset/13-confronto-v2.mjs
// Confronto finale: football-v1-baseline vs football-v2-candidate vs mercato,
// su VALIDATION e sul vero TEST 2025/26. Bootstrap v2 vs v1. EV/ROI/CLV
// comparativo. Tutto quello che risponde a OUTPUT N-U della richiesta.

import { readFileSync, writeFileSync } from 'node:fs';
import { SPLIT } from './00-config.mjs';

const wf1 = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const wf2 = JSON.parse(readFileSync('data/dataset/previsioni-v2-candidate.json', 'utf8'));
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';

const v2ByMatch = new Map(wf2.previsioni.map(p => [p.match_id, p]));
// join v1/v2 sullo stesso match_id: solo le partite presenti in ENTRAMBI
// (v2 parte dallo stesso dataset ma MINIMO_STORICO potrebbe escludere righe
// leggermente diverse per via dell'emivita diversa che cambia quali squadre
// hanno rating stabile prima)
const righe = [];
for (const p1 of wf1.previsioni) {
  const p2 = v2ByMatch.get(p1.match_id);
  if (!p2) continue;
  righe.push({ ...p1, split: splitDi(p1.date), modelV2: p2.modelV2 });
}
console.log(`Righe con v1 e v2 entrambi disponibili: ${righe.length} (v1 aveva ${wf1.previsioni.length}, v2 aveva ${wf2.previsioni.length})`);

function oneHot(e) { return e === 'H' ? [1, 0, 0] : e === 'D' ? [0, 1, 0] : [0, 0, 1]; }
function brier(rows, f) { let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const [oh, od, oa] = oneHot(r.esito); s += (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2; } return rows.length ? +(s / rows.length).toFixed(4) : null; }
function logLoss(rows, f) { const eps = 1e-10; let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const p = r.esito === 'H' ? ph : r.esito === 'D' ? pd : pa; s += -Math.log(Math.max(p, eps)); } return rows.length ? +(s / rows.length).toFixed(4) : null; }
function rps(rows, f) { let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const [oh, od, oa] = oneHot(r.esito); s += 0.5 * ((ph - oh) ** 2 + (ph + pd - oh - od) ** 2); } return rows.length ? +(s / rows.length).toFixed(4) : null; }
function ece(rows, campo, esitoLettera) {
  const bucket = Array.from({ length: 10 }, () => ({ n: 0, sommaP: 0, positivi: 0 }));
  for (const r of rows) { const p = r[campo]; const idx = Math.min(9, Math.floor(p * 10)); bucket[idx].n++; bucket[idx].sommaP += p; if (r.esito === esitoLettera) bucket[idx].positivi++; }
  let e = 0, n = 0;
  for (const b of bucket) if (b.n) { e += b.n * Math.abs(b.sommaP / b.n - b.positivi / b.n); n += b.n; }
  return n ? +(e / n).toFixed(4) : null;
}

const probA = r => [r.modelA.P1, r.modelA.PX, r.modelA.P2];
const probV2 = r => [r.modelV2.P1, r.modelV2.PX, r.modelV2.P2];
const probMkt = r => [r.market.P1, r.market.PX, r.market.P2];

function metrichePerModello(rows, prob, campoP1, campoPX, campoP2) {
  return {
    n: rows.length, brier: brier(rows, prob), logLoss: logLoss(rows, prob), rps: rps(rows, prob),
    ece_home: ece(rows.map(r => ({ ...r, _p: prob(r)[0] })), '_p', 'H'),
    ece_draw: ece(rows.map(r => ({ ...r, _p: prob(r)[1] })), '_p', 'D'),
    ece_away: ece(rows.map(r => ({ ...r, _p: prob(r)[2] })), '_p', 'A')
  };
}

const tabellaFinale = {};
for (const split of ['VALIDATION', 'TEST']) {
  const rows = righe.filter(r => r.split === split);
  const rowsConMkt = rows.filter(r => r.market);
  tabellaFinale[split] = {
    'football-v1-baseline': metrichePerModello(rows, probA),
    'football-v2-candidate': metrichePerModello(rows, probV2),
    'market-closing-no-vig': metrichePerModello(rowsConMkt, probMkt)
  };
}

// ---------------------------------------------------------------- bootstrap v2 vs v1, su TEST
function mulberry32(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function brierRow([ph, pd, pa], e) { const [oh, od, oa] = oneHot(e); return (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2; }
function logLossRow([ph, pd, pa], e) { const p = e === 'H' ? ph : e === 'D' ? pd : pa; return -Math.log(Math.max(p, 1e-10)); }
function rpsRow([ph, pd, pa], e) { const [oh, od, oa] = oneHot(e); return 0.5 * ((ph - oh) ** 2 + (ph + pd - oh - od) ** 2); }

function bootstrap(rows, metricaFn, nIter = 2000, seed = 99) {
  const rnd = mulberry32(seed);
  const diff = rows.map(r => metricaFn(probV2(r), r.esito) - metricaFn(probA(r), r.esito));
  const n = diff.length; const medie = [];
  for (let it = 0; it < nIter; it++) { let s = 0; for (let k = 0; k < n; k++) s += diff[Math.floor(rnd() * n)]; medie.push(s / n); }
  medie.sort((a, b) => a - b);
  const media = diff.reduce((a, b) => a + b, 0) / n;
  const basso = medie[Math.floor(nIter * 0.025)], alto = medie[Math.floor(nIter * 0.975)];
  const includeZero = basso <= 0 && alto >= 0;
  let verdetto;
  if (includeZero) verdetto = 'INCONCLUSIVE';
  else if (media < 0 && alto < 0) verdetto = Math.abs(media) > 0.005 ? 'SIGNIFICANT' : 'LIKELY';
  else verdetto = 'NEGATIVE';
  return { n_match: n, differenza_media: +media.toFixed(5), ic95: [+basso.toFixed(5), +alto.toFixed(5)], verdetto };
}

const testRows = righe.filter(r => r.split === 'TEST');
const bootstrapOut = {
  brier: bootstrap(testRows, brierRow), logLoss: bootstrap(testRows, logLossRow), rps: bootstrap(testRows, rpsRow)
};

// ---------------------------------------------------------------- EV/ROI/CLV comparativo v1 vs v2
function selezioni(rows, prob) {
  const out = [];
  for (const r of rows) {
    if (!r.market) continue;
    const p = prob(r); const quote = [r.market.closing_home, r.market.closing_draw, r.market.closing_away]; const lettere = ['H', 'D', 'A'];
    let migliore = null;
    for (let k = 0; k < 3; k++) { if (!(quote[k] > 1)) continue; const ev = p[k] * quote[k] - 1; if (!migliore || ev > migliore.ev) migliore = { esito: lettere[k], ev, prob: p[k], quota: quote[k] }; }
    if (migliore && migliore.ev >= 0) out.push({ ...r, selezione: migliore });
  }
  return out;
}
function perfSintetica(sel) {
  if (!sel.length) return { bets: 0 };
  let vinte = 0, pl = 0;
  for (const s of sel) { const vince = s.selezione.esito === s.esito; pl += vince ? s.selezione.quota - 1 : -1; if (vince) vinte++; }
  return { bets: sel.length, hit_rate_pct: +(vinte / sel.length * 100).toFixed(1), roi_pct: +(pl / sel.length * 100).toFixed(2) };
}
function clvSintetico(sel) {
  const conAp = sel.filter(s => { const ap = s.selezione.esito === 'H' ? s.market.opening_home : s.selezione.esito === 'D' ? s.market.opening_draw : s.market.opening_away; return ap > 1; });
  if (!conAp.length) return { disponibile: false };
  let somma = 0, batte = 0;
  for (const s of conAp) { const ap = s.selezione.esito === 'H' ? s.market.opening_home : s.selezione.esito === 'D' ? s.market.opening_draw : s.market.opening_away; somma += ap / s.selezione.quota - 1; if (ap > s.selezione.quota) batte++; }
  return { n: conAp.length, clv_medio_pct: +(somma / conAp.length * 100).toFixed(2), pct_batte_chiusura: +(batte / conAp.length * 100).toFixed(1) };
}

const selV1 = selezioni(testRows, probA), selV2 = selezioni(testRows, probV2);
const evComparativo = {
  v1: { performance: perfSintetica(selV1), clv: clvSintetico(selV1) },
  v2: { performance: perfSintetica(selV2), clv: clvSintetico(selV2) }
};

writeFileSync('data/backtests/confronto-v2-finale.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  formula_v2: wf2.formula, parametri_v2: wf2.parametri,
  n_righe_confrontabili: righe.length,
  tabellaFinale, bootstrap_v2_vs_v1_TEST: bootstrapOut, ev_clv_comparativo_TEST: evComparativo
}, null, 1));

console.log('\n=== TABELLA FINALE ===');
for (const split of ['VALIDATION', 'TEST']) {
  console.log(`\n${split}:`);
  console.table(tabellaFinale[split]);
}
console.log('\nBootstrap v2 vs v1 (TEST):', JSON.stringify(bootstrapOut, null, 1));
console.log('\nEV/CLV comparativo (TEST):', JSON.stringify(evComparativo, null, 1));
