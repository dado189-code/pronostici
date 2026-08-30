// scripts/features.mjs
// Feature calcolate ma non (ancora) usate per cambiare le probabilita' del
// modello principale. Ogni funzione qui e' pura e testabile in isolamento:
// riceve dati, restituisce un numero o una struttura, non tocca file ne' rete.
//
// Principio guida di questo file, ripetuto perche' e' la regola con piu'
// probabilita' di essere violata per fretta: una feature calcolata qui entra
// nel calcolo di lambda/mercati SOLO dopo essere stata misurata nel backtest.
// Fino ad allora e' un dato salvato, non un peso.

import { SHRINKAGE, ELO, FINESTRE_FORMA } from './config.mjs';

// ---------------------------------------------------------------- shrinkage

// shrunk = (n/(n+k))*osservato + (k/(n+k))*riferimento
// A n=0 ritorna il riferimento puro. A n->infinito ritorna l'osservato puro.
// A n=k, e' esattamente a meta' fra i due: e' la definizione di k.
export function shrink(osservato, riferimento, n, k) {
  if (!Number.isFinite(osservato) || n <= 0) return riferimento;
  if (!Number.isFinite(riferimento)) return osservato;
  const peso = n / (n + k);
  return peso * osservato + (1 - peso) * riferimento;
}

// ---------------------------------------------------------------- decadimento

// Stessa formula usata dentro stimaForze, esposta qui come funzione pura
// cosi' da poterla testare e riusare senza duplicarla.
export function pesoDecadimento(etaGiorni, emivitaGiorni) {
  return Math.pow(0.5, etaGiorni / emivitaGiorni);
}

function mediaPesata(valori, pesi) {
  let num = 0, den = 0;
  for (let i = 0; i < valori.length; i++) {
    if (!Number.isFinite(valori[i])) continue;
    num += valori[i] * pesi[i]; den += pesi[i];
  }
  return den > 0 ? num / den : null;
}

// ---------------------------------------------------------------- home/away split
//
// storia: array di { h_a: 'h'|'a', xG, xGA, npxG, npxGA, date } per UNA squadra,
// nella forma restituita da teams[].history di Understat.
// Calcola le medie separate casa/trasferta con decadimento temporale, poi le
// tira verso la media complessiva della squadra quando il campione e' piccolo
// (un campionato ha ~19 partite in casa: gia' poche per stare senza shrinkage).
export function formaCasaTrasferta(storia, oggi = new Date(), emivitaGiorni = 180) {
  const pesi = storia.map(h => pesoDecadimento((oggi - new Date(h.date)) / 864e5, emivitaGiorni));
  const complessivo = {
    xG: mediaPesata(storia.map(h => h.xG), pesi),
    xGA: mediaPesata(storia.map(h => h.xGA), pesi),
    npxG: mediaPesata(storia.map(h => h.npxG), pesi),
    npxGA: mediaPesata(storia.map(h => h.npxGA), pesi)
  };

  const k = SHRINKAGE.formaCasaTrasferta.k;
  const perLato = (lato) => {
    const idx = storia.map((h, i) => h.h_a === lato ? i : -1).filter(i => i >= 0);
    const n = idx.length;
    const sel = (campo) => idx.map(i => storia[i][campo]);
    const pesiSel = idx.map(i => pesi[i]);
    const grezzo = {
      xG: mediaPesata(sel('xG'), pesiSel), xGA: mediaPesata(sel('xGA'), pesiSel),
      npxG: mediaPesata(sel('npxG'), pesiSel), npxGA: mediaPesata(sel('npxGA'), pesiSel)
    };
    return {
      n,
      xG: shrink(grezzo.xG, complessivo.xG, n, k),
      xGA: shrink(grezzo.xGA, complessivo.xGA, n, k),
      npxG: shrink(grezzo.npxG, complessivo.npxG, n, k),
      npxGA: shrink(grezzo.npxGA, complessivo.npxGA, n, k)
    };
  };

  return { complessivo, casa: perLato('h'), trasferta: perLato('a') };
}

