// scripts/dataset/11-elo-ricerca.mjs
// Punti 3-4: Elo significance estesa (Brier/LogLoss/RPS, bootstrap, per lega)
// e ricerca parametri Elo (K, home advantage, regressione stagionale, prior
// neopromosse). Economico: ricalcola SOLO l'Elo storico (sequenza semplice,
// nessun punto fisso Dixon-Coles), poi applica la correzione ai lambda_A gia'
// salvati nel walk-forward. Non richiede un nuovo giro di stimaForze.

import { readFileSync, writeFileSync } from 'node:fs';
import { calcolaEloStorico, aggiornaElo, correggiConElo } from '../features.mjs';
import { mercati } from '../model.mjs';
import { LEGHE, SPLIT } from './00-config.mjs';

const dataset = JSON.parse(readFileSync('data/normalized/dataset-matched.json', 'utf8')).partite;
const wf = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';
for (const p of wf.previsioni) p.split = splitDi(p.date);

function oneHot(e) { return e === 'H' ? [1, 0, 0] : e === 'D' ? [0, 1, 0] : [0, 0, 1]; }
function brier(rows, f) { let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const [oh, od, oa] = oneHot(r.esito); s += (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2; } return rows.length ? s / rows.length : null; }
function logLoss(rows, f) { const eps = 1e-10; let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const p = r.esito === 'H' ? ph : r.esito === 'D' ? pd : pa; s += -Math.log(Math.max(p, eps)); } return rows.length ? s / rows.length : null; }
function rps(rows, f) { let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const [oh, od, oa] = oneHot(r.esito); s += 0.5 * ((ph - oh) ** 2 + (ph + pd - oh - od) ** 2); } return rows.length ? s / rows.length : null; }

// ---------------------------------------------------------------- ricalcola Elo con parametri arbitrari, PER LEGA
function eloDiffPerMatchId(config) {
  const mappa = {};
  for (const lega of LEGHE) {
    const partite = dataset.filter(r => r.league === lega.nome)
      .map(r => ({ data: new Date(r.date), stagione: r.season, casa: r.home_team, ospite: r.away_team, golCasa: r.goals_home, golOspite: r.goals_away, match_id: r.match_id }))
      .sort((a, b) => a.data - b.data);
    const elo = {}; let stagioneCorrente = null;
    const mediaLega = () => { const v = Object.values(elo); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : config.partenza; };
    for (const p of partite) {
      if (p.stagione !== stagioneCorrente) {
        if (stagioneCorrente !== null && config.regressioneStagionale > 0) { const m = mediaLega(); for (const s of Object.keys(elo)) elo[s] += config.regressioneStagionale * (m - elo[s]); }
        stagioneCorrente = p.stagione;
      }
      const prior = Object.keys(elo).length ? mediaLega() - config.handicapNeopromossa : config.partenza;
      if (elo[p.casa] === undefined) elo[p.casa] = prior;
      if (elo[p.ospite] === undefined) elo[p.ospite] = prior;
      mappa[p.match_id] = elo[p.casa] - elo[p.ospite];
      const r = aggiornaElo(elo[p.casa], elo[p.ospite], p.golCasa, p.golOspite, config);
      elo[p.casa] = r.eloCasaDopo; elo[p.ospite] = r.eloOspiteDopo;
    }
  }
  return mappa;
}

function probE(r, eloDiffMap, beta) {
  const eloDiff = eloDiffMap[r.match_id];
  if (!Number.isFinite(eloDiff) || beta === 0) return [r.modelA.P1, r.modelA.PX, r.modelA.P2];
  const { lh, la } = correggiConElo(r.modelA.lambda_home, r.modelA.lambda_away, eloDiff, beta);
  const mk = mercati(lh, la, r.modelA.rho);
  return [mk['1'], mk['X'], mk['2']];
}

// ---------------------------------------------------------------- grid search, SOLO su VALIDATION
const GRIGLIA = {
  kFactor: [10, 20, 30], vantaggioCasa: [30, 60, 90],
  regressioneStagionale: [0.10, 0.25, 0.40], handicapNeopromossa: [30, 60, 100]
};
const GRIGLIA_BETA = [0.02, 0.05, 0.08, 0.12, 0.18, 0.25];

const valRows = wf.previsioni.filter(p => p.split === 'VALIDATION');
let migliore = null;
const risultatiGrid = [];
let combinazioniTestate = 0;

// per contenere la combinatoria (3^4 * 6 = 486 combinazioni x 5 leghe di Elo
// da ricalcolare ogni volta sarebbe troppo lento): fissa 3 parametri al
// default e varia uno alla volta (coordinate search), poi una combinazione
// finale con i migliori valori trovati.
const DEFAULT = { partenza: 1500, pesoMarginale: true, kFactor: 20, vantaggioCasa: 60, regressioneStagionale: 0.25, handicapNeopromossa: 60 };
let config = { ...DEFAULT };

