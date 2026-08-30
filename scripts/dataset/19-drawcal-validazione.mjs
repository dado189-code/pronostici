// scripts/dataset/19-drawcal-validazione.mjs
// FASE 8, Parte 1: walk-forward expanding-window multi-stagione per
// DC-DRAW-CAL. Tre fold, ognuno strettamente temporale:
//   fold 1: calibra su 2022/23              -> valuta OOS su 2023/24
//   fold 2: calibra su 2022/23+2023/24       -> valuta OOS su 2024/25
//   fold 3: calibra su 2022/23+2023/24+2024/25 -> valuta OOS su 2025/26
// In nessun fold il calibratore vede la stagione che sta valutando: le
// probabilita' Dixon-Coles (modelA) usate qui vengono dal walk-forward gia'
// validato (anti-leakage sui lambda), la calibrazione aggiunge un secondo
// livello di separazione temporale sopra quella gia' esistente.

import { readFileSync, writeFileSync } from 'node:fs';
import { LEGHE } from './00-config.mjs';

const wf = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const STAGIONI_ORDINE = ['2022/23', '2023/24', '2024/25', '2025/26'];

// ---------------------------------------------------------------- isotonic 1D (PAV), stessa implementazione corretta della Fase 7
function isotonicFit(punti) {
  const ordinati = [...punti].sort((a, b) => a.x - b.x);
  const blocchi = ordinati.map(p => ({ sommaY: p.y, n: 1, xMin: p.x, xMax: p.x }));
  let i = 0;
  while (i < blocchi.length - 1) {
    const mA = blocchi[i].sommaY / blocchi[i].n, mB = blocchi[i + 1].sommaY / blocchi[i + 1].n;
    if (mA > mB) { blocchi[i] = { sommaY: blocchi[i].sommaY + blocchi[i + 1].sommaY, n: blocchi[i].n + blocchi[i + 1].n, xMin: blocchi[i].xMin, xMax: blocchi[i + 1].xMax }; blocchi.splice(i + 1, 1); if (i > 0) i--; }
    else i++;
  }
  return blocchi.map(b => ({ xMin: b.xMin, xMax: b.xMax, y: b.sommaY / b.n }));
}
function isotonicPredict(blocchi, x) { for (const b of blocchi) if (x <= b.xMax) return b.y; return blocchi.at(-1).y; }

// ---------------------------------------------------------------- calibrazione logistica univariata (Platt), come benchmark piu semplice
// P_calibrata = sigmoid(a * logit(P_raw) + b), appresa per massima verosimiglianza
// con discesa del gradiente (poche righe, nessuna libreria: e' un problema a 2 parametri).
function logit(p) { const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(c / (1 - c)); }
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function plattFit(punti, iterazioni = 2000, lr = 0.1) {
  let a = 1, b = 0;
  const xs = punti.map(p => logit(p.x)), ys = punti.map(p => p.y);
  const n = xs.length;
  for (let it = 0; it < iterazioni; it++) {
    let ga = 0, gb = 0;
    for (let i = 0; i < n; i++) { const pred = sigmoid(a * xs[i] + b); const err = pred - ys[i]; ga += err * xs[i]; gb += err; }
    a -= lr * ga / n; b -= lr * gb / n;
  }
  return { a, b };
}
function plattPredict(modello, x) { return sigmoid(modello.a * logit(x) + modello.b); }

function rinormalizza(p1, p2, pxCal) {
  const restoOriginale = p1 + p2, restoNuovo = 1 - pxCal;
  const scala = restoOriginale > 0 ? restoNuovo / restoOriginale : 0.5;
  return { P1: p1 * scala, PX: pxCal, P2: p2 * scala };
}

