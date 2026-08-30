// scripts/sport-disponibili.mjs
// Diagnostica: quali sport hanno eventi imminenti, e quanto costa scoprirlo.
// Serve a fondare su dati veri la scoperta dinamica dei tornei di tennis:
// se l'endpoint /events fosse a pagamento, filtrare i tornei costerebbe piu'
// di quanto si risparmia. Qui il costo lo misuro, non lo do per scontato.

const KEY = process.env.ODDS_API_KEY;
if (!KEY) { console.error('Manca ODDS_API_KEY'); process.exit(1); }

const GIORNI = 3;
const iso = (d) => d.toISOString().slice(0, 19) + 'Z';
const da = iso(new Date());
const a = iso(new Date(Date.now() + GIORNI * 864e5));

let usateUltimo = null;
async function chiama(url, etichetta) {
  const r = await fetch(url);
  const usate = Number(r.headers.get('x-requests-used'));
  const residue = Number(r.headers.get('x-requests-remaining'));
  const costo = usateUltimo === null ? null : usate - usateUltimo;
  usateUltimo = usate;
  const corpo = r.ok ? await r.json() : await r.text();
  console.log(`${etichetta.padEnd(42)} HTTP ${r.status}  usate ${usate}  residue ${residue}`
    + (costo === null ? '' : `  costo ${costo}`));
  return { ok: r.ok, corpo };
}

// 1) elenco sport
const sport = await chiama(`https://api.the-odds-api.com/v4/sports/?apiKey=${KEY}`, '/v4/sports');
if (!sport.ok) { console.error(sport.corpo); process.exit(1); }

const tennis = sport.corpo.filter(s =>
  s.key.startsWith('tennis_') && !s.key.endsWith('_championship_winner') && !s.has_outrights);
const basket = ['basketball_wnba', 'basketball_nba'];

console.log(`\nchiavi tennis candidate: ${tennis.length ? tennis.map(s => s.key).join(', ') : 'nessuna'}`);
console.log(`finestra: ${da} -> ${a}\n`);

// 2) per ogni chiave, quanti eventi nella finestra, e a che costo
console.log('--- /events per chiave (il costo e la colonna finale) ---');
const conteggi = [];
for (const k of [...tennis.map(s => s.key), ...basket]) {
  const r = await chiama(
    `https://api.the-odds-api.com/v4/sports/${k}/events?apiKey=${KEY}`
    + `&commenceTimeFrom=${da}&commenceTimeTo=${a}`, k);
  const n = r.ok && Array.isArray(r.corpo) ? r.corpo.length : -1;
  conteggi.push({ chiave: k, eventi: n });
}

console.log('\n--- riepilogo eventi nei prossimi ' + GIORNI + ' giorni ---');
for (const c of conteggi.sort((x, y) => y.eventi - x.eventi))
  console.log(`   ${c.chiave.padEnd(30)} ${c.eventi < 0 ? 'errore' : c.eventi + ' eventi'}`);

const conEventi = conteggi.filter(c => c.eventi > 0);
console.log(`\nchiavi con almeno un evento: ${conEventi.length}`);
console.log('tennis con eventi: ' + (conEventi.filter(c => c.chiave.startsWith('tennis_'))
  .map(c => `${c.chiave} (${c.eventi})`).join(', ') || 'nessuno'));