for (const [param, valori] of Object.entries(GRIGLIA)) {
  let bestLocale = null;
  for (const v of valori) {
    const cfgProva = { ...config, [param]: v };
    const eloMap = eloDiffPerMatchId(cfgProva);
    let bestBetaLocale = null;
    for (const beta of [0, ...GRIGLIA_BETA]) {
      const b = brier(valRows, r => probE(r, eloMap, beta));
      combinazioniTestate++;
      if (!bestBetaLocale || b < bestBetaLocale.brier) bestBetaLocale = { beta, brier: b };
    }
    risultatiGrid.push({ param, valore: v, ...bestBetaLocale });
    if (!bestLocale || bestBetaLocale.brier < bestLocale.brier) bestLocale = { valore: v, ...bestBetaLocale };
  }
  config[param] = bestLocale.valore;
  console.log(`${param}: migliore = ${bestLocale.valore} (Brier VALIDATION ${bestLocale.brier.toFixed(4)}, beta ${bestLocale.beta})`);
}

const eloMapFinale = eloDiffPerMatchId(config);
let bestBetaFinale = null;
for (const beta of [0, ...GRIGLIA_BETA]) {
  const b = brier(valRows, r => probE(r, eloMapFinale, beta));
  if (!bestBetaFinale || b < bestBetaFinale.brier) bestBetaFinale = { beta, brier: b };
}
console.log(`\nConfigurazione Elo finale (coordinate search, ${combinazioniTestate} combinazioni testate su VALIDATION):`, JSON.stringify(config));
console.log(`Beta finale: ${bestBetaFinale.beta}, Brier VALIDATION: ${bestBetaFinale.brier.toFixed(4)} (baseline A: ${brier(valRows, r => [r.modelA.P1, r.modelA.PX, r.modelA.P2]).toFixed(4)})`);

// ---------------------------------------------------------------- significativita estesa A vs E, su TEST, con la config di produzione ELO (non quella ottimizzata: separare i due confronti)
function mulberry32(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bootstrapMetrica(righe, fA, fAltro, metricaFn, nIter = 2000, seed = 7) {
  const rnd = mulberry32(seed);
  const diff = righe.map(r => { const a = fA(r), b = fAltro(r); return metricaFn([b], r.esito) - metricaFn([a], r.esito); });
  const n = diff.length; const medie = [];
  for (let it = 0; it < nIter; it++) { let s = 0; for (let k = 0; k < n; k++) s += diff[Math.floor(rnd() * n)]; medie.push(s / n); }
  medie.sort((a, b) => a - b);
  const media = diff.reduce((a, b) => a + b, 0) / n;
  return { n_match: n, differenza_media: +media.toFixed(5), ic95: [+medie[Math.floor(nIter * 0.025)].toFixed(5), +medie[Math.floor(nIter * 0.975)].toFixed(5)],
    include_zero: medie[Math.floor(nIter * 0.025)] <= 0 && medie[Math.floor(nIter * 0.975)] >= 0 };
}
const metricaBrier1 = (probArr, esito) => brierRow1(probArr[0], esito);
function brierRow1([ph, pd, pa], esito) { const [oh, od, oa] = oneHot(esito); return (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2; }
function logLossRow1([ph, pd, pa], esito) { const p = esito === 'H' ? ph : esito === 'D' ? pd : pa; return -Math.log(Math.max(p, 1e-10)); }
function rpsRow1([ph, pd, pa], esito) { const [oh, od, oa] = oneHot(esito); return 0.5 * ((ph - oh) ** 2 + (ph + pd - oh - od) ** 2); }

const testRows = wf.previsioni.filter(p => p.split === 'TEST');
const probA1 = r => [r.modelA.P1, r.modelA.PX, r.modelA.P2];
const probEProd = r => probE(r, eloMapFinale, bestBetaFinale.beta); // config ottimizzata, congelata

const eloSignificance = {
  brier: bootstrapMetrica(testRows, probA1, probEProd, (arr, e) => brierRow1(arr[0], e)),
  logLoss: bootstrapMetrica(testRows, probA1, probEProd, (arr, e) => logLossRow1(arr[0], e)),
  rps: bootstrapMetrica(testRows, probA1, probEProd, (arr, e) => rpsRow1(arr[0], e)),
  perLega: {}
};
for (const lega of LEGHE) {
  const rows = testRows.filter(r => r.league === lega.nome);
  eloSignificance.perLega[lega.nome] = bootstrapMetrica(rows, probA1, probEProd, (arr, e) => brierRow1(arr[0], e));
}

writeFileSync('data/backtests/elo-ricerca.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Coordinate search (non griglia completa, per contenere il costo): un parametro alla volta, '
    + 'partendo dai default attuali, tenendo il migliore trovato prima di passare al successivo. '
    + 'Tutto scelto SOLO su VALIDATION. Elo ricalcolato da zero per ogni combinazione (economico, '
    + 'nessun nuovo walk-forward Dixon-Coles): i lambda_A riusati sono quelli gia salvati (emivita 180gg).',
  combinazioniTestate, dettaglioGridSearch: risultatiGrid,
  configurazioneOttimale: config, betaOttimale: bestBetaFinale.beta,
  brierValidationOttimo: +bestBetaFinale.brier.toFixed(4),
  brierValidationBaseline: +brier(valRows, r => [r.modelA.P1, r.modelA.PX, r.modelA.P2]).toFixed(4),
  significance_A_vs_E_ottimizzato_TEST: eloSignificance
}, null, 1));

console.log('\nElo significance (A vs E ottimizzato) su TEST 2025/26:');
console.log('Brier:', JSON.stringify(eloSignificance.brier));
console.log('LogLoss:', JSON.stringify(eloSignificance.logLoss));
console.log('RPS:', JSON.stringify(eloSignificance.rps));
