// scripts/build.mjs
// Pipeline: stima le forze delle squadre dagli xG (modello indipendente),
// scarica le quote di piu' bookmaker, confronta le due cose e scrive
// data/picks.json. Il valore nasce dallo scarto fra modello e lavagna.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { scaricaUnderstat, stimaForze, stimaRho, lambde, mercati, consenso }
  from './model.mjs';

const KEY = process.env.ODDS_API_KEY;
if (!KEY) { console.error('Manca ODDS_API_KEY'); process.exit(1); }

const STAGIONE = process.env.STAGIONE || String(new Date().getFullYear() - (new Date().getMonth() < 6 ? 1 : 0));
const GIORNI = 5;
// Finestra usata per decidere se una chiave vale la richiesta a pagamento.
const GIORNI_SCOPERTA = 3;
// Tetto sui tabelloni di tennis per esecuzione: durante gli Slam le chiavi
// aperte possono essere parecchie e ognuna costa un credito.
const MAX_TENNIS = 2;

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
        { timeZone: 'Europe/Rome', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
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
  let storico;
  try {
    storico = await scaricaUnderstat(lega.understat, STAGIONE);
    // se la stagione e' appena iniziata, aggiungi la precedente
    if (storico.length < 60) {
      const prec = await scaricaUnderstat(lega.understat, String(Number(STAGIONE) - 1));
      storico = [...prec, ...storico];
    }
  } catch (e) {
    diagnostica.push(`${lega.nome}: storico xG non disponibile (${e.message})`);
    continue;
  }
  if (storico.length < 40) {
    diagnostica.push(`${lega.nome}: solo ${storico.length} partite con xG, troppo poche per stimare`);
    continue;
  }

  const forze = stimaForze(storico, { emivita: 180 });
  const rho = stimaRho(storico.slice(-300), forze);
  const indice = Object.fromEntries(forze.squadre.map(s => [chiave(s), s]));

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
    const valore = scegli(mk, 0.55, 0.80);
    const solido = scegli(mk, 0.80, 0.93);
    // il runner di GitHub e' in UTC: senza timeZone la pagina mostrerebbe
    // gli orari due ore indietro rispetto all'Italia
    const quando = inizio.toLocaleString('it-IT',
      { timeZone: 'Europe/Rome', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const idMatch = chiave(casa) + '-' + chiave(ospite);
    if (cons) rilevazioni.push({ match: idMatch, comp: lega.nome, inizio: inizio.toISOString(),
      quote: Object.entries(cons).map(([nome, d]) => ({
        esito: (nome === ev.home_team ? '1' : nome === ev.away_team ? '2' : nome === 'Draw' ? 'X' : nome),
        prob: +d.prob.toFixed(4), prezzo: d.prezzo, nBook: d.nBook })) });
    // "inizio" e' in ISO e serve a chiudi.mjs: "quando" e' testo localizzato,
    // "ore" e' relativo al momento della build e non e' piu' leggibile dopo.
    const base = { sport: 'calcio', comp: lega.nome, evento: `${casa} - ${ospite}`, quando, ore,
      match: idMatch, inizio: inizio.toISOString(), understat: lega.understat };

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

writeFileSync('data/picks.json', JSON.stringify({
  aggiornato: new Date().toISOString(),
  metodo: 'calcio: forze di attacco e difesa stimate dagli xG con emivita 180 giorni, Dixon-Coles per i punteggi bassi, confronto col consenso di piu bookmaker. '
    + 'Basket e tennis: nessun modello indipendente disponibile, il pronostico e il solo consenso dei bookmaker ripulito dal margine.',
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