function oneHot(e) { return e === 'H' ? [1, 0, 0] : e === 'D' ? [0, 1, 0] : [0, 0, 1]; }
function brier(rows, f) { let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const [oh, od, oa] = oneHot(r.esito); s += (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2; } return rows.length ? +(s / rows.length).toFixed(4) : null; }
function logLoss(rows, f) { const eps = 1e-10; let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const p = r.esito === 'H' ? ph : r.esito === 'D' ? pd : pa; s += -Math.log(Math.max(p, eps)); } return rows.length ? +(s / rows.length).toFixed(4) : null; }
function rps(rows, f) { let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const [oh, od, oa] = oneHot(r.esito); s += 0.5 * ((ph - oh) ** 2 + (ph + pd - oh - od) ** 2); } return rows.length ? +(s / rows.length).toFixed(4) : null; }
function ece(rows, campo, esitoLettera) {
  const bucket = Array.from({ length: 10 }, () => ({ n: 0, sommaP: 0, positivi: 0 }));
  for (const r of rows) { const p = campo(r); const idx = Math.min(9, Math.floor(p * 10)); bucket[idx].n++; bucket[idx].sommaP += p; if (r.esito === esitoLettera) bucket[idx].positivi++; }
  let e = 0, n = 0; for (const b of bucket) if (b.n) { e += b.n * Math.abs(b.sommaP / b.n - b.positivi / b.n); n += b.n; }
  return n ? +(e / n).toFixed(4) : null;
}
function media(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

const probBase = r => [r.modelA.P1, r.modelA.PX, r.modelA.P2];

// ---------------------------------------------------------------- fold expanding-window
const FOLD = [
  { calibraSu: ['2022/23'], valutaSu: '2023/24' },
  { calibraSu: ['2022/23', '2023/24'], valutaSu: '2024/25' },
  { calibraSu: ['2022/23', '2023/24', '2024/25'], valutaSu: '2025/26' }
];

const risultatiFold = [];
for (const fold of FOLD) {
  const righeCal = wf.previsioni.filter(p => fold.calibraSu.includes(p.season));
  const righeOOS = wf.previsioni.filter(p => p.season === fold.valutaSu);

  const puntiFit = righeCal.map(p => ({ x: p.modelA.PX, y: p.esito === 'D' ? 1 : 0 }));
  const blocchiIso = isotonicFit(puntiFit);
  const plattModel = plattFit(puntiFit);

  const probIso = r => { const c = rinormalizza(r.modelA.P1, r.modelA.P2, isotonicPredict(blocchiIso, r.modelA.PX)); return [c.P1, c.PX, c.P2]; };
  const probPlatt = r => { const c = rinormalizza(r.modelA.P1, r.modelA.P2, plattPredict(plattModel, r.modelA.PX)); return [c.P1, c.PX, c.P2]; };

  const perLega = {};
  for (const lega of LEGHE) {
    const rows = righeOOS.filter(r => r.league === lega.nome);
    if (!rows.length) continue;
    perLega[lega.nome] = {
      n: rows.length,
      predicted_draw_base_pct: +(media(rows.map(r => r.modelA.PX)) * 100).toFixed(1),
      predicted_draw_iso_pct: +(media(rows.map(r => probIso(r)[1])) * 100).toFixed(1),
      observed_draw_pct: +(rows.filter(r => r.esito === 'D').length / rows.length * 100).toFixed(1),
      ece_draw_base: ece(rows, r => r.modelA.PX, 'D'), ece_draw_iso: ece(rows, r => probIso(r)[1], 'D'),
      brier_base: brier(rows, probBase), brier_iso: brier(rows, probIso)
    };
  }

  risultatiFold.push({
    fold: `calibra[${fold.calibraSu.join('+')}] -> valuta[${fold.valutaSu}]`,
    n_calibrazione: righeCal.length, n_oos: righeOOS.length,
    baseline: { brier: brier(righeOOS, probBase), logLoss: logLoss(righeOOS, probBase), rps: rps(righeOOS, probBase),
      ece_home: ece(righeOOS, r => r.modelA.P1, 'H'), ece_draw: ece(righeOOS, r => r.modelA.PX, 'D'), ece_away: ece(righeOOS, r => r.modelA.P2, 'A') },
    isotonic: { brier: brier(righeOOS, probIso), logLoss: logLoss(righeOOS, probIso), rps: rps(righeOOS, probIso),
      ece_home: ece(righeOOS, r => probIso(r)[0], 'H'), ece_draw: ece(righeOOS, r => probIso(r)[1], 'D'), ece_away: ece(righeOOS, r => probIso(r)[2], 'A') },
    platt: { brier: brier(righeOOS, probPlatt), logLoss: logLoss(righeOOS, probPlatt), rps: rps(righeOOS, probPlatt),
      ece_home: ece(righeOOS, r => probPlatt(r)[0], 'H'), ece_draw: ece(righeOOS, r => probPlatt(r)[1], 'D'), ece_away: ece(righeOOS, r => probPlatt(r)[2], 'A') },
    per_lega: perLega,
    // mappa di stabilita: cosa fa il calibratore isotonic a tre valori di riferimento
    mappa_stabilita: { raw_020: +isotonicPredict(blocchiIso, 0.20).toFixed(3), raw_025: +isotonicPredict(blocchiIso, 0.25).toFixed(3), raw_030: +isotonicPredict(blocchiIso, 0.30).toFixed(3) },
    platt_params: { a: +plattModel.a.toFixed(3), b: +plattModel.b.toFixed(3) }
  });
}

console.log('=== VALIDAZIONE MULTI-STAGIONE DC-DRAW-CAL ===\n');
for (const f of risultatiFold) {
  console.log(f.fold, `(cal n=${f.n_calibrazione}, oos n=${f.n_oos})`);
  console.table({ baseline: f.baseline, isotonic: f.isotonic, platt: f.platt });
  console.log('Mappa stabilita (raw -> calibrato):', JSON.stringify(f.mappa_stabilita), '| Platt (a,b):', JSON.stringify(f.platt_params));
  console.log('');
}

writeFileSync('data/backtests/drawcal-validazione-multistagione.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Expanding window, ogni fold calibra solo su stagioni STRETTAMENTE precedenti a quella valutata. '
    + 'isotonic = PAV 1D su P_DRAW. platt = calibrazione logistica univariata (2 parametri, discesa del gradiente).',
  fold: risultatiFold
}, null, 1));
