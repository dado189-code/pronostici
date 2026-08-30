// scripts/build.mjs
// Pipeline: stima le forze delle squadre dagli xG (modello indipendente),
// scarica le quote di piu' bookmaker, confronta le due cose e scrive
// data/picks.json. Il valore nasce dallo scarto fra modello e lavagna.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { scaricaUnderstat, stimaForze, stimaRho, lambde, mercati, consenso }
  from './model.mjs';
import { PRODUZIONE_VERSION, BASELINE_VERSION, BUILD, FUSO_ORARIO, MODELLO, DRAWCAL } from './config.mjs';
import { salvaSnapshot } from './snapshot.mjs';
import { costruisciCalibratore, applicaDrawCal } from './drawcal.mjs';
import { fairOdds, ev as calcolaEV, edge, agreement, dataQuality, confidence, classificaValore, spiegaPick,
  marketGapInfo, classificaRischioQuota, idoneoBestPick, opportunityScore } from './valore.mjs';
import { costruisciCassaforte, costruisciQuota2, costruisciSorpresa } from './selezioni.mjs';

// DC-DRAW-CAL: layer sperimentale, calcolato UNA VOLTA per esecuzione, letto
// solo dallo storico locale (nessuna chiamata di rete). Se il campione e'
// sotto soglia, resta con attivo:false e ogni chiamata a applicaDrawCal fa
// fallback trasparente alla tripla baseline (vedi drawcal.mjs).
const calibratoreDrawCal = costruisciCalibratore();
console.log(calibratoreDrawCal.attivo
  ? `DC-DRAW-CAL attivo: calibrato su ${calibratoreDrawCal.nCampione} partite storiche.`
  : `DC-DRAW-CAL disattivato: ${calibratoreDrawCal.motivo}`);

const KEY = process.env.ODDS_API_KEY;
if (!KEY) { console.error('Manca ODDS_API_KEY'); process.exit(1); }

const STAGIONE = process.env.STAGIONE || String(new Date().getFullYear() - (new Date().getMonth() < 6 ? 1 : 0));
// Numeri di soglia centralizzati in config.mjs (FASE 1): cambiarli qui
// cambierebbe solo la variabile locale, non il comportamento della pipeline.
const GIORNI = BUILD.giorniOrizzonte;
const GIORNI_SCOPERTA = BUILD.giorniScopertaEventi;
const MAX_TENNIS = BUILD.maxTennisPerGiro;

const LEGHE = [
  { understat: 'Serie_A',    odds: 'soccer_italy_serie_a',    nome: 'Serie A' },
  { understat: 'EPL',        odds: 'soccer_epl',              nome: 'Premier League' },
  { understat: 'La_liga',    odds: 'soccer_spain_la_liga',    nome: 'Liga' },
  { understat: 'Ligue_1',    odds: 'soccer_france_ligue_one', nome: 'Ligue 1' },
  { understat: 'Bundesliga', odds: 'soccer_germany_bundesliga', nome: 'Bundesliga' }
];

// Sport senza modello indipendente: per questi non esiste una fonte xG e
// model.mjs non serve. Il pronostico puo' venire solo dal consenso dei
// bookmaker, quindi e' su base diversa dal calcio e va etichettato come tale.
// Le chiavi del basket sono fisse; quelle del tennis cambiano a ogni torneo e
// vengono scoperte a ogni esecuzione.
const BASKET = [
  { odds: 'basketball_wnba', nome: 'WNBA',  sport: 'basket' },
  { odds: 'basketball_nba',  nome: 'NBA',   sport: 'basket' }
];

const API = 'https://api.the-odds-api.com/v4';
const QUOTE = 'data/quote-storico.json';
const isoSecondi = (d) => d.toISOString().slice(0, 19) + 'Z';

// --- nomi squadra: Understat e i bookmaker li scrivono diversamente
const ALIAS = {
  'internazionale': 'inter', 'inter milan': 'inter', 'inter milano': 'inter',
  'ac milan': 'milan', 'as roma': 'roma', 'ssc napoli': 'napoli',
  'hellas verona': 'verona', 'juventus turin': 'juventus',
  'manchester utd': 'manchester united', 'wolverhampton wanderers': 'wolves',
  'tottenham hotspur': 'tottenham', 'brighton and hove albion': 'brighton',
  'nottingham forest': 'nottm forest',
  // Understat scrive "Hull": troppo corto per il ripiego sul prefisso, che vuole 5 caratteri
  'hull city': 'hull',
  'atletico de madrid': 'atletico madrid', 'athletic club': 'athletic bilbao',
  'ca osasuna': 'osasuna',
  'real betis balompie': 'real betis', 'celta de vigo': 'celta vigo',
  'espanyol barcelona': 'espanyol', 'deportivo alaves': 'alaves',
  'paris saint germain': 'psg', 'paris saint-germain': 'psg',
  'olympique marseille': 'marseille', 'olympique lyonnais': 'lyon', 'olympique lyon': 'lyon',
  'bayern munich': 'bayern munchen', 'borussia dortmund': 'dortmund',
  'bayer leverkusen': 'leverkusen', 'eintracht frankfurt': 'frankfurt',
  // Understat usa il nome inglese o la ragione sociale lunga, i bookmaker no
  '1 fc koln': 'cologne', 'tsg hoffenheim': 'hoffenheim',
  'rb leipzig': 'rasenballsport leipzig', 'fsv mainz 05': 'mainz 05'
};

