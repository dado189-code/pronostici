// scripts/dataset/04-metriche.mjs (v2)
// Brier, log loss, RPS per MODEL A-E, TRAIN/VALIDATION/TEST(2025/26), globale
// e per lega. MODEL E (Elo) si costruisce QUI applicando vari beta a
// eloDiffPrima (gia' salvato dal walk-forward senza leakage): il beta si
// SCEGLIE guardando solo VALIDATION, mai il TEST. MODEL F e' la combinazione
// che risulta migliore su VALIDATION fra B/C/D/E, congelata e poi valutata
// sul TEST una sola volta.

import { readFileSync, writeFileSync } from 'node:fs';
import { correggiConElo } from '../features.mjs';
import { mercati } from '../model.mjs';
import { SPLIT } from './00-config.mjs';

const dati = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const previsioni = dati.previsioni;
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';
for (const p of previsioni) p.split = splitDi(p.date);

function oneHot(e) { return e === 'H' ? [1, 0, 0] : e === 'D' ? [0, 1, 0] : [0, 0, 1]; }
function brier(rows, f) { let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const [oh, od, oa] = oneHot(r.esito); s += (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2; } return rows.length ? +(s / rows.length).toFixed(4) : null; }
function logLoss(rows, f) { const eps = 1e-10; let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const p = r.esito === 'H' ? ph : r.esito === 'D' ? pd : pa; s += -Math.log(Math.max(p, eps)); } return rows.length ? +(s / rows.length).toFixed(4) : null; }
function rps(rows, f) { let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const [oh, od, oa] = oneHot(r.esito); s += 0.5 * ((ph - oh) ** 2 + (ph + pd - oh - od) ** 2); } return rows.length ? +(s / rows.length).toFixed(4) : null; }

const probA = r => [r.modelA.P1, r.modelA.PX, r.modelA.P2];
const probB = r => [r.modelB.P1, r.modelB.PX, r.modelB.P2];
const probC = r => [r.modelC.P1, r.modelC.PX, r.modelC.P2];
const probD = r => [r.modelD.P1, r.modelD.PX, r.modelD.P2];
const probMkt = r => [r.market.P1, r.market.PX, r.market.P2];

// MODEL E: applica la correzione Elo ai lambda di A, ricava P1/PX/PA
function probE(r, beta) {
  if (beta === 0) return probA(r);
  const { lh, la } = correggiConElo(r.modelA.lambda_home, r.modelA.lambda_away, r.eloDiffPrima, beta);
  const mk = mercati(lh, la, r.modelA.rho);
  return [mk['1'], mk['X'], mk['2']];
}

function metriche(rows, f) { return { n: rows.length, brier: brier(rows, f), logLoss: logLoss(rows, f), rps: rps(rows, f) }; }

// ---------------------------------------------------------------- scelta di beta per MODEL E, SOLO su VALIDATION
const righeValConElo = previsioni.filter(p => p.split === 'VALIDATION' && Number.isFinite(p.eloDiffPrima));
const GRIGLIA_BETA = [0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.18, 0.25];
let bestBeta = { beta: 0, brier: brier(righeValConElo, probA) };
const curvaBeta = [];
for (const beta of GRIGLIA_BETA) {
  const b = brier(righeValConElo, r => probE(r, beta));
  curvaBeta.push({ beta, brier: b });
  if (b < bestBeta.brier) bestBeta = { beta, brier: b };
}
console.log(`MODEL E: beta scelto su VALIDATION = ${bestBeta.beta} (Brier VALIDATION = ${bestBeta.brier}, baseline = ${curvaBeta[0].brier})`);

// ---------------------------------------------------------------- metriche per split, tutti i modelli
function metrichePerSplit(rows) {
  const conMkt = rows.filter(r => r.market);
  const conC = rows.filter(r => r.modelC);
  const conD = rows.filter(r => r.modelD);
  const conElo = rows.filter(r => Number.isFinite(r.eloDiffPrima));
  return {
    n_totale: rows.length, n_con_mercato: conMkt.length,
    modelA: metriche(rows, probA), modelB: metriche(rows, probB),
    modelC: metriche(conC, probC), modelD: metriche(conD, probD),
    modelE: metriche(conElo, r => probE(r, bestBeta.beta)),
    market: metriche(conMkt, probMkt)
  };
}

