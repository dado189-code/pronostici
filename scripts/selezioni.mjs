// scripts/selezioni.mjs
// Cassaforte / Quota 2 / Sorpresa, riallineate all'uso reale dichiarato
// dall'utente. Funzioni pure: prendono un pool di candidati gia' calcolato
// da build.mjs (probabilita' del Pure Model, quota fair, e le metriche del
// value engine su quella partita) e restituiscono una selezione o null.
// Nessuna di queste tocca lambda/rho/mercati()/DC-DRAW-CAL.

import { SELEZIONE } from './config.mjs';

const ORDINE_GAP = ['NONE', 'LIEVE', 'SIGNIFICATIVA', 'ESTREMA'];

// Mercati meno volatili prima: usato solo come spareggio quando piu'
// candidati hanno probabilita'/qualita' equivalenti (punto "preferire mercati
// meno volatili quando statisticamente giustificato" — mai come criterio primario).
const ORDINE_VOLATILITA = [
  '1X', 'X2', '12', 'Under 4.5', 'Under 3.5', 'Under 2.5', 'Over 1.5', 'Over 2.5',
  'Multigol 1-5', 'Multigol 1-4', 'Multigol 2-5', 'Multigol 1-3', 'Multigol 2-4',
  'Casa segna', 'Trasferta segna', '1', '2', 'X',
  'Multigol casa 1-3', 'Multigol trasferta 1-3', 'Multigol casa 1-2', 'Multigol trasferta 1-2',
  'Multigol 3-5', 'Gol', 'NoGol'
];
function rangoVolatilita(mercato) {
  const i = ORDINE_VOLATILITA.indexOf(mercato);
  return i === -1 ? ORDINE_VOLATILITA.length : i;
}

// Un candidato passa i filtri di qualita' comuni a Cassaforte/Quota2: NESSUNA
// selezione High Risk (rischio_quota ESCLUSA/HIGH_VARIANCE mai ammesso), gap
// non oltre la soglia data, agreement solo fra quelli accettati, confidence e
// dataQuality sopra soglia.
function passaFiltriQualita(analisi, soglie) {
  if (!analisi) return false;
  if (analisi.rischio_quota === 'ESCLUSA' || analisi.rischio_quota === 'HIGH_VARIANCE') return false;
  if (analisi.quality.confidence < soglie.confidenceMinima) return false;
  if (analisi.quality.data_quality < soglie.dataQualityMinima) return false;
  if (!soglie.agreementAccettati.includes(analisi.quality.agreement)) return false;
  const gapIdx = ORDINE_GAP.indexOf(analisi.market_gap.livello);
  const maxIdx = ORDINE_GAP.indexOf(soglie.marketGapLivelloMassimo);
  if (gapIdx === -1 || gapIdx > maxIdx) return false;
  return true;
}

// --- CASSAFORTE --------------------------------------------------------------
// pool: array di { match, evento, comp, quando, inizio, mercato, prob,
// quota_fair, analisi }. Sceglie la singola con miglior rapporto
// probabilita'/quota DENTRO la banda richiesta, non necessariamente 1X2.
export function costruisciCassaforte(pool) {
  const cfg = SELEZIONE.cassaforte;
  const candidati = pool.filter(c => c.quota_fair >= cfg.quotaMin && c.quota_fair <= cfg.quotaMax
    && passaFiltriQualita(c.analisi, cfg));
  if (!candidati.length) return { selezione: null, motivo: `Nessun candidato in banda ${cfg.quotaMin}-${cfg.quotaMax} con qualita sufficiente e nessun rischio elevato.` };

  const preferiti = candidati.filter(c => c.quota_fair >= cfg.quotaPreferitaMin && c.quota_fair <= cfg.quotaPreferitaMax);
  const bacino = preferiti.length ? preferiti : candidati;

  // punteggio: probabilita' (il criterio principale, "probabilita' elevata"),
  // poi qualita', poi il meno volatile a parita' di tutto il resto
  const punteggio = (c) => c.prob * 0.55 + (c.analisi.quality.confidence / 100) * 0.25 + (c.analisi.quality.data_quality / 100) * 0.20;
  bacino.sort((a, b) => punteggio(b) - punteggio(a) || rangoVolatilita(a.mercato) - rangoVolatilita(b.mercato));
  return { selezione: bacino[0], banda_preferita_usata: preferiti.length > 0, motivo: null };
}

