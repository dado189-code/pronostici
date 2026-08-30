// scripts/dataset/16-rest-fatigue.mjs
// FASE 7, punto 16 + 26: rest/fatigue e' l'unica feature di questa fase che
// non richiede nessun provider nuovo — days_since_last_match e
// matches_last_N si derivano interamente dal calendario gia' scaricato.
// Ablation R0 (baseline) -> R1 (RestDiff) -> R2 (matches_last_7/14/21) ->
// R3 (miglior combinazione), tutto scelto SOLO su VALIDATION.
//
// Metodo: non serve un nuovo walk-forward Dixon-Coles. Si prende lambda_home/
// lambda_away GIA' stimati dal modello v1 (che non dipendono da rest/fatigue),
// e si applica una correzione moltiplicativa appresa: stessa logica gia'
// usata per Elo in Fase 5 (correggiConElo), qui generalizzata a RestDiff.

import { readFileSync, writeFileSync } from 'node:fs';
import { mercati } from '../model.mjs';
import { LEGHE, SPLIT } from './00-config.mjs';

const dataset = JSON.parse(readFileSync('data/normalized/dataset-matched.json', 'utf8')).partite;
const wf = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';
for (const p of wf.previsioni) p.split = splitDi(p.date);

// ---------------------------------------------------------------- calendario per squadra, per lega (le coppe europee non sono nel dataset: dichiarato limite)
const calendarioSquadra = {}; // "lega|squadra" -> [date ordinate]
for (const lega of LEGHE) {
  const partite = dataset.filter(r => r.league === lega.nome).sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const p of partite) {
    for (const sq of [p.home_team, p.away_team]) {
      const k = `${lega.nome}|${sq}`;
      (calendarioSquadra[k] ||= []).push(new Date(p.date));
    }
  }
}

function restFeatures(lega, squadra, dataPartita) {
  const cal = (calendarioSquadra[`${lega}|${squadra}`] || []).filter(d => d < dataPartita);
  if (!cal.length) return { daysSince: null, last7: 0, last14: 0, last21: 0 };
  const ultima = cal[cal.length - 1];
  const daysSince = Math.round((dataPartita - ultima) / 864e5);
  const conta = (giorni) => cal.filter(d => (dataPartita - d) / 864e5 <= giorni).length;
  return { daysSince, last7: conta(7), last14: conta(14), last21: conta(21) };
}

// ---------------------------------------------------------------- costruisce il dataset di previsioni + feature rest, per ogni riga gia' presente nel walk-forward v1
const righeConRest = [];
for (const p of wf.previsioni) {
  const dataPartita = new Date(p.date);
  const rCasa = restFeatures(p.league, p.home_team, dataPartita);
  const rOspite = restFeatures(p.league, p.away_team, dataPartita);
  if (rCasa.daysSince === null || rOspite.daysSince === null) continue; // prima partita della squadra nel dataset, nessun rest calcolabile
  righeConRest.push({
    ...p,
    restDiff: rCasa.daysSince - rOspite.daysSince,
    last7Diff: rCasa.last7 - rOspite.last7, last14Diff: rCasa.last14 - rOspite.last14, last21Diff: rCasa.last21 - rOspite.last21,
    daysSinceHome: rCasa.daysSince, daysSinceAway: rOspite.daysSince
  });
}

function oneHot(e) { return e === 'H' ? [1, 0, 0] : e === 'D' ? [0, 1, 0] : [0, 0, 1]; }
function brier(rows, f) { let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const [oh, od, oa] = oneHot(r.esito); s += (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2; } return rows.length ? s / rows.length : null; }
function logLoss(rows, f) { const eps = 1e-10; let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const p = r.esito === 'H' ? ph : r.esito === 'D' ? pd : pa; s += -Math.log(Math.max(p, eps)); } return rows.length ? s / rows.length : null; }
function rps(rows, f) { let s = 0; for (const r of rows) { const [ph, pd, pa] = f(r); const [oh, od, oa] = oneHot(r.esito); s += 0.5 * ((ph - oh) ** 2 + (ph + pd - oh - od) ** 2); } return rows.length ? s / rows.length : null; }

const probA = r => [r.modelA.P1, r.modelA.PX, r.modelA.P2];
// correzione: stesso schema esponenziale gia' validato per Elo (correggiConElo),
// qui sulla differenza di riposo (giorni) e sulla differenza di partite recenti
function probConCorrezione(r, beta, variabile) {
  if (beta === 0) return probA(r);
  const x = r[variabile];
  if (!Number.isFinite(x)) return probA(r);
  const fattore = Math.exp(beta * x / 10); // scala: 10 giorni di differenza come unita' di riferimento
  const lh = r.modelA.lambda_home * fattore, la = r.modelA.lambda_away / fattore;
  const mk = mercati(lh, la, r.modelA.rho);
  return [mk['1'], mk['X'], mk['2']];
}

