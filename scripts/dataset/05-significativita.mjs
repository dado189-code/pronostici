// scripts/dataset/05-significativita.mjs
// STEP 14: non basta che B abbia un Brier piu basso di A, va misurato se la
// differenza e' distinguibile dal rumore. Bootstrap per-match sulla
// differenza di Brier (B - A): ricampiona con reimmissione le partite,
// ricalcola la differenza media 1000 volte, guarda l'intervallo al 95%.
// Se l'intervallo include 0, il "miglioramento" non e' distinguibile dal caso.

import { readFileSync, writeFileSync } from 'node:fs';
import { SPLIT } from './00-config.mjs';

const dati = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';

function oneHot(esito) { return esito === 'H' ? [1, 0, 0] : esito === 'D' ? [0, 1, 0] : [0, 0, 1]; }
function brierMatch(p1, px, p2, esito) {
  const [oh, od, oa] = oneHot(esito);
  return (p1 - oh) ** 2 + (px - od) ** 2 + (p2 - oa) ** 2;
}

// generatore deterministico (nessun Math.random qui: lo script deve dare
// sempre lo stesso risultato se rilanciato sugli stessi dati)
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrap(righe, nIter = 2000, seed = 42) {
  const rnd = mulberry32(seed);
  const diffPerMatch = righe.map(r =>
    brierMatch(r.modelB.P1, r.modelB.PX, r.modelB.P2, r.esito) - brierMatch(r.modelA.P1, r.modelA.PX, r.modelA.P2, r.esito));
  const n = diffPerMatch.length;
  const medie = [];
  for (let it = 0; it < nIter; it++) {
    let s = 0;
    for (let k = 0; k < n; k++) s += diffPerMatch[Math.floor(rnd() * n)];
    medie.push(s / n);
  }
  medie.sort((a, b) => a - b);
  const media = diffPerMatch.reduce((a, b) => a + b, 0) / n;
  return {
    n_match: n, differenza_media_osservata: +media.toFixed(5), // negativo = B migliora A (Brier piu basso)
    ic95_basso: +medie[Math.floor(nIter * 0.025)].toFixed(5),
    ic95_alto: +medie[Math.floor(nIter * 0.975)].toFixed(5),
    intervallo_include_zero: medie[Math.floor(nIter * 0.025)] <= 0 && medie[Math.floor(nIter * 0.975)] >= 0
  };
}

const risultato = {};
for (const s of ['VALIDATION', 'TEST']) {
  const righe = dati.previsioni.filter(p => splitDi(p.date) === s);
  risultato[s] = bootstrap(righe);
}
// anche per lega su VALIDATION+TEST insieme, dove il campione per singolo split e' piccolo
const righeVT = dati.previsioni.filter(p => splitDi(p.date) !== 'TRAIN');
risultato.VALIDATION_e_TEST_insieme = bootstrap(righeVT);
risultato.perLega = {};
for (const lega of [...new Set(dati.previsioni.map(p => p.league))])
  risultato.perLega[lega] = bootstrap(righeVT.filter(p => p.league === lega));

writeFileSync('data/backtests/significativita-npxg-vs-xg.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Bootstrap 2000 iterazioni, seed fisso (riproducibile). Differenza = Brier(modelB) - Brier(modelA). '
    + 'Negativa = npxG migliora rispetto a xG grezzo. Se intervallo_include_zero e vero, la differenza '
    + 'non e distinguibile dal rumore statistico su questo campione.',
  ...risultato
}, null, 1));

console.log('Significativita (Brier B - Brier A, negativo = B meglio):');
console.log(JSON.stringify(risultato, null, 1));
