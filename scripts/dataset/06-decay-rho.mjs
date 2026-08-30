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

// esteso dopo la prima estensione: 365gg era il bordo superiore e vinceva in
// 4 leghe su 5, segno che l'ottimo poteva stare oltre. 100000gg equivale a
// peso quasi uniforme (nessun decadimento apprezzabile su un dataset di 4
// stagioni: 0.5^(1460/100000) = 0.99, praticamente 1 per ogni partita).
const GRIGLIA_DECAY = [60, 90, 120, 150, 180, 240, 365, 540, 730, 1000, 100000];
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
  // a un valore neutro qui, per isolare l'effetto del solo decay). La
  // log-likelihood e' anche normalizzata per partita (OOS/n) per poter
  // confrontare fra leghe con VALIDATION di dimensione diversa senza
  // ripetere l'errore di aggregazione gia' scoperto nell'analisi rho.
  let bestDecay = null;
  const curvaDecay = [];
  for (const emivita of GRIGLIA_DECAY) {
    const forze = stimaForze(train, { emivita, oggi: validation[0]?.data ?? new Date() });
    const ll = logLikelihoodOOS(train, validation, forze, -0.05);
    const llPerPartita = Number.isFinite(ll) ? ll / validation.length : null;
    curvaDecay.push({ emivita, logLikelihoodOOS: Number.isFinite(ll) ? +ll.toFixed(2) : null, perPartita: llPerPartita !== null ? +llPerPartita.toFixed(4) : null });
    if (Number.isFinite(ll) && (!bestDecay || ll > bestDecay.logLikelihoodOOS)) bestDecay = { emivita, logLikelihoodOOS: +ll.toFixed(2), perPartita: +llPerPartita.toFixed(4) };
  }
  risultatoDecay[lega.nome] = { curva: curvaDecay, migliore: bestDecay, n_validation: validation.length };

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

// --- decay globale vs per-lega: per ogni candidato di decay "globale" (ogni
// valore della griglia), somma la log-likelihood NORMALIZZATA per partita
// attraverso le 5 leghe. Il migliore "globale" e' quello con la somma piu
// alta. Si confronta poi con la somma ottenuta usando il decay ottimo
// specifico di ciascuna lega: se il guadagno e' piccolo, un parametro solo
// (piu semplice, meno rischio di overfitting per lega) e' preferibile.
const sommaPerCandidatoGlobale = {};
for (const emivita of GRIGLIA_DECAY) {
  let somma = 0, nLeghe = 0;
  for (const lega of LEGHE) {
    const punto = risultatoDecay[lega.nome].curva.find(c => c.emivita === emivita);
    if (punto && punto.perPartita !== null) { somma += punto.perPartita; nLeghe++; }
  }
  sommaPerCandidatoGlobale[emivita] = nLeghe === LEGHE.length ? +somma.toFixed(4) : null;
}
const decayGlobaleOttimo = Object.entries(sommaPerCandidatoGlobale).filter(([, v]) => v !== null)
  .reduce((m, [k, v]) => (m === null || v > m.v) ? { emivita: +k, v } : m, null);
const sommaConDecayPerLega = LEGHE.reduce((a, l) => a + risultatoDecay[l.nome].migliore.perPartita, 0);
const confrontoGlobaleVsPerLega = {
  decay_globale_ottimo: decayGlobaleOttimo.emivita,
  log_likelihood_per_partita_globale_sommata: +decayGlobaleOttimo.v.toFixed(4),
  log_likelihood_per_partita_per_lega_sommata: +sommaConDecayPerLega.toFixed(4),
  guadagno_per_lega_vs_globale: +(sommaConDecayPerLega - decayGlobaleOttimo.v).toFixed(4),
  raccomandazione: (sommaConDecayPerLega - decayGlobaleOttimo.v) < 0.01
    ? 'guadagno trascurabile: preferire un decay GLOBALE unico, piu semplice e meno rischio di overfitting per lega'
    : 'il guadagno per-lega e apprezzabile: valutare un parametro per lega'
};
console.log(`\nDecay globale ottimo (somma log-likelihood/partita su 5 leghe): ${decayGlobaleOttimo.emivita}gg`);
console.log(confrontoGlobaleVsPerLega.raccomandazione);

writeFileSync('data/backtests/decay-rho.json', JSON.stringify({
  confronto_globale_vs_per_lega: confrontoGlobaleVsPerLega,
  generato_il: new Date().toISOString(),
  nota: 'Decay: stimato su TRAIN, valutato out-of-sample su VALIDATION (log-likelihood, rho fisso a -0.05 '
    + 'per isolare l effetto del decay). Rho: stimato su TRAIN+VALIDATION con emivita di produzione (180gg), '
    + 'griglia ampia [-0.4,0.4]. Il TEST 2025/26 non e mai stato usato in questo script.',
  decayPerLega: risultatoDecay, rhoPerLega: risultatoRho
}, null, 1));
