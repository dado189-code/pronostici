// scripts/dataset/06-decay-rho.mjs (v2)
// STEP 11-12: griglia di decay (half-life) e griglia ampia di rho, entrambe
// stimate SOLO su TRAIN+VALIDATION (mai TEST 2025/26). Per ogni combinazione
// si stima Dixon-Coles fino a fine VALIDATION e si misura la log-likelihood
// out-of-sample sulle partite di VALIDATION stessa (walk-forward semplificato:
// le forze si stimano su TRAIN, si valutano su VALIDATION, che e' la
// definizione corretta di "scegliere iperparametri su train+validation senza
// toccare il test").

import { readFileSync, writeFileSync } from 'node:fs';
import { stimaForze, lambde, poisson, tau } from '../model.mjs';
import { LEGHE, SPLIT } from './00-config.mjs';

const dataset = JSON.parse(readFileSync('data/normalized/dataset-matched.json', 'utf8')).partite;
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';

const GRIGLIA_DECAY = [60, 90, 120, 150, 180, 240, 365];
const RHO_MIN = -0.4, RHO_MAX = 0.4, RHO_PASSO = 0.0025;

function logLikelihoodOOS(train, validation, forze, rho) {
  let ll = 0;
  for (const p of validation) {
    const { lh, la } = lambde(forze, p.casa, p.ospite);
    if (!lh || !la) continue;
    const t = tau(p.golCasa, p.golOspite, lh, la, rho);
    if (t <= 0) return -Infinity;
    ll += Math.log(t) + Math.log(poisson(p.golCasa, lh)) + Math.log(poisson(p.golOspite, la));
  }
  return ll;
}

const risultatoDecay = {};
const risultatoRho = {};

for (const lega of LEGHE) {
  const tutte = dataset.filter(r => r.league === lega.nome)
    .map(r => ({ data: new Date(r.date), casa: r.home_team, ospite: r.away_team,
      xgCasa: r.xG_home, xgOspite: r.xG_away, golCasa: r.goals_home, golOspite: r.goals_away, split: splitDi(r.date) }))
    .sort((a, b) => a.data - b.data);

  const train = tutte.filter(r => r.split === 'TRAIN');
  const validation = tutte.filter(r => r.split === 'VALIDATION');
  const trainPiuValidation = tutte.filter(r => r.split !== 'TEST');

  // --- decay: stima su TRAIN, valuta out-of-sample su VALIDATION (rho fisso
  // a un valore neutro qui, per isolare l'effetto del solo decay)
  let bestDecay = null;
  const curvaDecay = [];
  for (const emivita of GRIGLIA_DECAY) {
    const forze = stimaForze(train, { emivita, oggi: validation[0]?.data ?? new Date() });
    const ll = logLikelihoodOOS(train, validation, forze, -0.05);
    curvaDecay.push({ emivita, logLikelihoodOOS: Number.isFinite(ll) ? +ll.toFixed(2) : null });
    if (Number.isFinite(ll) && (!bestDecay || ll > bestDecay.logLikelihoodOOS)) bestDecay = { emivita, logLikelihoodOOS: +ll.toFixed(2) };
  }
  risultatoDecay[lega.nome] = { curva: curvaDecay, migliore: bestDecay };

  // --- rho: stima le forze su TRAIN+VALIDATION con l'emivita di produzione
  // (180gg, coerente con come rho viene davvero usato), scansiona una griglia ampia
  const forzeTV = stimaForze(trainPiuValidation, { emivita: 180 });
  let bestRho = null;
  const dominioValido = [];
  for (let rho = RHO_MIN; rho <= RHO_MAX + 1e-9; rho += RHO_PASSO) {
    const r = +rho.toFixed(4);
    const ll = logLikelihoodOOS(null, trainPiuValidation, forzeTV, r);
    if (Number.isFinite(ll)) { dominioValido.push(r); if (!bestRho || ll > bestRho.ll) bestRho = { rho: r, ll: +ll.toFixed(2) }; }
  }
  const sulBordo = bestRho.rho === dominioValido[0] || bestRho.rho === dominioValido.at(-1);
  risultatoRho[lega.nome] = { rho_ottimo: bestRho.rho, log_likelihood: bestRho.ll, sul_bordo_griglia_ampia: sulBordo };

  console.log(`${lega.nome}: decay migliore = ${bestDecay.emivita}gg | rho migliore (TRAIN+VALIDATION, griglia ampia) = ${bestRho.rho}`);
}

writeFileSync('data/backtests/decay-rho.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Decay: stimato su TRAIN, valutato out-of-sample su VALIDATION (log-likelihood, rho fisso a -0.05 '
    + 'per isolare l effetto del decay). Rho: stimato su TRAIN+VALIDATION con emivita di produzione (180gg), '
    + 'griglia ampia [-0.4,0.4]. Il TEST 2025/26 non e mai stato usato in questo script.',
  decayPerLega: risultatoDecay, rhoPerLega: risultatoRho
}, null, 1));