// ---------------------------------------------------------------- npxGD a finestre
//
// npxGD = npxG - npxGA. Ultime N partite (piu' recenti prima) e stagione intera,
// tutte con lo stesso decadimento del resto del modello: una finestra "last 3"
// coi pesi gia' bassi sulle partite piu' vecchie della finestra e' quello che
// rende le finestre comparabili fra loro invece di essere medie semplici.
export function npxGDFinestre(storiaOrdinataDiscendente, oggi = new Date(),
  finestre = FINESTRE_FORMA, emivitaGiorni = 180) {
  const out = {};
  for (const n of finestre) {
    const fetta = storiaOrdinataDiscendente.slice(0, n);
    const pesi = fetta.map(h => pesoDecadimento((oggi - new Date(h.date)) / 864e5, emivitaGiorni));
    const npxG = mediaPesata(fetta.map(h => h.npxG), pesi);
    const npxGA = mediaPesata(fetta.map(h => h.npxGA), pesi);
    out[`last${n}`] = { npxG, npxGA, npxGD: (npxG != null && npxGA != null) ? npxG - npxGA : null, nDisponibili: fetta.length };
  }
  const pesiTot = storiaOrdinataDiscendente.map(h => pesoDecadimento((oggi - new Date(h.date)) / 864e5, emivitaGiorni));
  const npxGStag = mediaPesata(storiaOrdinataDiscendente.map(h => h.npxG), pesiTot);
  const npxGAStag = mediaPesata(storiaOrdinataDiscendente.map(h => h.npxGA), pesiTot);
  out.season = { npxG: npxGStag, npxGA: npxGAStag,
    npxGD: (npxGStag != null && npxGAStag != null) ? npxGStag - npxGAStag : null,
    nDisponibili: storiaOrdinataDiscendente.length };
  return out;
}

// ---------------------------------------------------------------- expected points

// xPts arriva gia' calcolato da Understat per ogni partita. Qui si somma e si
// confronta con i punti veri: over/under-performance rispetto a quanto la
// qualita' del gioco (gli xG) avrebbe dovuto rendere in classifica.
export function xPointsDelta(storia) {
  const puntiVeri = storia.reduce((a, h) => a + (h.pts ?? 0), 0);
  const puntiAttesi = storia.reduce((a, h) => a + (Number.isFinite(h.xpts) ? h.xpts : 0), 0);
  return { puntiVeri, puntiAttesi: +puntiAttesi.toFixed(2), delta: +(puntiVeri - puntiAttesi).toFixed(2), nPartite: storia.length };
}

// ---------------------------------------------------------------- Elo
//
// Elo indipendente dal mercato: si aggiorna solo con risultati veri (vittoria/
// pareggio/sconfitta), mai con le quote. L'aggiornamento e' sequenziale nel
// tempo, quindi va passato in ordine cronologico crescente per non introdurre
// leakage (l'Elo "prima" della partita N non deve sapere il suo risultato).
function attesaElo(eloCasa, eloOspite, vantaggioCasa) {
  return 1 / (1 + Math.pow(10, -((eloCasa + vantaggioCasa) - eloOspite) / 400));
}

// margine di vittoria: attenua il K in base allo scarto reti, in scala log
// (World Football Elo Ratings), cosi' un 5-0 pesa piu' di un 1-0 ma non 5 volte tanto
function moltiplicatoreMargine(scartoGol, diffElo) {
  if (scartoGol <= 1) return 1;
  return Math.log(scartoGol) * (2.2 / ((Math.abs(diffElo) * 0.001) + 2.2));
}

export function aggiornaElo(eloCasa, eloOspite, golCasa, golOspite, config = ELO) {
  const risultato = golCasa > golOspite ? 1 : golCasa < golOspite ? 0 : 0.5;
  const attesoCasa = attesaElo(eloCasa, eloOspite, config.vantaggioCasa);
  const scarto = Math.abs(golCasa - golOspite);
  const mult = config.pesoMarginale ? moltiplicatoreMargine(scarto, eloCasa - eloOspite) : 1;
  const variazione = config.kFactor * mult * (risultato - attesoCasa);
  return {
    eloCasaDopo: eloCasa + variazione,
    eloOspiteDopo: eloOspite - variazione,
    eloDiffPrima: eloCasa - eloOspite,
    attesoCasa
  };
}

