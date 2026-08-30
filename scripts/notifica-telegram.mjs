// scripts/notifica-telegram.mjs
// Notifica di fine aggiornamento giornaliero via Telegram Bot API. Sostituisce
// il tentativo iniziale con WhatsApp Cloud API: quello richiedeva la verifica
// business di Meta (giorni, documenti) solo per poter creare un template
// personalizzato, dato che il numero di test non lo permette. Telegram manda
// testo libero senza restrizioni, nessuna approvazione, nessuna verifica.
//
// Credenziali SOLO da variabili d'ambiente/GitHub Secrets, mai scritte qui.
// Se mancano, esce pulito senza inviare nulla e senza far fallire il workflow
// (la notifica e' un extra, non il cuore dell'aggiornamento).
//
// Uso: node scripts/notifica-telegram.mjs successo|fallimento

import { readFileSync, existsSync } from 'node:fs';

const modo = process.argv[2];
if (!['successo', 'fallimento'].includes(modo)) {
  console.error("Uso: node scripts/notifica-telegram.mjs successo|fallimento");
  process.exit(1);
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const URL_PUBBLICA = process.env.PUBLIC_URL || 'https://dado189-code.github.io/pronostici/';

if (!TOKEN || !CHAT_ID) {
  console.log('Telegram non configurato (mancano TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID come secret): nessuna notifica inviata. '
    + "Questo non e' un errore: l'aggiornamento dei dati prosegue comunque.");
  process.exit(0);
}

function formattaDataItaliana(iso) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

function etichettaSegno(sorpresa) {
  const [casa, ospite] = sorpresa.evento.split(' - ');
  if (sorpresa.mercato === '1') return `${casa || ''} 1`.trim();
  if (sorpresa.mercato === '2') return `${ospite || ''} 2`.trim();
  return 'X';
}

function componiMessaggioSuccesso() {
  if (!existsSync('data/picks.json')) return `Pronostici aggiornati.\n${URL_PUBBLICA}`;
  const d = JSON.parse(readFileSync('data/picks.json', 'utf8'));
  const data = formattaDataItaliana(d.aggiornato);
  const righe = [`Pronostici aggiornati — ${data}`];

  righe.push(d.cassaforte
    ? `Cassaforte: ${d.cassaforte.evento} | ${d.cassaforte.mercato} @${d.cassaforte.quota.toFixed(2)}`
    : `Cassaforte: ${d.cassaforte_nota || 'nessuna selezione valida'}`);

  righe.push(d.quota_2
    ? `Quota 2: ${d.quota_2.selezioni.map(s => s.evento).join(' + ')} @${d.quota_2.quota_totale.toFixed(2)}`
    : `Quota 2: ${d.quota_2_nota || 'nessuna selezione valida'}`);

  righe.push(d.sorpresa ? `Sorpresa: ${d.sorpresa.evento} | ${etichettaSegno(d.sorpresa)} @${d.sorpresa.quota_bookmaker.toFixed(2)}`
    : `Sorpresa: ${d.sorpresa_nota || 'nessuna selezione valida'}`);

  righe.push(`Best Picks: ${(d.best_picks_today || []).length}`);
  righe.push(URL_PUBBLICA);
  return righe.join('\n');
}

const testo = modo === 'successo'
  ? componiMessaggioSuccesso()
  : 'Aggiornamento pronostici non riuscito — controllare workflow GitHub.';

console.log(`Invio notifica Telegram (${modo})...`); // mai stampare testo/token: il token e' nell'URL della chiamata

try {
  // Il token e' nel PATH dell'URL (formato Telegram), non in un header: va
  // costruito qui e mai loggato, nemmeno in caso di errore HTTP.
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: testo, disable_web_page_preview: false })
  });
  const risposta = await res.json().catch(() => null);
  if (!res.ok || !risposta?.ok) {
    // la risposta di errore di Telegram non contiene mai il token (e' solo
    // nell'URL della richiesta, non nel body): sicuro stamparla
    console.error(`Invio Telegram fallito: HTTP ${res.status}`, JSON.stringify(risposta));
  } else {
    console.log('Notifica Telegram inviata.', risposta.result?.message_id ? `message_id=${risposta.result.message_id}` : '');
  }
} catch (e) {
  console.error(`Invio Telegram fallito (rete): ${e.message}`);
}
// process.exitCode, non process.exit: un fallimento di invio non deve far
// fallire il workflow (i dati sono gia' pubblicati), e non forza la
// terminazione immediata del processo con socket ancora in chiusura.
process.exitCode = 0;
