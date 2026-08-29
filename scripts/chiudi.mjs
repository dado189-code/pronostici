// scripts/chiudi.mjs
// Chiude i pronostici gia' giocati: prende quelli dell'esecuzione precedente,
// cerca il risultato reale su Understat, li liquida e li scrive in
// data/storico.json, da cui index.html ricava la sezione Rendimento.
//
// Gira PRIMA di build.mjs, che sovrascrive data/picks.json: e' l'unico momento
// in cui i pronostici del giro precedente sono ancora leggibili.
//
// Tre regole che tengono in piedi il conto:
//  - la liquidazione usa vinta() di backtest.mjs, non una copia. Regola sola.
//  - ogni pronostico ha un id stabile: se e' gia' in "chiusi" non si tocca piu'.
//  - se il risultato non si trova, il pronostico resta in "pendenti" e ci si
//    riprova al giro dopo. Non si butta via niente.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { scaricaUnderstat } from './model.mjs';
import { vinta } from './backtest.mjs';

const PICKS = 'data/picks.json';
const STORICO = 'data/storico.json';

// Understat pubblica il risultato poco dopo il fischio finale, ma non subito.
// Prima di cercarlo aspetto che la partita sia comunque finita.
const DURATA_ORE = 2.5;
// Oltre questa soglia un pendente non e' piu' un ritardo: e' un problema.
// Resta in coda, ma lo segnalo invece di lasciarlo sparire nel silenzio.
const GIORNI_ALLARME = 7;

const leggi = (f, vuoto) => {
  if (!existsSync(f)) return vuoto;
  try { return JSON.parse(readFileSync(f, 'utf8')); }
  catch (e) { console.warn(`${f} illeggibile (${e.message}), riparto da vuoto`); return vuoto; }
};

// ---------- identita' di un pronostico
//
// Deve essere stabile fra un'esecuzione e l'altra, e distinguere i due
// pronostici sulla stessa partita (quello di valore e quello prudente)
// e la sorpresa. Da qui nasce la garanzia di non contare due volte.
const idDi = (p) => [p.match, p.inizio || p.quando, p.tipo || 'standard', p.mercato].join('|');

// ---------- il mercato su cui liquidare
//
// Le sorprese hanno un'etichetta discorsiva ("Como vincente", "Pareggio") che
// vinta() non conosce, ma dentro "confronto" c'e' il segno 1X2 da cui nascono.
// Per tutti gli altri il mercato e' gia' una chiave di mercati(), che vinta()
// copre una per una.
function mercatoLiquidabile(p) {
  if (p.tipo === 'sorpresa') return p.confronto && p.confronto.esito || null;
  return p.mercato;
}

// ---------- risultati reali

const LEGHE = {
  'Serie A': 'Serie_A', 'Premier League': 'EPL', 'Liga': 'La_liga',
  'Ligue 1': 'Ligue_1', 'Bundesliga': 'Bundesliga'
};

// Scarica una stagione per lega, una volta sola, e la indicizza per
// "Casa - Ospite": sono gli stessi nomi Understat che build.mjs ha gia' risolto
// quando ha scritto il pronostico, quindi il confronto e' esatto, non fuzzy.
async function indiceRisultati(compA, stagione) {
  const out = {};
  for (const comp of compA) {
    const lega = LEGHE[comp];
    if (!lega) { console.warn(`${comp}: lega sconosciuta, non posso cercarne i risultati`); continue; }
    let partite = [];
    for (const st of [stagione, String(Number(stagione) - 1)]) {
      try { partite.push(...await scaricaUnderstat(lega, st)); }
      catch (e) { console.warn(`${comp} ${st}: ${e.message}`); }
    }
    const idx = {};
    for (const p of partite) {
      if (!Number.isFinite(p.golCasa) || !Number.isFinite(p.golOspite)) continue;
      idx[`${p.casa} - ${p.ospite}`] = p;
    }
    out[comp] = idx;
  }
  return out;
}

// ---------- esecuzione

const storico = leggi(STORICO, { chiusi: [], pendenti: [] });
storico.chiusi = Array.isArray(storico.chiusi) ? storico.chiusi : [];
storico.pendenti = Array.isArray(storico.pendenti) ? storico.pendenti : [];

const picks = leggi(PICKS, { eventi: [] });
const eventi = Array.isArray(picks.eventi) ? picks.eventi : [];

const gia = new Set(storico.chiusi.map(x => x.id));
const adesso = Date.now();

