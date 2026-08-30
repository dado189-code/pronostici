// scripts/notifica-whatsapp.mjs
// Notifica WhatsApp (Meta WhatsApp Cloud API) a fine aggiornamento
// giornaliero. Le credenziali vengono SOLO da variabili d'ambiente/GitHub
// Secrets, mai scritte qui: se mancano, esce pulito senza inviare nulla e
// senza far fallire il workflow (la notifica e' un extra, non il cuore
// dell'aggiornamento). Il token non viene mai stampato nei log.
//
// Uso: node scripts/notifica-whatsapp.mjs successo|fallimento
//
// IMPORTANTE (Meta Cloud API): un messaggio automatico e proattivo, inviato
// senza che l'utente abbia scritto prima nella finestra di 24h, richiede un
// MESSAGE TEMPLATE pre-approvato — un testo libero fallirebbe con un errore
// di Meta dopo la primissima interazione. Per tenere le cose semplici questo
// script usa un template con UNA SOLA variabile di corpo, dentro la quale
// passiamo l'intero messaggio gia' formattato: serve creare in Meta Business
// Manager un template con un solo placeholder {{1}} nel corpo, approvato,
// nome di default 'pronostici_giornalieri' (personalizzabile via
// WHATSAPP_TEMPLATE_NAME), lingua di default 'it' (WHATSAPP_TEMPLATE_LANG).

import { readFileSync, existsSync } from 'node:fs';

const modo = process.argv[2];
if (!['successo', 'fallimento'].includes(modo)) {
  console.error("Uso: node scripts/notifica-whatsapp.mjs successo|fallimento");
  process.exit(1);
}

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TO = process.env.WHATSAPP_TO;
const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'pronostici_giornalieri';
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'it';
const URL_PUBBLICA = process.env.PUBLIC_URL || 'https://dado189-code.github.io/pronostici/';

if (!TOKEN || !PHONE_NUMBER_ID || !TO) {
  console.log('WhatsApp non configurato (mancano WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TO come secret): nessuna notifica inviata. '
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

console.log(`Invio notifica WhatsApp (${modo})...`); // mai stampare testo/token: il corpo puo' finire nei log altrimenti

const corpo = {
  messaging_product: 'whatsapp',
  to: TO,
  type: 'template',
  template: {
    name: TEMPLATE_NAME,
    language: { code: TEMPLATE_LANG },
    components: [{ type: 'body', parameters: [{ type: 'text', text: testo }] }]
  }
};

try {
  const res = await fetch(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo)
  });
  const risposta = await res.json().catch(() => null);
  if (!res.ok) {
    // la risposta di errore di Meta non contiene mai il token; e' sicuro
    // stamparla per capire cosa e' andato storto (es. template non trovato)
    console.error(`Invio WhatsApp fallito: HTTP ${res.status}`, JSON.stringify(risposta));
  } else {
    console.log('Notifica WhatsApp inviata.', risposta?.messages?.[0]?.id ? `id=${risposta.messages[0].id}` : '');
  }
} catch (e) {
  console.error(`Invio WhatsApp fallito (rete): ${e.message}`);
}
// process.exitCode, non process.exit: un fallimento di invio non deve far
// fallire il workflow (i dati sono gia' pubblicati), e non forza la
// terminazione immediata del processo con socket ancora in chiusura.
process.exitCode = 0;
