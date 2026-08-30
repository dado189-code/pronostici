// scripts/dataset/08-ev-backtest.mjs (v2)
// STEP 15-16: EV/ROI/CLV su VALIDATION (diagnostico) e sul vero TEST 2025/26
// (la misura che conta), per MODEL A (baseline, quello in produzione) e per
// MODEL F (il migliore scelto su VALIDATION in 04-metriche). Le soglie EV
// sono le stesse per entrambi gli split, MAI scelte guardando il TEST.
// Analisi per lega inclusa, come richiesto.

import { readFileSync, writeFileSync } from 'node:fs';
import { correggiConElo } from '../features.mjs';
import { mercati } from '../model.mjs';
import { SPLIT } from './00-config.mjs';

const dati = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const metricheFile = JSON.parse(readFileSync('data/backtests/metriche.json', 'utf8'));
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';
for (const p of dati.previsioni) p.split = splitDi(p.date);

const BETA_E = metricheFile.modelE_beta_scelto;
const MODEL_F_NOME = metricheFile.modelF_scelto_su_validation; // stringa descrittiva, es. "A (baseline)"

function probModello(r, chiave) {
  if (chiave === 'A') return r.modelA ? [r.modelA.P1, r.modelA.PX, r.modelA.P2] : null;
  if (chiave === 'B') return r.modelB ? [r.modelB.P1, r.modelB.PX, r.modelB.P2] : null;
  if (chiave === 'C') return r.modelC ? [r.modelC.P1, r.modelC.PX, r.modelC.P2] : null;
  if (chiave === 'D') return r.modelD ? [r.modelD.P1, r.modelD.PX, r.modelD.P2] : null;
  if (chiave === 'E') {
    if (!Number.isFinite(r.eloDiffPrima)) return null;
    const { lh, la } = correggiConElo(r.modelA.lambda_home, r.modelA.lambda_away, r.eloDiffPrima, BETA_E);
    const mk = mercati(lh, la, r.modelA.rho);
    return [mk['1'], mk['X'], mk['2']];
  }
  return null;
}

// mappa "A (baseline)" -> 'A', "C (home/away)" -> 'C', ecc.
const chiaveF = (MODEL_F_NOME || 'A').trim()[0];

const SOGLIE = [0, 0.02, 0.05, 0.075, 0.10];

function selezioni(rows, chiaveModello) {
  const out = [];
  for (const r of rows) {
    if (!r.market) continue;
    const prob = probModello(r, chiaveModello);
    if (!prob) continue;
    const quote = [r.market.closing_home, r.market.closing_draw, r.market.closing_away];
    const lettere = ['H', 'D', 'A'];
    let migliore = null;
    for (let k = 0; k < 3; k++) {
      if (!(quote[k] > 1)) continue;
      const ev = prob[k] * quote[k] - 1;
      if (!migliore || ev > migliore.ev) migliore = { esito: lettere[k], ev, prob: prob[k], quota: quote[k] };
    }
    if (migliore) out.push({ ...r, selezione: migliore });
  }
  return out;
}

function performance(selezionate, soglia) {
  const giocate = selezionate.filter(s => s.selezione.ev >= soglia);
  if (!giocate.length) return { bets: 0 };
  let vinte = 0, pl = 0, quoteSomma = 0, probSomma = 0;
  const serie = [];
  for (const g of giocate) {
    const vince = g.selezione.esito === g.esito;
    const ritorno = vince ? g.selezione.quota - 1 : -1;
    serie.push(ritorno); pl += ritorno; quoteSomma += g.selezione.quota; probSomma += g.selezione.prob;
    if (vince) vinte++;
  }
  let picco = 0, cum = 0, maxDD = 0;
  for (const r of serie) { cum += r; picco = Math.max(picco, cum); maxDD = Math.max(maxDD, picco - cum); }
  return { bets: giocate.length, hit_rate_pct: +(vinte / giocate.length * 100).toFixed(1),
    average_odds: +(quoteSomma / giocate.length).toFixed(2), average_predicted_prob_pct: +(probSomma / giocate.length * 100).toFixed(1),
    profit_loss: +pl.toFixed(2), roi_pct: +(pl / giocate.length * 100).toFixed(2), yield_pct: +(pl / giocate.length * 100).toFixed(2),
    max_drawdown: +maxDD.toFixed(2) };
}

function clv(selezionate) {
  const conApertura = selezionate.filter(s => {
    const ap = s.selezione.esito === 'H' ? s.market.opening_home : s.selezione.esito === 'D' ? s.market.opening_draw : s.market.opening_away;
    return ap > 1;
  });
  if (!conApertura.length) return { disponibile: false };
  let somma = 0, batte = 0;
  for (const s of conApertura) {
    const ap = s.selezione.esito === 'H' ? s.market.opening_home : s.selezione.esito === 'D' ? s.market.opening_draw : s.market.opening_away;
    somma += ap / s.selezione.quota - 1; if (ap > s.selezione.quota) batte++;
  }
  return { disponibile: true, n: conApertura.length, clv_medio_pct: +(somma / conApertura.length * 100).toFixed(2),
    pct_batte_chiusura: +(batte / conApertura.length * 100).toFixed(1) };
}

function report(rows, chiaveModello) {
  const sel = selezioni(rows, chiaveModello);
  const conEV0 = sel.filter(s => s.selezione.ev >= 0);
  const out = { per_soglia: {}, clv: clv(conEV0) };
  for (const s of SOGLIE) out.per_soglia[`EV>=${(s * 100).toFixed(1)}%`] = performance(sel, s);
  return out;
}

const risultato = { modelA: {}, [`modelF(${MODEL_F_NOME})`]: {} };
for (const [chiave, label] of [['A', 'modelA'], [chiaveF, `modelF(${MODEL_F_NOME})`]]) {
  risultato[label].VALIDATION = report(dati.previsioni.filter(p => p.split === 'VALIDATION'), chiave);
  risultato[label].TEST_2025_26 = report(dati.previsioni.filter(p => p.split === 'TEST'), chiave);
}

// analisi per lega, sul TEST 2025/26, model A
const perLega = {};
for (const lega of [...new Set(dati.previsioni.map(p => p.league))]) {
  const rows = dati.previsioni.filter(p => p.split === 'TEST' && p.league === lega);
  perLega[lega] = report(rows, 'A');
}

writeFileSync('data/backtests/ev-performance.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: `MODEL F scelto su VALIDATION = ${MODEL_F_NOME} (beta Elo = ${BETA_E}). Soglie diagnostiche, mai `
    + 'ottimizzate sul TEST. TEST = intera stagione 2025/26, out-of-sample.',
  modelE_beta: BETA_E, modelF_scelto: MODEL_F_NOME,
  confronto: risultato,
  perLega_TEST_modelA: perLega
}, null, 1));

console.log('EV backtest, modelA (baseline), TEST 2025/26:');
console.table(risultato.modelA.TEST_2025_26.per_soglia);
console.log('CLV modelA TEST 2025/26:', JSON.stringify(risultato.modelA.TEST_2025_26.clv));
console.log(`\nModelF (${MODEL_F_NOME}) TEST 2025/26:`);
console.table(risultato[`modelF(${MODEL_F_NOME})`].TEST_2025_26.per_soglia);
