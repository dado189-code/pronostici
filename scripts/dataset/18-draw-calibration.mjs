// scripts/dataset/18-draw-calibration.mjs
// FASE 7, punto 19: calibratore SOLO per P_DRAW di Dixon-Coles, appreso su
// TRAIN/VALIDATION, poi rinormalizzato con P_HOME/P_AWAY. Chiamato
// DC-DRAW-CAL. Isotonic univariata (P_DRAW grezzo -> P_DRAW calibrato),
// implementata a mano (pool-adjacent-violators, nessuna libreria): e' un
// problema 1-dimensionale, non serve scikit-learn per questo.

import { readFileSync, writeFileSync } from 'node:fs';
import { SPLIT } from './00-config.mjs';

const wf = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';
for (const p of wf.previsioni) p.split = splitDi(p.date);

const trainVal = wf.previsioni.filter(p => p.split === 'TRAIN' || p.split === 'VALIDATION');
const testRows = wf.previsioni.filter(p => p.split === 'TEST');

// ---------------------------------------------------------------- isotonic regression 1D (pool-adjacent-violators)
// input: coppie (x, y) con x=P_DRAW grezzo, y=1 se pareggio osservato altrimenti 0.
// Ordina per x, poi unisce blocchi adiacenti finche' la sequenza e' monotona crescente.
function isotonicFit(punti) {
  const ordinati = [...punti].sort((a, b) => a.x - b.x);
  const blocchi = ordinati.map(p => ({ sommaY: p.y, n: 1, xMin: p.x, xMax: p.x }));
  let i = 0;
  while (i < blocchi.length - 1) {
    const medioA = blocchi[i].sommaY / blocchi[i].n, medioB = blocchi[i + 1].sommaY / blocchi[i + 1].n;
    if (medioA > medioB) {
      blocchi[i] = { sommaY: blocchi[i].sommaY + blocchi[i + 1].sommaY, n: blocchi[i].n + blocchi[i + 1].n, xMin: blocchi[i].xMin, xMax: blocchi[i + 1].xMax };
      blocchi.splice(i + 1, 1);
      if (i > 0) i--;
    } else i++;
  }
  return blocchi.map(b => ({ xMin: b.xMin, xMax: b.xMax, y: b.sommaY / b.n }));
}
// La isotonic regression vera e' una funzione A GRADINI, non interpolata: ogni
// punto di training appartiene a esattamente un blocco PAV, e blocchi/punti
// insieme coprono l'intero asse senza buchi. Trova il primo blocco il cui
// xMax e' >= x (i blocchi sono ordinati per costruzione); se x supera tutto,
// usa l'ultimo. La versione precedente interpolava linearmente fra i centri
// dei blocchi, il che e' un errore concettuale (non e' isotonic regression)
// e produceva valori assurdi quando i blocchi erano molto vicini fra loro.
function isotonicPredict(blocchi, x) {
  for (const b of blocchi) if (x <= b.xMax) return b.y;
  return blocchi.at(-1).y;
}

const puntiFit = trainVal.map(p => ({ x: p.modelA.PX, y: p.esito === 'D' ? 1 : 0 }));
const blocchiIso = isotonicFit(puntiFit);

function applicaDrawCal(p) {
  const pxCal = isotonicPredict(blocchiIso, p.modelA.PX);
  // rinormalizza P1/P2 mantenendone il rapporto reciproco, cosi' la somma torna a 1
  const restoOriginale = p.modelA.P1 + p.modelA.P2;
  const restoNuovo = 1 - pxCal;
  const scala = restoOriginale > 0 ? restoNuovo / restoOriginale : 0.5;
  return { P1: p.modelA.P1 * scala, PX: pxCal, P2: p.modelA.P2 * scala };
}

function oneHot(e) { return e === 'H' ? [1, 0, 0] : e === 'D' ? [0, 1, 0] : [0, 0, 1]; }
function brier(rows, f) { let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const [oh, od, oa] = oneHot(r.esito); s += (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2; } return +(s / rows.length).toFixed(4); }
function logLoss(rows, f) { const eps = 1e-10; let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const p = r.esito === 'H' ? ph : r.esito === 'D' ? pd : pa; s += -Math.log(Math.max(p, eps)); } return +(s / rows.length).toFixed(4); }
function rps(rows, f) { let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const [oh, od, oa] = oneHot(r.esito); s += 0.5 * ((ph - oh) ** 2 + (ph + pd - oh - od) ** 2); } return +(s / rows.length).toFixed(4); }
function ece(rows, campo, esitoLettera) {
  const bucket = Array.from({ length: 10 }, () => ({ n: 0, sommaP: 0, positivi: 0 }));
  for (const r of rows) { const p = campo(r); const idx = Math.min(9, Math.floor(p * 10)); bucket[idx].n++; bucket[idx].sommaP += p; if (r.esito === esitoLettera) bucket[idx].positivi++; }
  let e = 0, n = 0; for (const b of bucket) if (b.n) { e += b.n * Math.abs(b.sommaP / b.n - b.positivi / b.n); n += b.n; }
  return n ? +(e / n).toFixed(4) : null;
}

