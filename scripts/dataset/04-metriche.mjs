// scripts/dataset/04-metriche.mjs
// STEP 12-15: Brier, log loss, RPS, calibrazione. Confronta MODEL A (xG),
// MODEL B (npxG) e il mercato (no-vig sulle quote di chiusura), sugli stessi
// identici match, sullo stesso split TRAIN/VALIDATION/TEST.

import { readFileSync, writeFileSync } from 'node:fs';
import { SPLIT } from './00-config.mjs';

const dati = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const previsioni = dati.previsioni;

const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';
for (const p of previsioni) p.split = splitDi(p.date);

// esito osservato come vettore one-hot [H, D, A]
function oneHot(esito) { return esito === 'H' ? [1, 0, 0] : esito === 'D' ? [0, 1, 0] : [0, 0, 1]; }

function brier(rows, chiaviProb) {
  // media della distanza euclidea al quadrato fra probabilita previste e esito osservato
  let s = 0;
  for (const r of rows) {
    const [ph, pd, pa] = chiaviProb(r);
    const [oh, od, oa] = oneHot(r.esito);
    s += (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2;
  }
  return rows.length ? +(s / rows.length).toFixed(4) : null;
}

function logLoss(rows, chiaviProb) {
  const eps = 1e-10;
  let s = 0;
  for (const r of rows) {
    const [ph, pd, pa] = chiaviProb(r);
    const p = r.esito === 'H' ? ph : r.esito === 'D' ? pd : pa;
    s += -Math.log(Math.max(p, eps));
  }
  return rows.length ? +(s / rows.length).toFixed(4) : null;
}

function rps(rows, chiaviProb) {
  // Ranked Probability Score per 1X2: penalizza di piu' sbagliare "lontano"
  // (dare probabilita a Away quando vince Home) rispetto a sbagliare "vicino"
  // (Draw invece di Home). Ordine delle categorie: H, D, A.
  let s = 0;
  for (const r of rows) {
    const [ph, pd, pa] = chiaviProb(r);
    const [oh, od, oa] = oneHot(r.esito);
    const cp1 = ph, cp2 = ph + pd, co1 = oh, co2 = oh + od;
    s += 0.5 * ((cp1 - co1) ** 2 + (cp2 - co2) ** 2);
  }
  return rows.length ? +(s / rows.length).toFixed(4) : null;
}

const probA = (r) => [r.modelA.P1, r.modelA.PX, r.modelA.P2];
const probB = (r) => [r.modelB.P1, r.modelB.PX, r.modelB.P2];
const probMkt = (r) => [r.market.P1, r.market.PX, r.market.P2];

function calcolaTutte(rows, chiaviProb) {
  return { n: rows.length, brier: brier(rows, chiaviProb), logLoss: logLoss(rows, chiaviProb), rps: rps(rows, chiaviProb) };
}

function metrichePerSplit(righeSplit) {
  const conMercato = righeSplit.filter(r => r.market);
  return {
    n_totale: righeSplit.length, n_con_mercato: conMercato.length,
    modelA: calcolaTutte(righeSplit, probA),
    modelB: calcolaTutte(righeSplit, probB),
    market: calcolaTutte(conMercato, probMkt),
    // A e B confrontati SOLO sulle stesse righe con mercato, per un paragone equo coi tre insieme
    modelA_su_righe_con_mercato: calcolaTutte(conMercato, probA),
    modelB_su_righe_con_mercato: calcolaTutte(conMercato, probB)
  };
}

const risultato = { globale: {}, perLega: {}, perSplit: {} };
for (const s of ['TRAIN', 'VALIDATION', 'TEST'])
  risultato.perSplit[s] = metrichePerSplit(previsioni.filter(p => p.split === s));

risultato.globale = metrichePerSplit(previsioni);

for (const lega of [...new Set(previsioni.map(p => p.league))]) {
  risultato.perLega[lega] = {};
  for (const s of ['TRAIN', 'VALIDATION', 'TEST'])
    risultato.perLega[lega][s] = metrichePerSplit(previsioni.filter(p => p.league === lega && p.split === s));
}

// ---------------------------------------------------------------- calibrazione
//
// Bucket di probabilita PREVISTA per l'esito "Home" (il piu' numeroso, quindi
// il piu' stabile statisticamente), confrontata con la frequenza REALE di
// vittoria casalinga in quel bucket. Fatto per baseline (A) e per B, sia su
// VALIDATION sia su TEST separatamente: il TEST va guardato, non usato per tarare.
function calibrazione(rows, estraiP, esitoTarget) {
  const bucket = Array.from({ length: 10 }, (_, i) => ({ da: i * 10, a: (i + 1) * 10, n: 0, sommaP: 0, positivi: 0 }));
  for (const r of rows) {
    const p = estraiP(r);
    const idx = Math.min(9, Math.floor(p * 10));
    bucket[idx].n++; bucket[idx].sommaP += p;
    if (r.esito === esitoTarget) bucket[idx].positivi++;
  }
  return bucket.map(b => ({
    fascia: `${b.da}-${b.a}%`, n: b.n,
    probabilita_media_prevista: b.n ? +(b.sommaP / b.n * 100).toFixed(1) : null,
    frequenza_osservata: b.n ? +(b.positivi / b.n * 100).toFixed(1) : null
  }));
}

const calibrazioneOut = {};
for (const [nome, split] of [['VALIDATION', 'VALIDATION'], ['TEST', 'TEST']]) {
  const rows = previsioni.filter(p => p.split === split);
  calibrazioneOut[nome] = {
    modelA_home: calibrazione(rows, r => r.modelA.P1, 'H'),
    modelB_home: calibrazione(rows, r => r.modelB.P1, 'H'),
    market_home: calibrazione(rows.filter(r => r.market), r => r.market.P1, 'H')
  };
}

writeFileSync('data/backtests/metriche.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  split_config: SPLIT,
  nota: 'modelA = football-v1-baseline (xG grezzo), modelB = football-v2-understat (npxG), '
    + 'market = no-vig proporzionale sulle quote di chiusura del CSV football-data. '
    + 'RPS e Brier: piu basso e meglio. LogLoss: piu basso e meglio.',
  ...risultato
}, null, 1));

writeFileSync('data/calibration/calibrazione.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Calibrazione sull esito Home (il piu numeroso, quindi il piu stabile per bucket). '
    + 'VALIDATION e TEST separati: il TEST si guarda, non si usa per tarare nulla.',
  ...calibrazioneOut
}, null, 1));

console.log('Metriche per split:');
const riepilogo = {};
for (const [s, v] of Object.entries(risultato.perSplit)) {
  riepilogo[s] = { n: v.n_totale, brierA: v.modelA.brier, brierB: v.modelB.brier, brierMkt: v.market.brier,
    llA: v.modelA.logLoss, llB: v.modelB.logLoss, llMkt: v.market.logLoss,
    rpsA: v.modelA.rps, rpsB: v.modelB.rps, rpsMkt: v.market.rps };
}
console.table(riepilogo);
