// scripts/build.mjs
// Pipeline: stima le forze delle squadre dagli xG (modello indipendente),
// scarica le quote di piu' bookmaker, confronta le due cose e scrive
// data/picks.json. Il valore nasce dallo scarto fra modello e lavagna.

import { writeFileSync } from 'node:fs';
import { scaricaUnderstat, stimaForze, stimaRho, lambde, mercati, consenso }
  from './model.mjs';

const KEY = process.env.ODDS_API_KEY;
if (!KEY) { console.error('Manca ODDS_API_KEY'); process.exit(1); }

const STAGIONE = process.env.STAGIONE || String(new Date().getFullYear() - (new Date().getMonth() < 6 ? 1 : 0));
const GIORNI = 5;

const LEGHE = [
  { understat: 'Serie_A',    odds: 'soccer_italy_serie_a',    nome: 'Serie A' },
  { understat: 'EPL',        odds: 'soccer_epl',              nome: 'Premier League' },
  { understat: 'La_liga',    odds: 'soccer_spain_la_liga',    nome: 'Liga' },
  { understat: 'Ligue_1',    odds: 'soccer_france_ligue_one', nome: 'Ligue 1' },
  { understat: 'Bundesliga', odds: 'soccer_germany_bundesliga', nome: 'Bundesliga' }
];

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
    const valore = scegli(mk, 0.55, 0.80);
    const solido = scegli(mk, 0.80, 0.93);
    const quando = inizio.toLocaleString('it-IT',
      { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const idMatch = chiave(casa) + '-' + chiave(ospite);
    const base = { sport: 'calcio', comp: lega.nome, evento: `${casa} - ${ospite}`, quando, ore, match: idMatch };

    const spiega = (m, p) =>
      `Gol attesi ${lh.toFixed(2)} contro ${la.toFixed(2)}, stimati dagli xG delle ultime partite `
      + `con emivita di sei mesi, senza guardare le quote. Il modello da questo mercato al ${(p * 100).toFixed(1)}%.`
      + (migliore
          ? ` Sul segno ${migliore.esito} il modello dice ${(migliore.probModello * 100).toFixed(1)}% contro il `
            + `${(migliore.probMercato * 100).toFixed(1)}% del consenso di ${migliore.nBook} bookmaker, `
            + `miglior prezzo ${migliore.prezzo.toFixed(2)} su ${migliore.book}.`
          : '');

    if (valore) out.push({ ...base, mercato: valore[0], prob: +valore[1].toFixed(3),
      why: spiega(valore[0], valore[1]), src: 'modello xG Dixon-Coles + confronto bookmaker',
      confronto: migliore || null });
    if (solido) out.push({ ...base, mercato: solido[0], prob: +solido[1].toFixed(3),
      why: `Versione prudente sulla stessa partita. ${spiega(solido[0], solido[1])}`,
      src: 'modello xG Dixon-Coles' });

    // sorpresa: esito che il modello valuta molto piu' del mercato
    if (migliore && migliore.valore > 0.12 && migliore.probModello <= 0.42) {
      out.push({ ...base, tipo: 'sorpresa',
        mercato: migliore.esito === '1' ? `${casa} vincente`
               : migliore.esito === '2' ? `${ospite} vincente` : 'Pareggio',
        prob: migliore.probModello,
        why: `Il modello da questo esito al ${(migliore.probModello * 100).toFixed(1)}%, il consenso di `
           + `${migliore.nBook} bookmaker al ${(migliore.probMercato * 100).toFixed(1)}%. `
           + `Al prezzo migliore, ${migliore.prezzo.toFixed(2)} su ${migliore.book}, il valore atteso e' `
           + `${(migliore.valore * 100).toFixed(1)}%. Nasce dallo scarto fra modello e lavagna, non da una sensazione.`,
        src: 'modello xG Dixon-Coles + confronto bookmaker', confronto: migliore });
    }
  }
}

writeFileSync('data/picks.json', JSON.stringify({
  aggiornato: new Date().toISOString(),
  metodo: 'forze di attacco e difesa stimate dagli xG con emivita 180 giorni, Dixon-Coles per i punteggi bassi, confronto col consenso di piu bookmaker',
  diagnostica,
  eventi: out
}, null, 1));

console.log(`Scritti ${out.length} pronostici.`);
if (diagnostica.length) console.log('Note:\n- ' + diagnostica.join('\n- '));
