// scripts/dataset/20-drawcal-bootstrap.mjs
// FASE 8, Parte 1, punto 3: bootstrap multi-stagione, aggregando i fold 2 e 3
// della validazione (quelli con campione di calibrazione sufficiente — il
// fold 1, calibrato su una sola stagione, ha gia mostrato instabilita nello
// script precedente e viene escluso dal pool "buono", riportato a parte).

import { readFileSync, writeFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));

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
function rinormalizza(p1, p2, pxCal) { const ro = p1 + p2, rn = 1 - pxCal; const s = ro > 0 ? rn / ro : 0.5; return { P1: p1 * s, PX: pxCal, P2: p2 * s }; }

function oneHot(e) { return e === 'H' ? [1, 0, 0] : e === 'D' ? [0, 1, 0] : [0, 0, 1]; }
function brierRow([ph, pd, pa], e) { const [oh, od, oa] = oneHot(e); return (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2; }
function logLossRow([ph, pd, pa], e) { const p = e === 'H' ? ph : e === 'D' ? pd : pa; return -Math.log(Math.max(p, 1e-10)); }
function rpsRow([ph, pd, pa], e) { const [oh, od, oa] = oneHot(e); return 0.5 * ((ph - oh) ** 2 + (ph + pd - oh - od) ** 2); }
function drawBrierRow(pd, e) { return (pd - (e === 'D' ? 1 : 0)) ** 2; }

// ---------------------------------------------------------------- costruisce il pool OOS "buono": fold 2 (OOS 2024/25) + fold 3 (OOS 2025/26),
// ognuno calibrato SOLO sulle stagioni precedenti al proprio fold (nessun leakage fra fold)
const FOLD_BUONI = [
  { calibraSu: ['2022/23', '2023/24'], valutaSu: '2024/25' },
  { calibraSu: ['2022/23', '2023/24', '2024/25'], valutaSu: '2025/26' }
];
const FOLD_INSTABILE = { calibraSu: ['2022/23'], valutaSu: '2023/24' };

function applicaFold(fold) {
  const righeCal = wf.previsioni.filter(p => fold.calibraSu.includes(p.season));
  const righeOOS = wf.previsioni.filter(p => p.season === fold.valutaSu);
  const blocchi = isotonicFit(righeCal.map(p => ({ x: p.modelA.PX, y: p.esito === 'D' ? 1 : 0 })));
  return righeOOS.map(r => {
    const cal = rinormalizza(r.modelA.P1, r.modelA.P2, isotonicPredict(blocchi, r.modelA.PX));
    return { esito: r.esito, base: [r.modelA.P1, r.modelA.PX, r.modelA.P2], cal: [cal.P1, cal.PX, cal.P2] };
  });
}

const poolBuono = FOLD_BUONI.flatMap(applicaFold);
const poolInstabile = applicaFold(FOLD_INSTABILE);

function mulberry32(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bootstrap(rows, metricaFn, nIter = 3000, seed = 77) {
  const rnd = mulberry32(seed);
  const diff = rows.map(r => metricaFn(r.cal, r.esito) - metricaFn(r.base, r.esito));
  const n = diff.length; const medie = [];
  for (let it = 0; it < nIter; it++) { let s = 0; for (let k = 0; k < n; k++) s += diff[Math.floor(rnd() * n)]; medie.push(s / n); }
  medie.sort((a, b) => a - b);
  const m = diff.reduce((a, b) => a + b, 0) / n;
  const basso = medie[Math.floor(nIter * 0.025)], alto = medie[Math.floor(nIter * 0.975)];
  const includeZero = basso <= 0 && alto >= 0;
  const verdetto = includeZero ? 'INCONCLUSIVE' : (m < 0 && alto < 0 ? (Math.abs(m) > 0.005 ? 'ROBUST' : 'LIKELY') : 'NEGATIVE');
  return { n, differenza_media: +m.toFixed(5), ic95: [+basso.toFixed(5), +alto.toFixed(5)], verdetto };
}

const risultato = {
  pool_buono_n: poolBuono.length,
  brier: bootstrap(poolBuono, brierRow),
  logLoss: bootstrap(poolBuono, logLossRow),
  rps: bootstrap(poolBuono, rpsRow),
  draw_brier: bootstrap(poolBuono, (p, e) => drawBrierRow(p[1], e)),
  pool_instabile_n: poolInstabile.length,
  logLoss_fold_instabile: bootstrap(poolInstabile, logLossRow)
};

console.log('Bootstrap multi-stagione, pool BUONO (fold 2+3, calibratore con >=3000 partite):');
console.log(JSON.stringify({ brier: risultato.brier, logLoss: risultato.logLoss, rps: risultato.rps, draw_brier: risultato.draw_brier }, null, 1));
console.log('\nBootstrap fold INSTABILE (calibrato su 1 sola stagione, n cal=1325):');
console.log(JSON.stringify(risultato.logLoss_fold_instabile, null, 1));

const raccomandazioneStabilita = risultato.logLoss_fold_instabile.verdetto === 'NEGATIVE'
  ? 'CONFERMATO: con meno di ~2 stagioni di calibrazione (circa 3000 partite) il calibratore isotonic e instabile e PEGGIORA il LogLoss in modo statisticamente significativo. Soglia minima raccomandata prima di attivare DC-DRAW-CAL: almeno 2 stagioni complete nel pool di calibrazione.'
  : 'Il fold a campione ridotto non mostra un danno statisticamente significativo, ma la mappa isotonic risultava comunque grossolana (blocchi ampi): cautela raccomandata sotto le 2 stagioni.';

writeFileSync('data/backtests/drawcal-bootstrap-multistagione.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Pool BUONO = fold 2 (calibra 2022/23+2023/24, valuta 2024/25) + fold 3 (calibra fino a 2024/25, valuta 2025/26). '
    + 'Ogni riga OOS entra nel bootstrap una sola volta, mai ricalibrata sulla propria stagione.',
  ...risultato,
  raccomandazione_stabilita: raccomandazioneStabilita,
  classificazione_finale: (risultato.brier.verdetto === 'INCONCLUSIVE' && risultato.logLoss.verdetto !== 'NEGATIVE' && risultato.rps.verdetto !== 'NEGATIVE' && risultato.draw_brier.verdetto !== 'NEGATIVE')
    ? (risultato.draw_brier.verdetto === 'ROBUST' || risultato.draw_brier.verdetto === 'LIKELY' ? 'LIKELY: migliora il draw brier senza danno sui proper score aggregati, ma richiede >=2 stagioni di calibrazione' : 'INCONCLUSIVE su tutte le metriche aggregate')
    : 'vedi dettaglio per metrica'
}, null, 1));
console.log('\nRaccomandazione stabilita:', raccomandazioneStabilita);
