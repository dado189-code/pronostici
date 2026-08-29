// scripts/sport-disponibili.mjs
// Diagnostica: elenca gli sport attivi su the-odds-api con la chiave configurata,
// e riporta il credito residuo. L'endpoint /v4/sports non consuma richieste.
// Serve a decidere cosa si puo' davvero aggiungere alla pipeline, senza tirare
// a indovinare le chiavi.

const KEY = process.env.ODDS_API_KEY;
if (!KEY) { console.error('Manca ODDS_API_KEY'); process.exit(1); }

const r = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${KEY}`);
if (!r.ok) { console.error(`HTTP ${r.status}: ${await r.text()}`); process.exit(1); }

// l'API riporta il consumo negli header, e' il dato piu' affidabile sul budget
console.log('credito: usate ' + (r.headers.get('x-requests-used') ?? '?')
  + ', residue ' + (r.headers.get('x-requests-remaining') ?? '?'));

const sport = await r.json();
const attivi = sport.filter(s => s.active);
console.log(`sport totali ${sport.length}, attivi ${attivi.length}\n`);

const perGruppo = {};
for (const s of attivi) (perGruppo[s.group] ||= []).push(s);

for (const g of Object.keys(perGruppo).sort()) {
  console.log(`== ${g}`);
  for (const s of perGruppo[g].sort((a, b) => a.key.localeCompare(b.key)))
    console.log(`   ${s.key.padEnd(38)} ${s.title}${s.has_outrights ? '  [solo antepost]' : ''}`);
  console.log('');
}

// quello che ci interessa per la domanda in ballo
const cerca = (re) => attivi.filter(s => re.test(s.group) || re.test(s.key)).map(s => s.key);
console.log('--- rilevanti ---');
console.log('tennis     : ' + (cerca(/tennis/i).join(', ') || 'nessuno attivo'));
console.log('basket     : ' + (cerca(/basketball/i).join(', ') || 'nessuno attivo'));