// candidati = i pendenti di prima piu' i pronostici del giro precedente,
// dedotti per id e senza quelli gia' chiusi
const candidati = [];
const visti = new Set();
let senzaData = 0;
for (const p of [...storico.pendenti, ...eventi]) {
  // Senza "inizio" non so nemmeno se la partita e' stata giocata, e non e' una
  // mancanza recuperabile: i pronostici scritti da build.mjs ce l'hanno sempre.
  // Sono residui del formato vecchio, che ricompariranno datati al giro dopo:
  // tenerli in coda significherebbe solo duplicarli.
  if (!Number.isFinite(Date.parse(p.inizio || ''))) { senzaData++; continue; }
  const id = idDi(p);
  if (gia.has(id) || visti.has(id)) continue;
  visti.add(id);
  candidati.push({ ...p, id });
}

// solo quelli il cui orario di fine e' passato
const finiti = candidati.filter(p => adesso > Date.parse(p.inizio) + DURATA_ORE * 3600e3);

const diagnostica = [];
if (senzaData) diagnostica.push(`${senzaData} pronostici senza data di inizio ignorati (formato precedente)`);
const stagione = String(new Date().getFullYear() - (new Date().getMonth() < 6 ? 1 : 0));
const comps = [...new Set(finiti.map(p => p.comp))];
const risultati = comps.length ? await indiceRisultati(comps, stagione) : {};

const chiusiOra = [];
const restanoPendenti = [];

for (const p of candidati) {
  if (!finiti.includes(p)) { restanoPendenti.push(p); continue; }

  const partita = (risultati[p.comp] || {})[p.evento];
  if (!partita) { restanoPendenti.push(p); continue; }   // risultato non ancora pubblicato

  const mercato = mercatoLiquidabile(p);
  const esito = mercato == null ? null : vinta(mercato, partita.golCasa, partita.golOspite);
  if (esito === null) {
    // mercato che vinta() non sa liquidare: non e' un ritardo, va visto
    diagnostica.push(`${p.evento}: mercato "${p.mercato}" non liquidabile, resta pendente`);
    restanoPendenti.push(p);
    continue;
  }

  // "quota" e' la quota minima (1/prob), la stessa convenzione dello STORICO
  // incorporato e della nota in fondo alla sezione Rendimento: il saldo e' un
  // limite superiore, non un guadagno reale. Il prezzo di lavagna, quando
  // esiste davvero, lo tengo a parte senza mescolarlo al conto.
  chiusiOra.push({
    id: p.id,
    cat: p.tipo === 'sorpresa' ? 'sorpresa' : 'standard',
    data: new Date(p.inizio).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }),
    evento: p.evento,
    mercato: p.mercato,
    quota: p.prob > 0 ? +(1 / p.prob).toFixed(2) : null,
    prezzo: p.prezzo ?? null,
    risultato: `${partita.golCasa}-${partita.golOspite}`,
    esito: esito ? 'ok' : 'ko'
  });
}

// i pendenti troppo vecchi restano in coda ma li segnalo
for (const p of restanoPendenti) {
  const t = Date.parse(p.inizio || '');
  if (Number.isFinite(t) && adesso - t > GIORNI_ALLARME * 864e5)
    diagnostica.push(`${p.evento} (${p.mercato}): senza risultato da oltre ${GIORNI_ALLARME} giorni`);
}

storico.chiusi.push(...chiusiOra);
storico.chiusi.sort((a, b) => (a.id > b.id ? 1 : -1));
storico.pendenti = restanoPendenti;
storico.aggiornato = new Date().toISOString();
storico.diagnostica = diagnostica;
storico.nota = 'La quota e la quota minima 1/probabilita, non il prezzo di un bookmaker: '
  + 'il saldo va letto come limite superiore. La categoria cassaforte nasce dalla combinazione '
  + 'costruita nella pagina e non e ricavabile da qui, quindi non viene aggiornata in automatico.';

writeFileSync(STORICO, JSON.stringify(storico, null, 1));

console.log(`Chiusi ${chiusiOra.length} pronostici, ${storico.pendenti.length} ancora pendenti, `
  + `${storico.chiusi.length} in archivio.`);
for (const c of chiusiOra)
  console.log(`  ${c.esito === 'ok' ? 'OK' : 'KO'}  ${c.data} ${c.evento} — ${c.mercato} — ${c.risultato}`);
if (diagnostica.length) console.log('Note:\n- ' + diagnostica.join('\n- '));