// --- QUOTA 2 -------------------------------------------------------------
// Cerca la combinazione (2, o 3 solo se necessario) di eventi DIVERSI la cui
// quota fair combinata cade in [quotaTotaleMin, quotaTotaleMax], ottimizzando
// probabilita' congiunta e qualita' media — non le due quote piu' basse.
function punteggioAgreement(livello) {
  return livello === 'HIGH' ? 1 : livello === 'MEDIUM' ? 0.6 : livello === 'LOW' ? 0.15 : 0.4;
}
function punteggioCombo(selezioni, probCongiunta, pesi) {
  const confMedia = selezioni.reduce((s, c) => s + c.analisi.quality.confidence, 0) / selezioni.length / 100;
  const dqMedia = selezioni.reduce((s, c) => s + c.analisi.quality.data_quality, 0) / selezioni.length / 100;
  const agrMedio = selezioni.reduce((s, c) => s + punteggioAgreement(c.analisi.quality.agreement), 0) / selezioni.length;
  return probCongiunta * pesi.probabilitaCongiunta + confMedia * pesi.confidenceMedia
    + dqMedia * pesi.dataQualityMedia + agrMedio * pesi.agreementMedio;
}

export function costruisciQuota2(pool) {
  const cfg = SELEZIONE.quota2;
  const candidatiGrezzi = pool.filter(c => passaFiltriQualita(c.analisi, cfg));
  if (!candidatiGrezzi.length) return { selezioni: null, motivo: 'Nessun candidato con qualita sufficiente oggi.' };

  // un solo candidato per partita (il migliore), per evitare eventi
  // correlati sulla stessa partita e contenere lo spazio di ricerca
  const perPartita = new Map();
  for (const c of candidatiGrezzi) {
    const cur = perPartita.get(c.match);
    if (!cur || c.prob > cur.prob) perPartita.set(c.match, c);
  }
  const lista = [...perPartita.values()].sort((a, b) => b.prob - a.prob).slice(0, cfg.maxCandidatiPerRicerca);
  if (lista.length < 2) return { selezioni: null, motivo: 'Meno di due partite diverse hanno un candidato idoneo oggi.' };

  let migliore = null;
  const valuta = (combo) => {
    const quotaTotale = combo.reduce((p, c) => p * c.quota_fair, 1);
    if (quotaTotale < cfg.quotaTotaleMin || quotaTotale > cfg.quotaTotaleMax) return;
    const probCongiunta = combo.reduce((p, c) => p * c.prob, 1);
    const score = punteggioCombo(combo, probCongiunta, cfg.pesi);
    if (!migliore || score > migliore.score) migliore = { selezioni: combo, quotaTotale, probCongiunta, score };
  };

  // preferenza dichiarata: 2 selezioni. Si cercano prima le coppie;
  // le terzine si provano SOLO se nessuna coppia soddisfa la banda di quota.
  for (let i = 0; i < lista.length; i++)
    for (let j = i + 1; j < lista.length; j++)
      valuta([lista[i], lista[j]]);

  if (!migliore && cfg.massimeSelezioni >= 3) {
    for (let i = 0; i < lista.length; i++)
      for (let j = i + 1; j < lista.length; j++)
        for (let k = j + 1; k < lista.length; k++)
          valuta([lista[i], lista[j], lista[k]]);
  }

  if (!migliore) return { selezioni: null, motivo: `Nessuna combinazione di eventi diversi raggiunge quota ${cfg.quotaTotaleMin}-${cfg.quotaTotaleMax} con la qualita richiesta.` };
  return { ...migliore, motivo: null };
}

// --- SORPRESA ------------------------------------------------------------
// Usa il Value Engine vero (serve una quota bookmaker reale, quindi solo
// segni 1X2 con consenso di mercato disponibile). Quote sopra la soglia
// restano SOLO in High Risk, mai proposte come Sorpresa principale.
export function costruisciSorpresa(partiteConAnalisi) {
  const cfg = SELEZIONE.sorpresa;
  const candidati = partiteConAnalisi.filter(m => {
    const a = m.analisi;
    return a.market.bookmaker_odds >= cfg.quotaMin && a.market.bookmaker_odds <= cfg.quotaMax
      && a.value.ev > 0
      && a.quality.confidence >= cfg.confidenceMinimaAccettabile
      && a.market_gap.livello !== 'ESTREMA';
  });
  if (!candidati.length) return { selezione: null, motivo: `Nessun evento in banda quota ${cfg.quotaMin}-${cfg.quotaMax} con EV positivo e disaccordo non estremo.` };

  candidati.sort((x, y) => {
    const px = cfg.agreementPreferiti.includes(x.analisi.quality.agreement) ? 1 : 0;
    const py = cfg.agreementPreferiti.includes(y.analisi.quality.agreement) ? 1 : 0;
    if (py !== px) return py - px;
    return y.analisi.value.ev - x.analisi.value.ev;
  });
  return { selezione: candidati[0], motivo: null };
}