const probA = r => [r.modelA.P1, r.modelA.PX, r.modelA.P2];
const probCal = r => { const c = applicaDrawCal(r); return [c.P1, c.PX, c.P2]; };

const metrichePer = (rows) => ({
  baseline: { brier: brier(rows, probA), logLoss: logLoss(rows, probA), rps: rps(rows, probA), ece_draw: ece(rows, r => r.modelA.PX, 'D') },
  DC_DRAW_CAL: { brier: brier(rows, probCal), logLoss: logLoss(rows, probCal), rps: rps(rows, probCal), ece_draw: ece(rows, r => applicaDrawCal(r).PX, 'D') }
});

const risultatoValidation = metrichePer(wf.previsioni.filter(p => p.split === 'VALIDATION'));
const risultatoTest = metrichePer(testRows);

console.log('VALIDATION (usata per fittare la isotonic):', JSON.stringify(risultatoValidation, null, 1));
console.log('TEST (mai vista dal calibratore):', JSON.stringify(risultatoTest, null, 1));

// ---------------------------------------------------------------- bootstrap su TEST
function mulberry32(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function brierRow([ph, pd, pa], e) { const [oh, od, oa] = oneHot(e); return (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2; }
function logLossRow([ph, pd, pa], e) { const p = e === 'H' ? ph : e === 'D' ? pd : pa; return -Math.log(Math.max(p, 1e-10)); }
function rpsRow([ph, pd, pa], e) { const [oh, od, oa] = oneHot(e); return 0.5 * ((ph - oh) ** 2 + (ph + pd - oh - od) ** 2); }
function bootstrap(rows, metricaFn, nIter = 2000, seed = 55) {
  const rnd = mulberry32(seed);
  const diff = rows.map(r => metricaFn(probCal(r), r.esito) - metricaFn(probA(r), r.esito));
  const n = diff.length; const medie = [];
  for (let it = 0; it < nIter; it++) { let s = 0; for (let k = 0; k < n; k++) s += diff[Math.floor(rnd() * n)]; medie.push(s / n); }
  medie.sort((a, b) => a - b);
  const m = diff.reduce((a, b) => a + b, 0) / n;
  const basso = medie[Math.floor(nIter * 0.025)], alto = medie[Math.floor(nIter * 0.975)];
  const includeZero = basso <= 0 && alto >= 0;
  const verdetto = includeZero ? 'INCONCLUSIVE' : (m < 0 && alto < 0 ? (Math.abs(m) > 0.005 ? 'SIGNIFICANT' : 'LIKELY') : 'NEGATIVE');
  return { differenza_media: +m.toFixed(5), ic95: [+basso.toFixed(5), +alto.toFixed(5)], verdetto };
}
const bootstrapOut = { brier: bootstrap(testRows, brierRow), logLoss: bootstrap(testRows, logLossRow), rps: bootstrap(testRows, rpsRow) };
console.log('\nBootstrap DC-DRAW-CAL vs baseline (TEST):', JSON.stringify(bootstrapOut, null, 1));

const eceMiglioraSostanzialmente = risultatoTest.baseline.ece_draw - risultatoTest.DC_DRAW_CAL.ece_draw > 0.01;
const nessunDannoProperScores = ['brier', 'logLoss', 'rps'].every(m => bootstrapOut[m].verdetto !== 'NEGATIVE');
const raccomandazione = !nessunDannoProperScores
  ? 'NON usare: migliora ECE Draw ma peggiora almeno un proper scoring rule in modo significativo — esattamente il caso che la richiesta chiedeva di scartare'
  : (eceMiglioraSostanzialmente
    ? `USARE: ECE Draw migliora da ${risultatoTest.baseline.ece_draw} a ${risultatoTest.DC_DRAW_CAL.ece_draw} (${((1 - risultatoTest.DC_DRAW_CAL.ece_draw / risultatoTest.baseline.ece_draw) * 100).toFixed(0)}% in meno) `
      + 'sul TEST, senza alcun costo statisticamente misurabile su Brier/LogLoss/RPS (tutti INCONCLUSIVE, differenze vicino a zero). '
      + 'E un miglioramento di calibrazione pura, non di accuratezza probabilistica aggregata: la probabilita di pareggio diventa piu affidabile '
      + 'da leggere, il punteggio complessivo del modello non cambia in modo dimostrabile.'
    : 'Inconcludente su tutti i proper scoring rule e guadagno ECE non sostanziale: nessun danno ma nessun beneficio chiaro');

writeFileSync('data/backtests/dc-draw-cal.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  metodo: 'Isotonic regression 1D (pool-adjacent-violators, implementazione propria) su P_DRAW grezzo, '
    + 'fittata su TRAIN+VALIDATION. P_HOME e P_AWAY rinormalizzati mantenendo il rapporto reciproco.',
  validation: risultatoValidation, test: risultatoTest, bootstrap_vs_baseline_TEST: bootstrapOut,
  raccomandazione
}, null, 1));
console.log('\nRaccomandazione:', raccomandazione);
