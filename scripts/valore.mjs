// scripts/valore.mjs
// Livello "market" e livello "value/confidence", separati dal Pure Model.
// Funzioni pure, senza I/O: prendono solo numeri e restituiscono numeri o
// etichette. Nessuna di queste tocca lambda/rho/mercati() di model.mjs.
//
// Convenzioni: tutte le probabilita' sono frazioni 0-1, non percentuali.

import { AGREEMENT, CONFIDENCE, VALORE } from './config.mjs';

export function fairOdds(pModel) {
  return pModel > 0 ? 1 / pModel : null;
}

// EV = P_model * quota_bookmaker - 1
export function ev(pModel, quotaBookmaker) {
  if (!(quotaBookmaker > 0)) return null;
  return pModel * quotaBookmaker - 1;
}

// Edge = P_model - P_mercato(no-vig)
export function edge(pModel, pMercato) {
  if (!(pMercato >= 0)) return null;
  return pModel - pMercato;
}

// --- MODEL AGREEMENT --------------------------------------------------------
// Confronta fino a 3 stime della stessa probabilita' (baseline, draw-cal,
// mercato no-vig) e classifica quanto si scostano fra loro. Soglie in
// config.mjs, non qui: sono un parametro del prodotto, non della matematica.
export function agreement(valori) {
  const v = valori.filter(x => typeof x === 'number' && Number.isFinite(x));
  if (v.length < 2) return { livello: 'N/D', scartoMassimo: null };
  const scartoMassimo = Math.max(...v) - Math.min(...v);
  const livello = scartoMassimo <= AGREEMENT.sogliaAlta ? 'HIGH'
    : scartoMassimo <= AGREEMENT.sogliaMedia ? 'MEDIUM' : 'LOW';
  return { livello, scartoMassimo: +scartoMassimo.toFixed(4) };
}

// --- DATA QUALITY ------------------------------------------------------------
// 0-100. Riflette QUANTI dati reali sostengono la stima, non quanto e'
// probabile l'esito. contestoDisponibile riflette la Fase 10 (API-Football):
// oggi vale sempre false in produzione, perche' il peso predittivo del
// contesto (lineup/injury) e' 0 per esplicita decisione — mostrato solo come
// informazione, mai usato per aggiustare le probabilita'.
export function dataQuality({ nStorico, currentSeasonMatches, contestoDisponibile = false }) {
  let q = 0;
  q += Math.min(1, nStorico / CONFIDENCE.storicoDiRiferimento) * CONFIDENCE.pesoStorico;
  q += Math.min(1, currentSeasonMatches / CONFIDENCE.partiteStagioneDiRiferimento) * CONFIDENCE.pesoStagioneCorrente;
  q += (contestoDisponibile ? 1 : 0) * CONFIDENCE.pesoContesto;
  return Math.round(q * 100);
}

// --- CONFIDENCE (NON e' la probabilita' dell'esito) -------------------------
export function confidence({ agreementLivello, nStorico, currentSeasonMatches, freschezzaOre, contestoDisponibile, scartoDalMercato }) {
  const puntiAgreement = agreementLivello === 'HIGH' ? 1 : agreementLivello === 'MEDIUM' ? 0.55 : agreementLivello === 'LOW' ? 0.2 : 0.4;
  const puntiFreschezza = Math.max(0, 1 - freschezzaOre / CONFIDENCE.freschezzaMassimaOre);
  const puntiDistanzaMercato = Math.max(0, 1 - Math.min(1, scartoDalMercato / CONFIDENCE.scartoMercatoRiferimento));
  const dq = dataQuality({ nStorico, currentSeasonMatches, contestoDisponibile }) / 100;

  const punteggio =
    puntiAgreement * CONFIDENCE.pesiConfidence.agreement +
    dq * CONFIDENCE.pesiConfidence.dataQuality +
    puntiFreschezza * CONFIDENCE.pesiConfidence.freschezza +
    puntiDistanzaMercato * CONFIDENCE.pesiConfidence.distanzaMercato;

  return Math.round(Math.max(0, Math.min(1, punteggio)) * 100);
}

// --- VALUE CLASSIFICATION ----------------------------------------------------
// Mai "sicura/certa/garantita": solo etichette di processo, mai di esito.
export function classificaValore({ evValue, edgeValue, confidenceScore, dataQualityScore, agreementLivello }) {
  if (!(evValue > 0) || !(edgeValue > 0)) return 'NO_BET';
  const qualitaBassa = confidenceScore < VALORE.confidenceMinimaWatch || dataQualityScore < VALORE.dataQualityMinimaWatch;
  if (qualitaBassa) return 'WATCH'; // EV/edge positivi ma sostenuti da poca qualita' -> osservare, non giocare
  if (agreementLivello === 'LOW') return 'WATCH'; // modello e mercato in forte disaccordo: prudenza anche con EV alto

  const forte = evValue >= VALORE.evSogliaForte && edgeValue >= VALORE.edgeSogliaForte
    && confidenceScore >= VALORE.confidenceMinimaForte && dataQualityScore >= VALORE.dataQualityMinimaForte;
  return forte ? 'STRONG_VALUE' : 'VALUE';
}

// --- WHY THIS PICK: template deterministico, solo dati realmente presenti ---
export function spiegaPick({ evento, esitoLabel, pModel, pMercato, quotaBookmaker, agreementLivello }) {
  const fo = fairOdds(pModel);
  let frase = `Il modello assegna a "${esitoLabel}" il ${(pModel * 100).toFixed(1)}%`;
  if (typeof pMercato === 'number') frase += ` contro il ${(pMercato * 100).toFixed(1)}% del mercato`;
  frase += '.';
  if (fo) frase += ` La quota fair e' ${fo.toFixed(2)}`;
  if (typeof quotaBookmaker === 'number') frase += ` contro una quota disponibile di ${quotaBookmaker.toFixed(2)}`;
  frase += '.';
  if (agreementLivello) {
    const desc = agreementLivello === 'HIGH' ? 'un accordo alto' : agreementLivello === 'MEDIUM' ? 'un disaccordo moderato' : agreementLivello === 'LOW' ? 'un forte disaccordo' : 'un confronto non disponibile';
    frase += ` Il modello e il mercato mostrano ${desc}.`;
  }
  return frase;
}