// Passata sequenziale su una lega intera: costruisce l'Elo squadra per
// squadra, partita per partita, in ordine cronologico. Ritorna sia l'Elo
// finale di ogni squadra sia la storia completa (prima/dopo/trend per ogni
// partita), che e' cio' che va nello snapshot per la tracciabilita' richiesta.
export function calcolaEloStorico(partiteOrdinateCronologico, config = ELO) {
  const elo = {};
  const storia = [];
  const contaPartite = {};

  for (const p of partiteOrdinateCronologico) {
    if (elo[p.casa] === undefined) elo[p.casa] = config.partenza;
    if (elo[p.ospite] === undefined) elo[p.ospite] = config.partenza;
    contaPartite[p.casa] = (contaPartite[p.casa] || 0) + 1;
    contaPartite[p.ospite] = (contaPartite[p.ospite] || 0) + 1;

    const eloCasaPrima = elo[p.casa], eloOspitePrima = elo[p.ospite];
    const r = aggiornaElo(eloCasaPrima, eloOspitePrima, p.golCasa, p.golOspite, config);
    elo[p.casa] = r.eloCasaDopo;
    elo[p.ospite] = r.eloOspiteDopo;

    storia.push({
      data: p.data, casa: p.casa, ospite: p.ospite,
      eloCasaPrima: +eloCasaPrima.toFixed(1), eloOspitePrima: +eloOspitePrima.toFixed(1),
      eloCasaDopo: +elo[p.casa].toFixed(1), eloOspiteDopo: +elo[p.ospite].toFixed(1),
      eloDiffPrima: +r.eloDiffPrima.toFixed(1)
    });
  }

  const trend = {};
  for (const s of Object.keys(elo)) {
    const partiteS = storia.filter(h => h.casa === s || h.ospite === s);
    const ultime5 = partiteS.slice(-5);
    const primaDi5 = ultime5.length ? (ultime5[0].casa === s ? ultime5[0].eloCasaPrima : ultime5[0].eloOspitePrima) : elo[s];
    trend[s] = +(elo[s] - primaDi5).toFixed(1);
  }

  // squadre con poche partite: l'Elo e' inaffidabile finche' non ne ha viste
  // abbastanza. Non lo si tira verso una media (non avrebbe senso su una scala
  // relativa), lo si segnala con un flag di confidenza bassa.
  const confidenzaBassa = Object.fromEntries(
    Object.keys(elo).map(s => [s, (contaPartite[s] || 0) < SHRINKAGE.eloEsordiente.k]));

  return { eloAttuale: elo, trend, storia, confidenzaBassa, nPartite: contaPartite };
}

// ---------------------------------------------------------------- forma grezza vs corretta
//
// Distinzione richiesta esplicitamente: RAW FORM e' la media dei numeri della
// squadra senza guardare chi ha affrontato. OPPONENT-ADJUSTED FORM e' il
// rating di stimaForze, che per costruzione (il punto fisso di verosimiglianza)
// gia' pesa la difficolta' degli avversari al denominatore. Non sono la stessa
// cosa e qui si tengono entrambe visibili, non solo la seconda.
export function formaGrezzaVsCorretta(storiaRecente, ratingAttOpponentAdjusted) {
  const npxGMedio = storiaRecente.length
    ? storiaRecente.reduce((a, h) => a + (h.npxG ?? 0), 0) / storiaRecente.length : null;
  return {
    rawForm: { npxGMedio, nPartite: storiaRecente.length },
    opponentAdjustedForm: { rating: ratingAttOpponentAdjusted },
    nota: 'rawForm ignora la forza degli avversari incontrati; opponentAdjustedForm (da stimaForze) la scorpora gia'
  };
}

// ---------------------------------------------------------------- player layer
//
// Solo struttura dati, come richiesto: NON entra nel calcolo delle probabilita'.
// Understat la restituisce gia' per squadra dentro il blocco "players".
export function normalizzaGiocatore(p) {
  return {
    id: p.id, nome: p.player_name, squadra: p.team_title,
    minuti: parseInt(p.time, 10) || 0,
    presenze: parseInt(p.games, 10) || 0,
    gol: parseInt(p.goals, 10) || 0,
    npxG: parseFloat(p.npxG) || 0,
    assist: parseInt(p.assists, 10) || 0,
    xA: parseFloat(p.xA) || 0,
    xGChain: parseFloat(p.xGChain) || 0,
    xGBuildup: parseFloat(p.xGBuildup) || 0,
    ruolo: p.position || null
  };
}
