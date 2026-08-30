// scripts/config.mjs
// Configurazione centralizzata del motore. Ogni numero che governa una stima
// o una soglia sta qui, non sparso nel codice: e' la condizione per poter
// confrontare due versioni del modello e sapere cosa e' cambiato.
//
// Regola di questo file: cambiare un valore qui deve bastare a cambiare il
// comportamento del modello. Se un numero serve altrove e non e' qui, e' un
// bug di questo file, non un'eccezione da tollerare.

// --- versione del modello --------------------------------------------------
//
// Ogni previsione porta questa stringa. La baseline e' congelata per sempre
// come 'football-v1-baseline': non si tocca mai, nemmeno quando la pipeline
// cambia. MODEL_VERSION e' la versione corrente, che puo' avanzare.
export const BASELINE_VERSION = 'football-v1-baseline';
export const MODEL_VERSION = 'football-v2-understat';

// Versione che la pipeline di PRODUZIONE etichetta sui pronostici pubblicati.
// Resta sulla baseline finche' FASE 4 (backtest, Brier, log loss) non dimostra
// che MODEL_VERSION e' effettivamente migliore: fino ad allora build.mjs
// continua a calcolare le probabilita' esattamente come prima (xG grezzo),
// e questa costante evita di etichettarle con un nome che promette un
// modello diverso da quello che le ha davvero prodotte.
export const PRODUZIONE_VERSION = BASELINE_VERSION;

// --- stima delle forze (Dixon-Coles) ----------------------------------------
export const MODELLO = {
  // che xG usare per stimare attacco/difesa: 'xg' e' il grezzo (baseline),
  // 'npxg' toglie i rigori. Il cambio va misurato, non assunto: e' il motivo
  // per cui esiste FASE 2 punto 15, il confronto automatico.
  fonteXG: 'xg',

  // decadimento esponenziale: peso = 0.5 ^ (eta_giorni / emivitaGiorni)
  emivitaGiorni: 180,

  // punto fisso di massima verosimiglianza: quante iterazioni prima di fermarsi
  iterazioni: 200,

  // limiti dei rating di attacco/difesa dopo la normalizzazione a media 1.
  // Argine contro rating estremi da campione piccolo o partite anomale.
  ratingMin: 0.25,
  ratingMax: 3.0,

  // limiti del vantaggio campo (un moltiplicatore unico per campionato)
  campoMin: 1.0,
  campoMax: 1.6,

  // griglia di ricerca per rho di Dixon-Coles (correzione punteggi bassi)
  rhoMin: -0.2,
  rhoMax: 0.05,
  rhoPasso: 0.005,

  // sotto questa soglia di partite storiche si aggiunge la stagione precedente
  storicoMinimo: 60,

  // sotto questa soglia una lega viene scartata per campione insufficiente
  legaMinimoPartite: 200
};

// --- Elo ---------------------------------------------------------------------
export const ELO = {
  // punto di partenza assoluto: usato solo per la primissima stagione del
  // dataset, quando non esiste ancora una media di lega da cui partire.
  partenza: 1500,
  // quanto pesa un singolo risultato: piu' alto, piu' reattivo e piu' rumoroso
  kFactor: 20,
  // punti aggiunti alla squadra di casa prima del calcolo dell'attesa
  vantaggioCasa: 60,
  // margine di vittoria: moltiplica il K in base allo scarto gol, attenuato
  // in log per non dare troppo peso ai tennis-score. Disattivabile a 0.
  pesoMarginale: true,
  // regressione parziale a ogni cambio di stagione: una squadra non e' la
  // stessa a inizio stagione (rosa, allenatore), ma non e' nemmeno ripartita
  // da zero. 0.25 = un quarto della distanza dalla media di lega viene
  // "dimenticato" a ogni nuova stagione. 0 disattiva la regressione.
  regressioneStagionale: 0.25,
  // handicap di partenza per una squadra mai vista nel dataset (neopromossa
  // o esordiente): parte sotto la media di lega di quella stagione, non alla
  // pari, perche' storicamente le neopromosse arrivano da un livello piu'
  // basso. Lo shrinkage in calcolaEloStorico la porta verso il vero valore
  // man mano che accumula partite.
  handicapNeopromossa: 60
};