function chiave(nome) {
  let s = (nome || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  s = s.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (ALIAS[s]) return ALIAS[s];
  s = s.replace(/\b(fc|cf|ac|as|ssc|sc|us|ud|rc|rcd|cd|sd|afc|bc|club|calcio|de|the)\b/g, '')
       .replace(/\s+/g, ' ').trim();
  return ALIAS[s] || s;
}

function trova(indice, nome) {
  const k = chiave(nome);
  if (indice[k]) return indice[k];
  // ripiego: prefisso comune di almeno 5 caratteri
  for (const [kk, v] of Object.entries(indice))
    if (kk.length >= 5 && (kk.startsWith(k.slice(0, 5)) || k.startsWith(kk.slice(0, 5)))) return v;
  return null;
}

// --- scelta del mercato: una giocata di valore e una prudente
function scegli(mk, minProb, maxProb) {
  const c = Object.entries(mk)
    .filter(([, v]) => v >= minProb && v <= maxProb)
    .sort((a, b) => a[1] - b[1]);           // la meno probabile fra le accettabili = quota piu' alta
  return c[0] || null;
}

const out = [];
const diagnostica = [];
// archivio delle quote di questo giro, per misurare i movimenti nel tempo
const rilevazioni = [];
// Candidati per Cassaforte/Quota2/Sorpresa: un elemento per OGNI mercato di
// OGNI partita con analisi disponibile (quindi con confidence/dataQuality/
// agreement/market gap calcolati) - non solo i 2-3 mercati gia' in "out".
// Le quote qui sono fair odds del modello (1/prob), coerenti col resto del
// sito, tranne dove esiste anche una quota bookmaker reale (segni 1X2).
const poolSelezione = [];

// --- scoperta gratuita degli eventi
//
// /v4/sports e /v4/sports/{k}/events non consumano crediti: misurato, il
// contatore x-requests-used non si muove. Solo /odds si paga. Quindi conviene
// sempre chiedere prima se ci sono eventi, e pagare solo se ci sono: la NBA
// d'estate non costa niente invece di bruciare un credito al giorno a vuoto.
async function eventiImminenti(chiave) {
  const da = isoSecondi(new Date());
  const a = isoSecondi(new Date(Date.now() + GIORNI_SCOPERTA * 864e5));
  try {
    const r = await fetch(`${API}/sports/${chiave}/events?apiKey=${KEY}`
      + `&commenceTimeFrom=${da}&commenceTimeTo=${a}`);
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j : null;
  } catch { return null; }
}

// I tornei di tennis nascono e finiscono in continuazione: una lista scritta a
// mano invecchia in giorni. Qui si chiede all'API quali chiavi tennis_ esistono
// ora, si scartano gli antepost e si tengono quelle che hanno davvero eventi.
async function chiaviTennis() {
  let tutti;
  try {
    const r = await fetch(`${API}/sports/?apiKey=${KEY}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    tutti = await r.json();
  } catch (e) {
    diagnostica.push(`Tennis: elenco sport non disponibile (${e.message}), nessun torneo in questo giro`);
    return [];
  }
  const candidate = tutti.filter(s => s.key.startsWith('tennis_')
    && !s.key.endsWith('_championship_winner') && !s.has_outrights);
  if (!candidate.length) { diagnostica.push('Tennis: nessun torneo aperto'); return []; }

  const conEventi = [];
  for (const s of candidate) {
    const ev = await eventiImminenti(s.key);
    if (ev && ev.length) conEventi.push({ odds: s.key, nome: s.title, sport: 'tennis', n: ev.length });
  }
  if (!conEventi.length) {
    diagnostica.push(`Tennis: ${candidate.length} tornei aperti ma nessun evento nei prossimi ${GIORNI_SCOPERTA} giorni`);
    return [];
  }
  conEventi.sort((a, b) => b.n - a.n);
  const scelti = conEventi.slice(0, MAX_TENNIS);
  if (conEventi.length > MAX_TENNIS)
    diagnostica.push(`Tennis: ${conEventi.length} tabelloni con eventi, ne uso ${MAX_TENNIS} `
      + `(${scelti.map(s => s.nome).join(', ')}), scartati ${conEventi.slice(MAX_TENNIS).map(s => s.nome).join(', ')}`);
  return scelti;
}

// --- pronostici dal solo consenso, per gli sport senza modello
async function daConsenso(comp) {
  const imminenti = await eventiImminenti(comp.odds);
  if (imminenti === null) { diagnostica.push(`${comp.nome}: elenco eventi non raggiungibile`); return; }
  if (!imminenti.length) {
    diagnostica.push(`${comp.nome}: nessun evento nei prossimi ${GIORNI_SCOPERTA} giorni, richiesta quote saltata`);
    return;
  }

  let eventi;
  try {
    const r = await fetch(`${API}/sports/${comp.odds}/odds`
      + `?apiKey=${KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    eventi = await r.json();
  } catch (e) {
    diagnostica.push(`${comp.nome}: quote non disponibili (${e.message})`);
    return;
  }

  for (const ev of eventi) {
    const inizio = new Date(ev.commence_time);
    const ore = Math.round((inizio - Date.now()) / 36e5);
    if (ore < 0 || ore > GIORNI * 24) continue;

    const cons = consenso(ev.bookmakers);
    if (!cons) continue;

    const righe = Object.entries(cons)
      .map(([nome, d]) => ({ nome, prob: d.prob, prezzo: d.prezzo, book: d.book, nBook: d.nBook }))
      .sort((a, b) => b.prob - a.prob);
    rilevazioni.push({ match: `${ev.home_team} - ${ev.away_team}`, comp: comp.nome, inizio: inizio.toISOString(),
      quote: righe.map(r => ({ esito: r.nome, prob: +r.prob.toFixed(4), prezzo: r.prezzo, nBook: r.nBook })) });

    const favorito = righe[0];
    if (!favorito || !(favorito.prob > 0)) continue;

    out.push({
      sport: comp.sport, comp: comp.nome,
      evento: `${ev.home_team} - ${ev.away_team}`,
      quando: inizio.toLocaleString('it-IT',
        { timeZone: FUSO_ORARIO, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
      ore, match: `${ev.home_team} - ${ev.away_team}`.toLowerCase(),
      inizio: inizio.toISOString(),
      fonte: 'consenso',
      mercato: `${favorito.nome} vincente`,
      prob: +favorito.prob.toFixed(3),
      // niente campo "prezzo": senza un modello indipendente non esiste uno
      // scarto da misurare, quindi il badge del valore non deve comparire
      why: `Nessun modello xG copre ${comp.nome}: questa e la probabilita che il mercato sta `
         + `prezzando, ${(favorito.prob * 100).toFixed(1)}%, ricavata togliendo il margine alle quote di `
         + `${favorito.nBook} bookmaker e facendone la media. Miglior prezzo ${favorito.prezzo.toFixed(2)} `
         + `su ${favorito.book}. Non e un pronostico indipendente: e la lavagna, ripulita.`,
      src: `consenso di ${favorito.nBook} bookmaker, nessun modello indipendente`
    });
  }
}

for (const lega of LEGHE) {
  let storicoCorrente, storicoPrecedente = [];
  try {
    storicoCorrente = await scaricaUnderstat(lega.understat, STAGIONE);
    // se la stagione e' appena iniziata, aggiungi la precedente
    if (storicoCorrente.length < 60) {
      storicoPrecedente = await scaricaUnderstat(lega.understat, String(Number(STAGIONE) - 1));
    }
  } catch (e) {
    diagnostica.push(`${lega.nome}: storico xG non disponibile (${e.message})`);
    continue;
  }
  // Il decay temporale (emivita 180gg, gia' esistente) fa gia' tutto il lavoro:
  // le forze si stimano su TUTTO lo storico disponibile, non solo sulla
  // stagione corrente, quindi non si azzerano mai a inizio stagione. Qui non
  // si tocca stimaForze/lambde/mercati: solo si registra separatamente quanta
  // massa (pesata dal decay) viene da ciascuna fetta, per mostrarlo (punto 3).
  const storico = [...storicoPrecedente, ...storicoCorrente];
  if (storico.length < 40) {
    diagnostica.push(`${lega.nome}: solo ${storico.length} partite con xG, troppo poche per stimare`);
    continue;
  }

  const forze = stimaForze(storico, { emivita: MODELLO.emivitaGiorni });
  const rho = stimaRho(storico.slice(-300), forze, MODELLO);
  const indice = Object.fromEntries(forze.squadre.map(s => [chiave(s), s]));

  // punto 3: quota di massa (pesata dal decay, stessa emivita del modello)
  // che viene dalla stagione corrente rispetto alla precedente, "adesso" -
  // solo per mostrarlo, non cambia lambda/rho/mercati.
  const adesso = Date.now();
  const pesoDecay = (data) => Math.pow(0.5, (adesso - data.getTime()) / (864e5 * MODELLO.emivitaGiorni));
  function contributoStagionale(squadra) {
    const partitePrec = storicoPrecedente.filter(p => p.casa === squadra || p.ospite === squadra);
    const partiteCorr = storicoCorrente.filter(p => p.casa === squadra || p.ospite === squadra);
    const pesoPrec = partitePrec.reduce((a, x) => a + pesoDecay(x.data), 0);
    const pesoCorr = partiteCorr.reduce((a, x) => a + pesoDecay(x.data), 0);
    const tot = pesoPrec + pesoCorr;
    return {
      matches_current_season: partiteCorr.length,
      previous_season_contribution_pct: tot > 0 ? +(pesoPrec / tot * 100).toFixed(1) : null,
      current_season_contribution_pct: tot > 0 ? +(pesoCorr / tot * 100).toFixed(1) : null
    };
  }

  let eventi = [];
  try {
    const r = await fetch(`https://api.the-odds-api.com/v4/sports/${lega.odds}/odds`
      + `?apiKey=${KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    eventi = await r.json();
  } catch (e) {
    diagnostica.push(`${lega.nome}: quote non disponibili (${e.message})`);
    continue;
  }

  for (const ev of eventi) {
    const inizio = new Date(ev.commence_time);
    const ore = Math.round((inizio - Date.now()) / 36e5);
    if (ore < 0 || ore > GIORNI * 24) continue;

    const casa = trova(indice, ev.home_team);
    const ospite = trova(indice, ev.away_team);
    if (!casa || !ospite) {
      diagnostica.push(`${lega.nome}: nomi non abbinati "${ev.home_team}" / "${ev.away_team}"`);
      continue;
    }

    const { lh, la } = lambde(forze, casa, ospite);
    if (!lh || !la) continue;
    const mk = mercati(lh, la, rho);

    // DC-DRAW-CAL: layer sperimentale, calcolato SOLO da mk['1']/mk['X']/mk['2']
    // (pure model) gia' pronti sopra. Non tocca mk stesso.
    const calibrato = applicaDrawCal(mk['1'], mk['X'], mk['2'], calibratoreDrawCal);
    const calByLetter = { '1': calibrato.P1, 'X': calibrato.PX, '2': calibrato.P2 };
    const contribCasa = contributoStagionale(casa);
    const contribOspite = contributoStagionale(ospite);

    // confronto col mercato sul solo 1X2, l'unico dove ho le quote
    const cons = consenso(ev.bookmakers);
    let confronto = null;
    if (cons) {
      const mappa = { [ev.home_team]: '1', [ev.away_team]: '2', 'Draw': 'X' };
      confronto = Object.entries(cons).map(([nome, d]) => {
        const seg = mappa[nome];
        return {
          esito: seg || nome,
          probModello: +(mk[seg] ?? 0).toFixed(3),
          probMercato: +d.prob.toFixed(3),
          prezzo: d.prezzo, book: d.book, nBook: d.nBook,
          valore: +((mk[seg] ?? 0) * d.prezzo - 1).toFixed(3)
        };
      }).sort((a, b) => b.valore - a.valore);
    }

    const migliore = confronto && confronto[0];

    // index.html legge la quota al primo livello, nel campo "prezzo", e ci calcola
    // il badge "lavagna X, valore Y%" come prob * quota - 1. Perche' quel conto
    // abbia senso la quota deve riferirsi allo STESSO mercato del pronostico.
    // Qui scarico solo l'h2h, quindi la quota vera esiste solo per 1, X e 2:
    // allegarla a un Multigol o a un Over darebbe un valore calcolato su due
    // eventi diversi, cioe' un numero inventato. Negli altri casi resta assente
    // e il badge semplicemente non compare.
    const prezzoDi = (mercato) => {
      const c = confronto && confronto.find(x => x.esito === mercato);
      return c ? c.prezzo : undefined;
    };
    const valore = scegli(mk, ...BUILD.bandaValore);
    const solido = scegli(mk, ...BUILD.bandaSolido);
    // il runner di GitHub e' in UTC: senza timeZone la pagina mostrerebbe
    // gli orari due ore indietro rispetto all'Italia
    const quando = inizio.toLocaleString('it-IT',
      { timeZone: FUSO_ORARIO, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const idMatch = chiave(casa) + '-' + chiave(ospite);
    if (cons) rilevazioni.push({ match: idMatch, comp: lega.nome, inizio: inizio.toISOString(),
      quote: Object.entries(cons).map(([nome, d]) => ({
        esito: (nome === ev.home_team ? '1' : nome === ev.away_team ? '2' : nome === 'Draw' ? 'X' : nome),
        prob: +d.prob.toFixed(4), prezzo: d.prezzo, nBook: d.nBook })) });
    // Analisi di partita (punti 4/5/6/7/9 della modalita' avanzata): calcolata
    // UNA VOLTA per partita sul segno 1X2 di riferimento (il "migliore" per
    // EV se le quote ci sono), poi allegata a ogni pronostico della stessa
    // partita. Nessuna di queste chiamate modifica mk/lh/la/rho.
    let analisi = null;
    if (migliore) {
      const pCal = calibrato.attivo ? calByLetter[migliore.esito] : null;
      const agr = agreement([migliore.probModello, pCal, migliore.probMercato]);
      const matchesRif = Math.min(contribCasa.matches_current_season, contribOspite.matches_current_season);
      const dq = dataQuality({ nStorico: storico.length, currentSeasonMatches: matchesRif, contestoDisponibile: false });

      // MARKET GAP (punto 1): i backtest precedenti mostrano che il mercato
      // closing batte il Pure Model e che il CLV storico e' negativo, quindi
      // un forte disaccordo penalizza la confidence invece di essere trattato
      // come un vantaggio. gapInfo.bloccaValueClass forza il tetto a WATCH.
      const marketGap = migliore.probModello - migliore.probMercato;
      const gapInfo = marketGapInfo(marketGap);
      const confGrezza = confidence({
        agreementLivello: agr.livello, nStorico: storico.length, currentSeasonMatches: matchesRif,
        freschezzaOre: 0, contestoDisponibile: false, scartoDalMercato: Math.abs(marketGap)
      });
      const conf = Math.max(0, confGrezza - gapInfo.penalitaConfidence);

      const evVal = calcolaEV(migliore.probModello, migliore.prezzo);
      const edgeVal = edge(migliore.probModello, migliore.probMercato);
      const fo = fairOdds(migliore.probModello);
      const rischioQuota = classificaRischioQuota(migliore.prezzo);
      const valueClass = classificaValore({ evValue: evVal, edgeValue: edgeVal, confidenceScore: conf, dataQualityScore: dq, agreementLivello: agr.livello, marketGapLivello: gapInfo.livello });
      const idoneita = idoneoBestPick({ confidenceScore: conf, dataQualityScore: dq, agreementLivello: agr.livello, marketGap, quota: migliore.prezzo, evValue: evVal });

      analisi = {
        pure_model: { P1: +mk['1'].toFixed(4), PX: +mk['X'].toFixed(4), P2: +mk['2'].toFixed(4), model_version: BASELINE_VERSION },
        calibrated: { P1: +calibrato.P1.toFixed(4), PX: +calibrato.PX.toFixed(4), P2: +calibrato.P2.toFixed(4),
          attivo: calibrato.attivo, motivo: calibrato.motivo || null, model_version: DRAWCAL.versione, badge: 'EXPERIMENTAL CALIBRATION' },
        expected_goals: { lambda_home: +lh.toFixed(3), lambda_away: +la.toFixed(3) },
        market: { esito_riferimento: migliore.esito, bookmaker_odds: migliore.prezzo, book: migliore.book,
          n_book: migliore.nBook, no_vig_probability: migliore.probMercato },
        value: { fair_odds: fo !== null ? +fo.toFixed(3) : null, edge: edgeVal !== null ? +edgeVal.toFixed(4) : null, ev: evVal !== null ? +evVal.toFixed(4) : null },
        quality: { agreement: agr.livello, agreement_scarto: agr.scartoMassimo, confidence: conf, data_quality: dq },
        market_gap: { valore: +Math.abs(marketGap).toFixed(4), livello: gapInfo.livello, etichetta: gapInfo.etichetta || null },
        rischio_quota: rischioQuota,
        value_class: valueClass,
        best_pick_idoneo: idoneita.idoneo,
        best_pick_motivi_esclusione: idoneita.motiviEsclusione,
        opportunity_score: +opportunityScore({ confidenceScore: conf, dataQualityScore: dq, evValue: evVal, agreementLivello: agr.livello }).toFixed(4),
        contesto: { lineup_injury_disponibile: false, peso_predittivo: 0,
          nota: "API-Football non ancora integrata in produzione (Fase 10 in corso): nessun aggiustamento sulle probabilita'." },
        stagione: { casa: contribCasa, ospite: contribOspite },
        why: spiegaPick({ evento: `${casa} - ${ospite}`, esitoLabel: migliore.esito === '1' ? `la vittoria di ${casa}` : migliore.esito === '2' ? `la vittoria di ${ospite}` : 'il pareggio',
          pModel: migliore.probModello, pMercato: migliore.probMercato, quotaBookmaker: migliore.prezzo, agreementLivello: agr.livello, marketGapLivello: gapInfo.livello })
      };

      // Pool per Cassaforte/Quota2/Sorpresa: TUTTI i mercati di mk (non solo
      // valore/solido), con la quota fair del modello. Il resto (mercato,
      // fair odds, calibrata) resta baseline: nessun impatto sul Pure Model.
      for (const [chiaveMercato, probMercatoModello] of Object.entries(mk)) {
        if (!(probMercatoModello > 0)) continue;
        poolSelezione.push({
          match: idMatch, evento: `${casa} - ${ospite}`, comp: lega.nome, quando, inizio: inizio.toISOString(),
          mercato: chiaveMercato, prob: probMercatoModello, quota_fair: +(1 / probMercatoModello).toFixed(3),
          prezzo_bookmaker: ['1', 'X', '2'].includes(chiaveMercato) ? (prezzoDi(chiaveMercato) ?? null) : null,
          analisi
        });
      }
    }

    // "inizio" e' in ISO e serve a chiudi.mjs: "quando" e' testo localizzato,
    // "ore" e' relativo al momento della build e non e' piu' leggibile dopo.
    const base = { sport: 'calcio', comp: lega.nome, evento: `${casa} - ${ospite}`, quando, ore,
      match: idMatch, inizio: inizio.toISOString(), understat: lega.understat, analisi };

    const spiega = (m, p) =>
      `Gol attesi ${lh.toFixed(2)} contro ${la.toFixed(2)}, stimati dagli xG delle ultime partite `
      + `con emivita di sei mesi, senza guardare le quote. Il modello da questo mercato al ${(p * 100).toFixed(1)}%.`
      + (migliore
          ? ` Sul segno ${migliore.esito} il modello dice ${(migliore.probModello * 100).toFixed(1)}% contro il `
            + `${(migliore.probMercato * 100).toFixed(1)}% del consenso di ${migliore.nBook} bookmaker, `
            + `miglior prezzo ${migliore.prezzo.toFixed(2)} su ${migliore.book}.`
          : '');

    if (valore) out.push({ ...base, mercato: valore[0], prob: +valore[1].toFixed(3),
      prezzo: prezzoDi(valore[0]),
      why: spiega(valore[0], valore[1]), src: 'modello xG Dixon-Coles + confronto bookmaker',
      confronto: migliore || null });
    if (solido) out.push({ ...base, mercato: solido[0], prob: +solido[1].toFixed(3),
      prezzo: prezzoDi(solido[0]),
      why: `Versione prudente sulla stessa partita. ${spiega(solido[0], solido[1])}`,
      src: 'modello xG Dixon-Coles' });

    // sorpresa: esito che il modello valuta molto piu' del mercato
    if (migliore && migliore.valore > 0.12 && migliore.probModello <= 0.42) {
      out.push({ ...base, tipo: 'sorpresa',
        mercato: migliore.esito === '1' ? `${casa} vincente`
               : migliore.esito === '2' ? `${ospite} vincente` : 'Pareggio',
        prob: migliore.probModello,
        // qui il mercato E' proprio l'esito 1X2 di "migliore": la quota e' quella giusta
        prezzo: migliore.prezzo,
        why: `Il modello da questo esito al ${(migliore.probModello * 100).toFixed(1)}%, il consenso di `
           + `${migliore.nBook} bookmaker al ${(migliore.probMercato * 100).toFixed(1)}%. `
           + `Al prezzo migliore, ${migliore.prezzo.toFixed(2)} su ${migliore.book}, il valore atteso e' `
           + `${(migliore.valore * 100).toFixed(1)}%. Nasce dallo scarto fra modello e lavagna, non da una sensazione.`,
        src: 'modello xG Dixon-Coles + confronto bookmaker', confronto: migliore });
    }
  }
}

// --- sport senza modello: basket a chiavi fisse, tennis scoperto ogni volta
for (const comp of [...BASKET, ...await chiaviTennis()]) await daConsenso(comp);

// Tracciabilita' (FASE 1): ogni pronostico porta la versione del modello che
// l'ha davvero calcolato, e finisce in uno snapshot che nessuna esecuzione
// successiva potra' piu' modificare. generatoAlle e' unico per questo giro:
// e' cosi' che si distinguono, nello snapshot, previsioni fatte in momenti
// diversi sulla stessa identica partita.
const generatoAlle = new Date().toISOString();
for (const p of out) p.model_version = PRODUZIONE_VERSION;
const esitoSnapshot = salvaSnapshot('data/snapshots.json',
  out.map(p => ({ ...p, generated_at: generatoAlle })));
console.log(`Snapshot: ${esitoSnapshot.aggiunti} nuovi, ${esitoSnapshot.ignorati} gia' presenti `
  + `(immutabili), ${esitoSnapshot.totale} in archivio.`);

// --- Best Picks Today (punto 8) vs High Risk / Model Disagreement (punto 5)
// Una riga per PARTITA. "Migliori opportunita" richiede TUTTE le condizioni
// congiunte di best_pick_idoneo (confidence, data quality, agreement!=LOW,
// market gap, quota, EV minimo: punto 4) — non basta EV positivo. Il ranking
// (opportunity_score) e' gia' calcolato con EV saturato e pesi che premiano
// qualita'/accordo, non l'EV puro (punto 7). Le selezioni con EV positivo ma
// che NON passano i criteri robusti (quota alta o forte disaccordo) finiscono
// nella sezione separata "speculative", mai mischiate alle principali.
const perPartitaAnalisi = new Map();
for (const p of out) {
  if (p.sport === 'calcio' && p.analisi && !perPartitaAnalisi.has(p.match)) perPartitaAnalisi.set(p.match, p);
}
const tutteConAnalisi = [...perPartitaAnalisi.values()];

const mappaPick = (p) => ({
  evento: p.evento, comp: p.comp, quando: p.quando, match: p.match,
  esito_riferimento: p.analisi.market.esito_riferimento,
  pure_model: p.analisi.pure_model, calibrated: p.analisi.calibrated,
  market: p.analisi.market, value: p.analisi.value, quality: p.analisi.quality,
  market_gap: p.analisi.market_gap, rischio_quota: p.analisi.rischio_quota,
  value_class: p.analisi.value_class, opportunity_score: p.analisi.opportunity_score, why: p.analisi.why
});

const bestPicksToday = tutteConAnalisi
  .filter(p => p.analisi.best_pick_idoneo)
  .sort((a, b) => b.analisi.opportunity_score - a.analisi.opportunity_score)
  .slice(0, 10)
  .map(mappaPick);

// speculative: EV positivo ma escluso dai Best Picks (quota alta e/o forte
// disaccordo modello/mercato e/o qualita' insufficiente) — resta visibile,
// mai promosso come "migliore opportunita'".
const speculativePicksToday = tutteConAnalisi
  .filter(p => !p.analisi.best_pick_idoneo && p.analisi.value.ev > 0)
  .sort((a, b) => b.analisi.opportunity_score - a.analisi.opportunity_score)
  .slice(0, 10)
  .map(p => ({ ...mappaPick(p), motivi_esclusione: p.analisi.best_pick_motivi_esclusione }));

// --- CASSAFORTE / QUOTA 2 / SORPRESA: riallineate all'uso reale dichiarato
// (singole da ~1.50, multiple intorno a 2, sorpresa occasionale). Usano
// SEMPRE le metriche del value engine: mai una selezione High Risk in
// Cassaforte/Quota2, mai una quota sopra soglia come Sorpresa principale.
// Rigenerate ad ogni esecuzione di questa pipeline, dalle quote di oggi.
const risCassaforte = costruisciCassaforte(poolSelezione);
const risQuota2 = costruisciQuota2(poolSelezione);
const risSorpresa = costruisciSorpresa(tutteConAnalisi);

function formattaSingola(c) {
  if (!c) return null;
  const a = c.analisi;
  return {
    evento: c.evento, comp: c.comp, quando: c.quando, mercato: c.mercato,
    quota: c.quota_fair, probabilita_modello: +c.prob.toFixed(4),
    probabilita_calibrata: (['1', 'X', '2'].includes(c.mercato) && a.calibrated.attivo)
      ? +a.calibrated[c.mercato === '1' ? 'P1' : c.mercato === 'X' ? 'PX' : 'P2'].toFixed(4) : null,
    confidence: a.quality.confidence, data_quality: a.quality.data_quality,
    market_probability: ['1', 'X', '2'].includes(c.mercato) ? a.market.no_vig_probability : null,
    fair_odds: c.quota_fair, agreement: a.quality.agreement,
    market_gap: a.market_gap.livello,
    why: `${c.evento}, mercato "${c.mercato}": il modello lo stima al ${(c.prob * 100).toFixed(1)}% (quota fair ${c.quota_fair.toFixed(2)}), `
      + `confidence ${a.quality.confidence}/100, data quality ${a.quality.data_quality}/100, accordo col mercato ${a.quality.agreement}.`
  };
}

const cassaforte = risCassaforte.selezione ? formattaSingola(risCassaforte.selezione) : null;
const quota2 = risQuota2.selezioni ? {
  selezioni: risQuota2.selezioni.map(formattaSingola),
  quota_totale: +risQuota2.quotaTotale.toFixed(3),
  probabilita_combinata_stimata: +risQuota2.probCongiunta.toFixed(4)
} : null;
const sorpresa = risSorpresa.selezione ? (() => {
  const m = risSorpresa.selezione, a = m.analisi;
  return {
    evento: m.evento, comp: m.comp, quando: m.quando, mercato: a.market.esito_riferimento,
    quota_bookmaker: a.market.bookmaker_odds, probabilita_modello: a.pure_model[a.market.esito_riferimento === '1' ? 'P1' : a.market.esito_riferimento === 'X' ? 'PX' : 'P2'],
    probabilita_mercato: a.market.no_vig_probability, ev: a.value.ev, edge: a.value.edge,
    confidence: a.quality.confidence, data_quality: a.quality.data_quality, agreement: a.quality.agreement,
    market_gap: a.market_gap.livello, why: a.why
  };
})() : null;

console.log('CASSAFORTE:', cassaforte ? `${cassaforte.evento} — ${cassaforte.mercato} @ ${cassaforte.quota}` : `nessuna (${risCassaforte.motivo})`);
console.log('QUOTA 2:', quota2 ? `${quota2.selezioni.map(s => s.evento + ' ' + s.mercato).join(' + ')} — quota ${quota2.quota_totale}` : `nessuna (${risQuota2.motivo})`);
console.log('SORPRESA:', sorpresa ? `${sorpresa.evento} — ${sorpresa.mercato} @ ${sorpresa.quota_bookmaker}` : `nessuna (${risSorpresa.motivo})`);

writeFileSync('data/picks.json', JSON.stringify({
  aggiornato: generatoAlle,
  model_version: PRODUZIONE_VERSION,
  drawcal_status: calibratoreDrawCal.attivo
    ? { attivo: true, n_campione: calibratoreDrawCal.nCampione, versione: DRAWCAL.versione }
    : { attivo: false, motivo: calibratoreDrawCal.motivo },
  metodo: 'calcio: forze di attacco e difesa stimate dagli xG con emivita 180 giorni, Dixon-Coles per i punteggi bassi, confronto col consenso di piu bookmaker. '
    + 'Basket e tennis: nessun modello indipendente disponibile, il pronostico e il solo consenso dei bookmaker ripulito dal margine. '
    + "Layer aggiuntivo sperimentale DC-DRAW-CAL sul solo P_DRAW (calibrazione isotonic), sempre mostrato accanto al modello puro, mai al suo posto. "
    + 'Migliori opportunita: richiedono congiuntamente confidence, data quality, agreement, market gap, quota ed EV minimo sopra soglia (mai il solo EV positivo). '
    + 'Selezioni con EV positivo ma quota molto alta o forte disaccordo modello/mercato finiscono in high_risk_today, mai fra le migliori opportunita.',
  cassaforte, cassaforte_nota: cassaforte ? null : risCassaforte.motivo,
  quota_2: quota2, quota_2_nota: quota2 ? null : risQuota2.motivo,
  sorpresa, sorpresa_nota: sorpresa ? null : risSorpresa.motivo,
  best_picks_today: bestPicksToday,
  best_picks_nota: bestPicksToday.length ? null : 'Nessuna opportunita con sufficiente accordo modello/mercato.',
  high_risk_today: speculativePicksToday,
  diagnostica,
  eventi: out
}, null, 1));

// --- archivio delle quote: una riga per giro, per misurare i movimenti.
// Tiene solo l'ultima rilevazione per evento in ogni giro, e scarta gli eventi
// gia' iniziati: quello che serve e' come si e' mossa la lavagna prima del via.
{
  const vecchio = existsSync(QUOTE) ? JSON.parse(readFileSync(QUOTE, 'utf8')) : { rilevazioni: [] };
  const storia = Array.isArray(vecchio.rilevazioni) ? vecchio.rilevazioni : [];
  const adesso = new Date().toISOString();
  const gia = new Set(storia.map(r => `${r.match}|${r.inizio}|${r.quando}`));
  for (const r of rilevazioni) {
    const riga = { ...r, quando: adesso };
    if (!gia.has(`${riga.match}|${riga.inizio}|${riga.quando}`)) storia.push(riga);
  }
  // via le rilevazioni di eventi finiti da piu' di 30 giorni, o il file cresce senza fine
  const taglio = Date.now() - 30 * 864e5;
  const tenute = storia.filter(r => Date.parse(r.inizio) > taglio);
  writeFileSync(QUOTE, JSON.stringify({
    aggiornato: adesso,
    nota: 'Una rilevazione per evento a ogni esecuzione: prob e la probabilita del consenso ripulita dal margine, prezzo il miglior prezzo trovato. Serve a misurare come si muove la lavagna prima del via.',
    rilevazioni: tenute
  }, null, 1));
  console.log(`Quote archiviate: ${rilevazioni.length} rilevazioni in questo giro, ${tenute.length} in archivio.`);
}

const perSport = {};
for (const p of out) perSport[p.sport] = (perSport[p.sport] || 0) + 1;
console.log(`Scritti ${out.length} pronostici (`
  + Object.entries(perSport).map(([s, n]) => `${s} ${n}`).join(', ') + ').');
if (diagnostica.length) console.log('Note:\n- ' + diagnostica.join('\n- '));
