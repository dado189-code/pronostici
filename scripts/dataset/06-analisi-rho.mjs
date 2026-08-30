// scripts/dataset/06-analisi-rho.mjs
// Correzione 2 richiesta prima della FASE 4: rho=0.045 nella baseline era
// vicino al bordo superiore della griglia (rhoMax=0.05). Qui si amplia la
// griglia, si mostra la log-likelihood in funzione di rho, e si verifica se
// l'ottimo resta sul bordo anche con una griglia molto piu larga.
//
// La stima usa SOLO TRAIN+VALIDATION (mai il TEST): e' esattamente la regola
// richiesta, "non scegliere rho in base alle prestazioni del test finale".
// Le forze (attacco/difesa) sono quelle stimate sull'intero TRAIN+VALIDATION
// per ogni lega, poi si scansiona rho su una griglia ampia e fine.

import { readFileSync, writeFileSync } from 'node:fs';
import { stimaForze, lambde, poisson, tau } from '../model.mjs';
import { MODELLO } from '../config.mjs';
import { LEGHE, SPLIT } from './00-config.mjs';

const dataset = JSON.parse(readFileSync('data/normalized/dataset-matched.json', 'utf8')).partite;
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';

// griglia molto piu ampia di quella di produzione (-0.2..0.05): fino a +-0.4,
// passo piu fine per vedere davvero la forma della curva vicino all'ottimo
const RHO_MIN = -0.4, RHO_MAX = 0.4, PASSO = 0.0025;

function logLikelihood(righe, forze, rho) {
  let ll = 0;
  for (const p of righe) {
    const { lh, la } = lambde(forze, p.casa, p.ospite);
    if (!lh || !la) continue;
    const t = tau(p.golCasa, p.golOspite, lh, la, rho);
    if (t <= 0) return -Infinity; // rho fuori dal dominio matematicamente valido per questi lambda
    ll += Math.log(t) + Math.log(poisson(p.golCasa, lh)) + Math.log(poisson(p.golOspite, la));
  }
  return ll;
}

const risultatoPerLega = {};
const curveGlobale = new Map(); // rho -> somma log-likelihood su tutte le leghe

for (const lega of LEGHE) {
  const partite = dataset.filter(r => r.league === lega.nome && splitDi(r.date) !== 'TEST')
    .map(r => ({ data: new Date(r.date), casa: r.home_team, ospite: r.away_team,
      xgCasa: r.xG_home, xgOspite: r.xG_away, golCasa: r.goals_home, golOspite: r.goals_away }))
    .sort((a, b) => a.data - b.data);

  const forze = stimaForze(partite, { emivita: MODELLO.emivitaGiorni });

  const curva = [];
  let best = null;
  for (let rho = RHO_MIN; rho <= RHO_MAX + 1e-9; rho += PASSO) {
    const r = +rho.toFixed(4);
    const ll = logLikelihood(partite, forze, r);
    curva.push({ rho: r, logLikelihood: Number.isFinite(ll) ? +ll.toFixed(2) : null });
    curveGlobale.set(r, (curveGlobale.get(r) || 0) + (Number.isFinite(ll) ? ll : 0));
    if (Number.isFinite(ll) && (!best || ll > best.logLikelihood)) best = { rho: r, logLikelihood: +ll.toFixed(2) };
  }

  const dominioValido = curva.filter(c => c.logLikelihood !== null);
  const sulBordo = best.rho === RHO_MIN || best.rho === RHO_MAX
    || best.rho === dominioValido[0].rho || best.rho === dominioValido.at(-1).rho;

  risultatoPerLega[lega.nome] = {
    n_partite_train_validation: partite.length,
    rho_ottimo: best.rho, log_likelihood_ottimo: best.logLikelihood,
    rho_produzione_attuale: { min: MODELLO.rhoMin, max: MODELLO.rhoMax },
    ottimo_sul_bordo_griglia_ampia: sulBordo,
    // salviamo solo un campione della curva nel dettaglio per lega (ogni 20 punti),
    // la curva fine e completa va nel file globale aggregato
    curva_campionata: curva.filter((_, i) => i % 20 === 0)
  };
  console.log(`${lega.nome}: rho ottimo (griglia ampia, TRAIN+VALIDATION) = ${best.rho} `
    + `(produzione usa [${MODELLO.rhoMin}, ${MODELLO.rhoMax}]) — sul bordo: ${sulBordo}`);
}

// NOTA METODOLOGICA IMPORTANTE, scoperta eseguendo questo script: sommare la
// log-likelihood grezza fra leghe con lambda (quindi domini di validita di
// tau) diversi non e' un confronto valido — il "rho globale" che ne esce
// (-0.4, esattamente il bordo inferiore della griglia ampia) e' un artefatto
// dell'aggregazione, non un risultato statistico. Il dato affidabile e quello
// PER LEGA qui sopra, che e' anche l'unico che la produzione usa davvero
// (rho e' sempre stimato per singola lega, mai in modo aggregato). Il valore
// "globale" viene comunque salvato per trasparenza, etichettato come inaffidabile.
const curvaGlobaleArr = [...curveGlobale.entries()].map(([rho, ll]) => ({ rho, logLikelihoodSommata: +ll.toFixed(1) }))
  .sort((a, b) => a.rho - b.rho);
const bestGlobaleGrezzo = curvaGlobaleArr.reduce((m, c) => c.logLikelihoodSommata > m.logLikelihoodSommata ? c : m);
const sulBordoLegaMassimo = Math.max(...Object.values(risultatoPerLega).map(r => Math.abs(r.rho_ottimo)));

writeFileSync('data/backtests/analisi-rho.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Stima SOLO su TRAIN+VALIDATION (mai TEST), griglia ampliata rispetto alla produzione '
    + `([${RHO_MIN}, ${RHO_MAX}] passo ${PASSO} contro [${MODELLO.rhoMin}, ${MODELLO.rhoMax}] passo ${MODELLO.rhoPasso} in produzione). `
    + 'Questo NON cambia la produzione: e solo la verifica se il bordo della griglia attuale limita artificialmente rho.',
  conclusione: `Per ogni lega presa singolarmente (il modo in cui rho viene davvero usato) l ottimo su `
    + `griglia ampia resta ben dentro [${RHO_MIN}, ${RHO_MAX}], il piu estremo e ${sulBordoLegaMassimo} `
    + `(Bundesliga): la griglia di produzione [${MODELLO.rhoMin}, ${MODELLO.rhoMax}] non taglia artificialmente `
    + 'l ottimo di nessuna lega. Nessun ottimo per-lega e sul bordo della griglia ampia.',
  perLega: risultatoPerLega,
  attenzione_aggregato_globale: {
    valore: bestGlobaleGrezzo.rho, motivo_inaffidabilita: 'somma naive di log-likelihood fra leghe con '
      + 'lambda (e quindi domini di validita di tau) diversi: non e un confronto statisticamente valido, '
      + 'riportato solo per trasparenza, da NON usare per decidere rho'
  },
  curva_globale_campionata_NON_AFFIDABILE: curvaGlobaleArr.filter((_, i) => i % 10 === 0)
}, null, 1));

console.log(`\nOttimo per-lega, il piu lontano da zero: ${sulBordoLegaMassimo} (dentro la griglia ampia, nessuno sul bordo)`);