// --- shrinkage -----------------------------------------------------------
//
// Per ogni feature calcolata su poche partite, il valore osservato viene
// tirato verso una media di riferimento in proporzione a quanto e' piccolo
// il campione: shrunk = (n/(n+k))*osservato + (k/(n+k))*riferimento.
// k e' la "forza" dello shrinkage: a k partite equivalenti, il peso e' meta'
// osservato e meta' riferimento. Configurabile per tipo di feature.
export const SHRINKAGE = {
  formaCasaTrasferta: { k: 8 },   // xG/xGA home o away: split spesso su <15 partite
  npxGD: { k: 6 },
  eloEsordiente: { k: 10 }        // quante partite prima che l'Elo "si fidi" della squadra
};

// --- finestre di forma -----------------------------------------------------
export const FINESTRE_FORMA = [3, 5, 8, 10]; // + 'season' calcolata a parte

// --- generazione pronostici (build.mjs) -------------------------------------
export const BUILD = {
  giorniOrizzonte: 5,        // quanto avanti guardare per le partite da pronosticare
  giorniScopertaEventi: 3,   // finestra per /events, la scoperta gratuita
  maxTennisPerGiro: 2,       // tetto sui tabelloni di tennis per esecuzione
  bandaValore: [0.55, 0.80], // banda di probabilita' per il mercato "di valore"
  bandaSolido: [0.80, 0.93]  // banda di probabilita' per il mercato "prudente"
};

// --- chiusura pronostici (chiudi.mjs) ---------------------------------------
export const CHIUSURA = {
  attesaOreDopoInizio: 2.5,  // quanto aspettare prima di cercare il risultato
  giorniAllarmePendente: 7   // oltre questa soglia un pendente viene segnalato
};

// --- DC-DRAW-CAL (layer sperimentale, Fase 8/10) ----------------------------
//
// Calibratore isotonic 1D su P_DRAW, mai sulla formula Dixon-Coles. Attivo
// solo se lo storico disponibile supera questa soglia (Fase 8: instabile con
// una sola stagione, ~1325 righe; il requisito minimo dichiarato e' ~2
// stagioni, ~3000 righe). Sotto soglia: fallback automatico alla baseline.
export const DRAWCAL = {
  minCampione: 3000,
  versione: 'football-v1.1-drawcal-candidate'
};

// --- MODEL AGREEMENT ---------------------------------------------------------
//
// Scarto massimo (in probabilita', 0-1) fra le stime confrontate (baseline,
// draw-cal, mercato no-vig) prima di scendere di livello.
export const AGREEMENT = {
  sogliaAlta: 0.03,   // <= 3 punti percentuali di scarto -> HIGH
  sogliaMedia: 0.08   // <= 8 punti percentuali -> MEDIUM, oltre -> LOW
};

// --- CONFIDENCE / DATA QUALITY ------------------------------------------------
//
// Confidence NON e' la probabilita' dell'esito: e' quanto ci si puo' fidare
// della stima, combinando accordo fra fonti, ampiezza del campione storico,
// eta' del dato e distanza dal mercato. contestoDisponibile (lineup/injury,
// Fase 10/API-Football) pesa nella DataQuality ma MAI nella probabilita'.
export const CONFIDENCE = {
  storicoDiRiferimento: 300,          // partite storiche oltre le quali la DataQuality storica satura
  partiteStagioneDiRiferimento: 10,   // partite di stagione corrente oltre le quali satura
  pesoStorico: 0.55,
  pesoStagioneCorrente: 0.25,
  pesoContesto: 0.20,                 // oggi sempre 0 in produzione: nessun dato di contesto integrato
  freschezzaMassimaOre: 48,           // oltre questa eta' del dato la freschezza conta 0
  scartoMercatoRiferimento: 0.20,     // scarto modello-mercato oltre il quale la distanza conta 0
  pesiConfidence: { agreement: 0.35, dataQuality: 0.30, freschezza: 0.15, distanzaMercato: 0.20 }
};

// --- VALUE CLASSIFICATION -----------------------------------------------------
//
// Soglie configurabili, mai punteggi fissi nel codice del sito. Nessuna
// etichetta implica certezza: sono classi di processo (EV/edge/qualita'),
// non previsioni di esito.
export const VALORE = {
  confidenceMinimaWatch: 40,   // sotto: EV positivo ma qualita' troppo bassa -> WATCH, mai VALUE
  dataQualityMinimaWatch: 35,
  evSogliaForte: 0.08,
  edgeSogliaForte: 0.05,
  confidenceMinimaForte: 65,
  dataQualityMinimaForte: 55
};

// --- fuso orario -------------------------------------------------------------
//
// Il runner di GitHub Actions e' in UTC. Ogni orario mostrato all'utente deve
// passare da questa costante, altrimenti la pagina mostra l'ora sbagliata
// per meta' dell'anno (e per l'altra meta' per caso).
export const FUSO_ORARIO = 'Europe/Rome';
