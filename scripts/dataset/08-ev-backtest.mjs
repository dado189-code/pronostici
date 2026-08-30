// scripts/dataset/08-ev-backtest.mjs
// STEP 16-19: mercato come benchmark separato (mai nel Pure Model), fair
// odds, edge, EV, soglie testate SENZA sceglierle sul TEST, performance di
// scommessa per bucket, CLV dove le quote di apertura sono disponibili.
//
// Regola rispettata: le soglie EV si SCELGONO guardando solo VALIDATION.
// Il TEST si limita a riportare come si comporta la soglia gia' scelta,
// non a cercarne una migliore.

import { readFileSync, writeFileSync } from 'node:fs';
import { SPLIT } from './00-config.mjs';

const dati = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';

const SOGLIE = [0, 0.02, 0.05, 0.075, 0.10];

// Per ogni partita con mercato disponibile, si gioca il segno (1/X/2) su cui
// il MODELLO A (baseline, e' quello in produzione) ha l'EV piu alto rispetto
// alla quota di CHIUSURA. Non e' la strategia migliore possibile: e' la piu
// semplice che risponde alla domanda "il modello trova valore vero?".
function selezioni(rows, modelKey) {
  const out = [];
  for (const r of rows) {
    if (!r.market || !r[modelKey]) continue;
    const quote = { H: r.closing_home ?? r.market.closing_home, D: r.closing_draw ?? r.market.closing_draw, A: r.closing_away ?? r.market.closing_away };
    const prob = { H: r[modelKey].P1, D: r[modelKey].PX, A: r[modelKey].P2 };
    let migliore = null;
    for (const esito of ['H', 'D', 'A']) {
      const q = esito === 'H' ? r.market.closing_home : esito === 'D' ? r.market.closing_draw : r.market.closing_away;
      if (!(q > 1)) continue;
      const ev = prob[esito] * q - 1;
      if (!migliore || ev > migliore.ev) migliore = { esito, ev, prob: prob[esito], quota: q };
    }
    if (migliore) out.push({ ...r, selezione: migliore });
  }
  return out;
}

function performance(selezionate, sogliaEV) {
  const giocate = selezionate.filter(s => s.selezione.ev >= sogliaEV);
  if (!giocate.length) return { bets: 0 };
  let vinte = 0, plTotale = 0, quoteSomma = 0, probSomma = 0;
  const pl = [];
  for (const g of giocate) {
    const vince = (g.selezione.esito === 'H' && g.esito === 'H') || (g.selezione.esito === 'D' && g.esito === 'D') || (g.selezione.esito === 'A' && g.esito === 'A');
    const ritorno = vince ? g.selezione.quota - 1 : -1;
    pl.push(ritorno); plTotale += ritorno; quoteSomma += g.selezione.quota; probSomma += g.selezione.prob;
    if (vince) vinte++;
  }
  // max drawdown su stake fisso, nell'ordine cronologico delle giocate
  let picco = 0, cum = 0, maxDD = 0;
  for (const r of pl) { cum += r; picco = Math.max(picco, cum); maxDD = Math.max(maxDD, picco - cum); }
  return {
    bets: giocate.length, win_rate: +(vinte / giocate.length * 100).toFixed(1),
    average_odds: +(quoteSomma / giocate.length).toFixed(2), average_predicted_prob: +(probSomma / giocate.length * 100).toFixed(1),
    profit_loss: +plTotale.toFixed(2), roi_pct: +(plTotale / giocate.length * 100).toFixed(2),
    yield_pct: +(plTotale / giocate.length * 100).toFixed(2), // stake unitario: ROI e yield coincidono qui
    max_drawdown: +maxDD.toFixed(2)
  };
}

// CLV: solo dove opening e closing sono ENTRAMBE disponibili per l'esito scelto
function clv(selezionate) {
  const conApertura = selezionate.filter(s => {
    const ap = s.selezione.esito === 'H' ? s.market.opening_home : s.selezione.esito === 'D' ? s.market.opening_draw : s.market.opening_away;
    return ap > 1;
  });
  if (!conApertura.length) return { disponibile: false, motivo: 'quote di apertura assenti per gli esiti selezionati' };
  let sommaClv = 0, battonoLaChiusura = 0;
  for (const s of conApertura) {
    const ap = s.selezione.esito === 'H' ? s.market.opening_home : s.selezione.esito === 'D' ? s.market.opening_draw : s.market.opening_away;
    const cl = s.selezione.quota;
    const clvSingolo = ap / cl - 1; // positivo = la quota presa (apertura) era migliore della chiusura
    sommaClv += clvSingolo;
    if (ap > cl) battonoLaChiusura++;
  }
  return { disponibile: true, n: conApertura.length,
    clv_medio_pct: +(sommaClv / conApertura.length * 100).toFixed(2),
    pct_selezioni_che_battono_la_chiusura: +(battonoLaChiusura / conApertura.length * 100).toFixed(1) };
}

const risultato = { modelA: {}, modelB: {} };
for (const [nome, chiave] of [['modelA', 'modelA'], ['modelB', 'modelB']]) {
  const selVal = selezioni(dati.previsioni.filter(p => splitDi(p.date) === 'VALIDATION'), chiave);
  const selTest = selezioni(dati.previsioni.filter(p => splitDi(p.date) === 'TEST'), chiave);

  risultato[nome].VALIDATION = {};
  risultato[nome].TEST = {};
  for (const soglia of SOGLIE) {
    risultato[nome].VALIDATION[`EV>=${(soglia * 100).toFixed(1)}%`] = performance(selVal, soglia);
    risultato[nome].TEST[`EV>=${(soglia * 100).toFixed(1)}%`] = performance(selTest, soglia);
  }
  risultato[nome].CLV_VALIDATION = clv(selVal.filter(s => s.selezione.ev >= 0));
  risultato[nome].CLV_TEST = clv(selTest.filter(s => s.selezione.ev >= 0));
}

writeFileSync('data/backtests/ev-performance.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Strategia: si gioca il segno con EV piu alto secondo il modello, quota di CHIUSURA. '
    + 'Le soglie sono testate su VALIDATION e TEST separatamente, MAI scelte guardando il TEST. '
    + 'ROI/yield su stake unitario per giocata.',
  ...risultato
}, null, 1));

console.log('EV backtest, modelA (baseline), VALIDATION:');
console.table(risultato.modelA.VALIDATION);
console.log('EV backtest, modelA (baseline), TEST:');
console.table(risultato.modelA.TEST);
console.log('CLV modelA:', JSON.stringify({ VALIDATION: risultato.modelA.CLV_VALIDATION, TEST: risultato.modelA.CLV_TEST }));
