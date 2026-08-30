// scripts/dataset/05-significativita.mjs (v2)
// Bootstrap sulla differenza di Brier per partita, ricalcolato sul vero TEST
// 2025/26 (non piu una meta-stagione): A vs B (npxG) e A vs F (il migliore
// scelto su VALIDATION, chiunque sia).

import { readFileSync, writeFileSync } from 'node:fs';
import { correggiConElo } from '../features.mjs';
import { mercati } from '../model.mjs';
import { SPLIT } from './00-config.mjs';

const dati = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const metricheFile = JSON.parse(readFileSync('data/backtests/metriche.json', 'utf8'));
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';

function oneHot(e) { return e === 'H' ? [1, 0, 0] : e === 'D' ? [0, 1, 0] : [0, 0, 1]; }
function brierMatch(p1, px, p2, esito) { const [oh, od, oa] = oneHot(esito); return (p1 - oh) ** 2 + (px - od) ** 2 + (p2 - oa) ** 2; }

const BETA_E = metricheFile.modelE_beta_scelto;
function probF(r, nomeF) {
  const lettera = (nomeF || 'A').trim()[0];
  if (lettera === 'A') return [r.modelA.P1, r.modelA.PX, r.modelA.P2];
  if (lettera === 'B') return [r.modelB.P1, r.modelB.PX, r.modelB.P2];
  if (lettera === 'C') return r.modelC ? [r.modelC.P1, r.modelC.PX, r.modelC.P2] : null;
  if (lettera === 'D') return r.modelD ? [r.modelD.P1, r.modelD.PX, r.modelD.P2] : null;
  if (lettera === 'E') { const { lh, la } = correggiConElo(r.modelA.lambda_home, r.modelA.lambda_away, r.eloDiffPrima, BETA_E); const mk = mercati(lh, la, r.modelA.rho); return [mk['1'], mk['X'], mk['2']]; }
  return null;
}

function mulberry32(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function bootstrap(righe, estraiA, estraiAltro, nIter = 2000, seed = 42) {
  const rnd = mulberry32(seed);
  const diff = [];
  for (const r of righe) {
    const altro = estraiAltro(r); if (!altro) continue;
    const a = estraiA(r);
    diff.push(brierMatch(altro[0], altro[1], altro[2], r.esito) - brierMatch(a[0], a[1], a[2], r.esito));
  }
  const n = diff.length;
  if (!n) return { n_match: 0 };
  const medie = [];
  for (let it = 0; it < nIter; it++) { let s = 0; for (let k = 0; k < n; k++) s += diff[Math.floor(rnd() * n)]; medie.push(s / n); }
  medie.sort((a, b) => a - b);
  const media = diff.reduce((a, b) => a + b, 0) / n;
  return { n_match: n, differenza_media_osservata: +media.toFixed(5),
    ic95_basso: +medie[Math.floor(nIter * 0.025)].toFixed(5), ic95_alto: +medie[Math.floor(nIter * 0.975)].toFixed(5),
    intervallo_include_zero: medie[Math.floor(nIter * 0.025)] <= 0 && medie[Math.floor(nIter * 0.975)] >= 0 };
}

const testRighe = dati.previsioni.filter(p => splitDi(p.date) === 'TEST');
const probA = r => [r.modelA.P1, r.modelA.PX, r.modelA.P2];
const probB = r => [r.modelB.P1, r.modelB.PX, r.modelB.P2];
const nomeF = metricheFile.modelF_scelto_su_validation;

const risultato = {
  A_vs_B_TEST_2025_26: bootstrap(testRighe, probA, probB),
  [`A_vs_F(${nomeF})_TEST_2025_26`]: bootstrap(testRighe, probA, r => probF(r, nomeF)),
  perLega_A_vs_B: {}
};
for (const lega of [...new Set(testRighe.map(p => p.league))])
  risultato.perLega_A_vs_B[lega] = bootstrap(testRighe.filter(p => p.league === lega), probA, probB);

writeFileSync('data/backtests/significativita-npxg-vs-xg.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Bootstrap 2000 iterazioni, seed fisso, sul VERO TEST out-of-sample 2025/26. '
    + 'Differenza = Brier(altro) - Brier(A). Negativo = altro modello migliore. '
    + 'Zero incluso nell IC95 = differenza non distinguibile dal rumore su questo campione.',
  modelF_confrontato: nomeF, ...risultato
}, null, 1));

console.log('Significativita su TEST 2025/26:');
console.log(JSON.stringify(risultato, null, 1));