const valRows = righeConRest.filter(r => r.split === 'VALIDATION');
const testRows = righeConRest.filter(r => r.split === 'TEST');

// R0: baseline
const brierR0 = brier(valRows, probA);

// R1: RestDiff (giorni di riposo in piu' per la squadra di casa)
const GRIGLIA_BETA = [0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.08];
function migliorBeta(variabile) {
  let best = { beta: 0, brier: brierR0 };
  for (const beta of GRIGLIA_BETA) {
    const b = brier(valRows, r => probConCorrezione(r, beta, variabile));
    if (b < best.brier) best = { beta, brier: b };
  }
  return best;
}
const r1 = migliorBeta('restDiff');
const r2a = migliorBeta('last7Diff'), r2b = migliorBeta('last14Diff'), r2c = migliorBeta('last21Diff');

console.log(`R0 baseline: Brier VALIDATION = ${brierR0.toFixed(4)}`);
console.log(`R1 RestDiff (giorni): beta=${r1.beta}, Brier VALIDATION = ${r1.brier.toFixed(4)}`);
console.log(`R2a matches_last7Diff: beta=${r2a.beta}, Brier VALIDATION = ${r2a.brier.toFixed(4)}`);
console.log(`R2b matches_last14Diff: beta=${r2b.beta}, Brier VALIDATION = ${r2b.brier.toFixed(4)}`);
console.log(`R2c matches_last21Diff: beta=${r2c.beta}, Brier VALIDATION = ${r2c.brier.toFixed(4)}`);

const candidatiR3 = [
  { nome: 'R1 RestDiff', ...r1, variabile: 'restDiff' },
  { nome: 'R2a last7Diff', ...r2a, variabile: 'last7Diff' },
  { nome: 'R2b last14Diff', ...r2b, variabile: 'last14Diff' },
  { nome: 'R2c last21Diff', ...r2c, variabile: 'last21Diff' }
];
const r3 = candidatiR3.reduce((m, c) => c.brier < m.brier ? c : m, { nome: 'R0 baseline (nessuno migliora)', brier: brierR0, beta: 0, variabile: null });
console.log(`\nR3 (migliore su VALIDATION): ${r3.nome}, Brier = ${r3.brier.toFixed(4)} (baseline ${brierR0.toFixed(4)})`);

// verifica UNA VOLTA su TEST, solo se R3 batte davvero R0 su VALIDATION
let esitoTest = null;
if (r3.variabile) {
  const brierTestR0 = brier(testRows, probA);
  const brierTestR3 = brier(testRows, r => probConCorrezione(r, r3.beta, r3.variabile));
  esitoTest = { brierTestR0: +brierTestR0.toFixed(4), brierTestR3: +brierTestR3.toFixed(4), migliora: brierTestR3 < brierTestR0 };
  console.log(`TEST: R0=${brierTestR0.toFixed(4)} vs R3=${brierTestR3.toFixed(4)} (migliora: ${esitoTest.migliora})`);
} else {
  console.log('Nessuna variante di rest/fatigue batte la baseline su VALIDATION: R3 non testato su TEST (nessun motivo per farlo).');
}

writeFileSync('data/backtests/rest-fatigue-ablation.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Correzione moltiplicativa ai lambda gia stimati da Dixon-Coles (stesso schema di correggiConElo), '
    + 'beta scelto su VALIDATION. R3 valutato su TEST solo se ha davvero battuto R0 su VALIDATION.',
  n_righe_con_rest_disponibile: righeConRest.length,
  R0_baseline_brier_validation: +brierR0.toFixed(4),
  R1_RestDiff: { beta: r1.beta, brier_validation: +r1.brier.toFixed(4) },
  R2a_matches_last7: { beta: r2a.beta, brier_validation: +r2a.brier.toFixed(4) },
  R2b_matches_last14: { beta: r2b.beta, brier_validation: +r2b.brier.toFixed(4) },
  R2c_matches_last21: { beta: r2c.beta, brier_validation: +r2c.brier.toFixed(4) },
  R3_migliore: { nome: r3.nome, beta: r3.beta, brier_validation: +r3.brier.toFixed(4) },
  R3_su_TEST: esitoTest,
  conclusione: r3.variabile ? 'una variante batte la baseline su VALIDATION, verificata su TEST'
    : 'NESSUNA variante di rest/fatigue migliora VALIDATION: rest/fatigue non aggiunge segnale con questi dati, non utilizzata'
}, null, 1));
