// scripts/selezioni.mjs
// Cassaforte / Quota 2 / Sorpresa, riallineate all'uso reale dichiarato
// dall'utente. Funzioni pure: prendono un pool di candidati gia' calcolato
// da build.mjs e restituiscono una selezione o null. Nessuna di queste tocca
// lambda/rho/mercati()/DC-DRAW-CAL.
//
// Due tipi di candidato nel pool, sempre distinti da c.tipo:
//  - 'modello': le 5 leghe nazionali, Pure Model + value engine (c.analisi
//    con confidence/dataQuality/agreement/market gap).
//  - 'consenso': competizioni senza modello indipendente (es. Champions
//    League, su richiesta esplicita dell'utente il 10/09/2026). Niente
//    analisi: l'unica garanzia di qualita' e' il numero di bookmaker
//    d'accordo sul prezzo (c.nBook, soglia in CONSENSO.nBookMinimo).

import { SELEZIONE, CONSENSO } from './config.mjs';

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

// Un candidato passa i filtri di qualita' comuni a Cassaforte/Quota2. Per
// 'modello': NESSUNA selezione High Risk (rischio_quota ESCLUSA/HIGH_VARIANCE
// mai ammesso), gap non oltre la soglia, agreement fra quelli accettati,
// confidence/dataQuality sopra soglia. Per 'consenso': solo il numero minimo
// di bookmaker, non esistendo nessuno degli altri controlli senza un modello.
function passaFiltriQualita(c, soglie) {
  if (c.tipo === 'consenso') return c.nBook >= CONSENSO.nBookMinimo;
  const analisi = c.analisi;
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

// Punteggio di qualita' 0-1 comparabile fra i due tipi, usato SOLO per
// ordinare fra candidati gia' passati da passaFiltriQualita (mai per
// deciderne l'ammissibilita', quella resta in passaFiltriQualita).
function qualita01(c) {
  return c.tipo === 'consenso'
    ? Math.min(1, c.nBook / (CONSENSO.nBookMinimo * 2))
    : (c.analisi.quality.confidence / 100) * 0.6 + (c.analisi.quality.data_quality / 100) * 0.4;
}

// --- CASSAFORTE --------------------------------------------------------------
// pool: array di { match, evento, comp, quando, inizio, mercato, prob,
// quota_fair, tipo, analisi? | nBook? }. Sceglie la singola con miglior
// rapporto probabilita'/quota DENTRO la banda richiesta, non necessariamente 1X2.
export function costruisciCassaforte(pool) {
  const cfg = SELEZIONE.cassaforte;
  const candidati = pool.filter(c => c.quota_fair >= cfg.quotaMin && c.quota_fair <= cfg.quotaMax
    && passaFiltriQualita(c, cfg));
  if (!candidati.length) return { selezione: null, motivo: `Nessun candidato in banda ${cfg.quotaMin}-${cfg.quotaMax} con qualita sufficiente e nessun rischio elevato.` };

  const preferiti = candidati.filter(c => c.quota_fair >= cfg.quotaPreferitaMin && c.quota_fair <= cfg.quotaPreferitaMax);
  const bacino = preferiti.length ? preferiti : candidati;

  // punteggio: probabilita' (il criterio principale, "probabilita' elevata"),
  // poi qualita' (confidence+dataQuality per il modello, n. bookmaker per il
  // consenso), poi il meno volatile a parita' di tutto il resto
  const punteggio = (c) => c.prob * 0.55 + qualita01(c) * 0.45;
  bacino.sort((a, b) => punteggio(b) - punteggio(a) || rangoVolatilita(a.mercato) - rangoVolatilita(b.mercato));
  return { selezione: bacino[0], banda_preferita_usata: preferiti.length > 0, motivo: null };
}

// --- QUOTA 2 -------------------------------------------------------------
// Cerca la combinazione (2, o 3 solo se necessario) di eventi DIVERSI la cui
// quota fair combinata cade in [quotaTotaleMin, quotaTotaleMax], ottimizzando
// probabilita' congiunta e qualita' media — non le due quote piu' basse. Puo'
// combinare candidati 'modello' e 'consenso' nella stessa schedina: ognuno
// porta il proprio punteggio di qualita', comparabile ma non identico.
function punteggioAgreement(c) {
  if (c.tipo === 'consenso') return 0.5; // neutro: nessun modello da confrontare col mercato
  const l = c.analisi.quality.agreement;
  return l === 'HIGH' ? 1 : l === 'MEDIUM' ? 0.6 : l === 'LOW' ? 0.15 : 0.4;
}
function punteggioCombo(selezioni, probCongiunta, pesi) {
  const qualitaMedia = selezioni.reduce((s, c) => s + qualita01(c), 0) / selezioni.length;
  const agrMedio = selezioni.reduce((s, c) => s + punteggioAgreement(c), 0) / selezioni.length;
  return probCongiunta * pesi.probabilitaCongiunta
    + qualitaMedia * (pesi.confidenceMedia + pesi.dataQualityMedia)
    + agrMedio * pesi.agreementMedio;
}

export function costruisciQuota2(pool) {
  const cfg = SELEZIONE.quota2;
  const candidatiGrezzi = pool.filter(c => passaFiltriQualita(c, cfg));
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

// --- SORPRESA (modello) ---------------------------------------------------
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

// --- SORPRESA (consenso) ---------------------------------------------------
// Senza un modello non esiste un EV/edge da misurare: inventarlo sarebbe un
// numero finto. Qui la "sorpresa" e' solo probabilita'/quota di mercato:
// fra i candidati in banda alta con abbastanza bookmaker, si sceglie il MENO
// probabile (la quota piu' alta ancora dentro banda) — e' il criterio piu'
// onesto disponibile quando l'unico dato e' il consenso di mercato stesso.
// Usata da build.mjs SOLO come ripiego, quando costruisciSorpresa (modello)
// non trova nulla: mai al posto di una sorpresa verificata quando esiste.
export function costruisciSorpresaConsenso(poolConsenso) {
  const cfg = SELEZIONE.sorpresa;
  const candidati = poolConsenso.filter(c => c.tipo === 'consenso'
    && c.quota_fair >= cfg.quotaMin && c.quota_fair <= cfg.quotaMax
    && c.nBook >= CONSENSO.nBookMinimo);
  if (!candidati.length) return { selezione: null, motivo: `Nessun evento a consenso in banda quota ${cfg.quotaMin}-${cfg.quotaMax} con abbastanza bookmaker d'accordo.` };

  candidati.sort((a, b) => a.prob - b.prob || b.nBook - a.nBook);
  return { selezione: candidati[0], motivo: null };
}