const risultato = { globale: metrichePerSplit(previsioni), perSplit: {}, perLega: {} };
for (const s of ['TRAIN', 'VALIDATION', 'TEST']) risultato.perSplit[s] = metrichePerSplit(previsioni.filter(p => p.split === s));
for (const lega of [...new Set(previsioni.map(p => p.league))]) {
  risultato.perLega[lega] = {};
  for (const s of ['TRAIN', 'VALIDATION', 'TEST']) risultato.perLega[lega][s] = metrichePerSplit(previsioni.filter(p => p.league === lega && p.split === s));
}

// ---------------------------------------------------------------- MODEL F: la migliore combinazione, scelta SOLO su VALIDATION
const val = risultato.perSplit.VALIDATION;
const candidati = [
  { nome: 'B (npxG)', brier: val.modelB.brier }, { nome: 'C (home/away)', brier: val.modelC.brier },
  { nome: 'D (shrink opponent)', brier: val.modelD.brier }, { nome: 'E (Elo, beta=' + bestBeta.beta + ')', brier: val.modelE.brier }
];
const migliore = candidati.reduce((m, c) => (c.brier !== null && c.brier < m.brier) ? c : m, { nome: 'A (baseline)', brier: val.modelA.brier });
console.log(`MODEL F scelto su VALIDATION: ${migliore.nome} (Brier VALIDATION ${migliore.brier} contro baseline ${val.modelA.brier})`);

// ---------------------------------------------------------------- calibrazione 1X2 completa + ECE, per split
function calibrazione1X2(rows, chiaveModello) {
  const esiti = [['H', 'P1'], ['D', 'PX'], ['A', 'P2']];
  const out = {};
  for (const [esitoLettera, campo] of esiti) {
    const bucket = Array.from({ length: 10 }, (_, i) => ({ da: i * 10, a: (i + 1) * 10, n: 0, sommaP: 0, positivi: 0 }));
    for (const r of rows) {
      if (!r[chiaveModello]) continue;
      const p = r[chiaveModello][campo];
      const idx = Math.min(9, Math.floor(p * 10));
      bucket[idx].n++; bucket[idx].sommaP += p; if (r.esito === esitoLettera) bucket[idx].positivi++;
    }
    let ece = 0, nTot = 0;
    const tab = bucket.map(b => {
      const probMedia = b.n ? b.sommaP / b.n : null, freq = b.n ? b.positivi / b.n : null;
      if (b.n) { ece += b.n * Math.abs(probMedia - freq); nTot += b.n; }
      return { fascia: `${b.da}-${b.a}%`, n: b.n, probabilita_media_prevista: probMedia !== null ? +(probMedia * 100).toFixed(1) : null, frequenza_osservata: freq !== null ? +(freq * 100).toFixed(1) : null };
    });
    out[esitoLettera] = { bucket: tab, ECE: nTot ? +(ece / nTot).toFixed(4) : null };
  }
  return out;
}

const calibrazioneOut = {
  TEST_modelA: calibrazione1X2(previsioni.filter(p => p.split === 'TEST'), 'modelA'),
  TEST_market: calibrazione1X2(previsioni.filter(p => p.split === 'TEST'), 'market'),
  VALIDATION_modelA: calibrazione1X2(previsioni.filter(p => p.split === 'VALIDATION'), 'modelA')
};

writeFileSync('data/backtests/metriche.json', JSON.stringify({
  generato_il: new Date().toISOString(), split_config: SPLIT,
  nota: 'modelA=football-v1-baseline(xG), modelB=npxG, modelC=home/away split, modelD=opponent adjustment '
    + 'con shrinkage esplicito, modelE=Elo come correzione ai lambda (beta scelto su VALIDATION), '
    + 'market=no-vig su quote di chiusura. TEST=2025/26 intera, mai usata per scegliere beta/soglie.',
  modelE_beta_scelto: bestBeta.beta, modelE_curva_beta_validation: curvaBeta,
  modelF_scelto_su_validation: migliore.nome,
  globale: risultato.globale, perSplit: risultato.perSplit, perLega: risultato.perLega
}, null, 1));

writeFileSync('data/calibration/calibrazione.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Calibrazione 1X2 completa (H, D, A separati) con Expected Calibration Error (ECE): '
    + 'media pesata, sui bucket, di |probabilita media prevista - frequenza osservata|.',
  ...calibrazioneOut
}, null, 1));

console.log('\nMetriche per split (Brier):');
const riepilogo = {};
for (const [s, v] of Object.entries(risultato.perSplit))
  riepilogo[s] = { n: v.n_totale, A: v.modelA.brier, B: v.modelB.brier, C: v.modelC.brier, D: v.modelD.brier, E: v.modelE.brier, mercato: v.market.brier };
console.table(riepilogo);
