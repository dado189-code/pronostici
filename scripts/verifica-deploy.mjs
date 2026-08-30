// scripts/verifica-deploy.mjs
// Verifica che il deploy GitHub Pages sia davvero online con i dati appena
// pubblicati, PRIMA di considerare l'aggiornamento giornaliero riuscito.
// Non basta che git push sia andato a buon fine: GitHub Pages ricostruisce
// la pagina in modo asincrono (osservato: ~40-50s), quindi si interroga
// l'URL pubblico con retry finche' non risponde HTTP 200 con lo stesso
// timestamp "aggiornato" appena scritto da build.mjs (passato come argomento).
//
// Uso: node scripts/verifica-deploy.mjs <aggiornato_atteso_ISO>
// Env opzionali: PICKS_URL (default pagina pubblica del progetto),
// VERIFICA_TENTATIVI (default 20), VERIFICA_INTERVALLO_MS (default 15000).
// Exit 0 se verificato, exit 1 altrimenti (nessuna eccezione non gestita).

const atteso = process.argv[2];
if (!atteso) {
  console.error('Uso: node scripts/verifica-deploy.mjs <timestamp-aggiornato-atteso-ISO>');
  process.exit(1);
}

const URL_PICKS = process.env.PICKS_URL || 'https://dado189-code.github.io/pronostici/data/picks.json';
const TENTATIVI = Number(process.env.VERIFICA_TENTATIVI || 20);
const INTERVALLO_MS = Number(process.env.VERIFICA_INTERVALLO_MS || 15000);

async function tentativo() {
  const res = await fetch(`${URL_PICKS}?verifica=${Date.now()}`);
  if (!res.ok) return { ok: false, motivo: `HTTP ${res.status}` };
  let corpo;
  try { corpo = await res.json(); }
  catch { return { ok: false, motivo: 'risposta non JSON' }; }
  if (corpo.aggiornato !== atteso) return { ok: false, motivo: `aggiornato="${corpo.aggiornato}" (atteso "${atteso}")` };
  return { ok: true };
}

// process.exitCode (non process.exit) apposta: lascia che node chiuda da
// solo gli eventuali socket keep-alive del fetch invece di forzare la
// terminazione immediata, che su alcune piattaforme puo' far crashare il
// processo con un assertion error di libuv se un handle e' ancora in chiusura.
let verificato = false;
for (let i = 1; i <= TENTATIVI && !verificato; i++) {
  let esito;
  try { esito = await tentativo(); }
  catch (e) { esito = { ok: false, motivo: `errore rete: ${e.message}` }; }

  if (esito.ok) {
    console.log(`Deploy verificato al tentativo ${i}/${TENTATIVI}: HTTP 200, aggiornato="${atteso}".`);
    verificato = true;
    break;
  }
  console.log(`Tentativo ${i}/${TENTATIVI}: non ancora pronto (${esito.motivo}).`);
  if (i < TENTATIVI) await new Promise(r => setTimeout(r, INTERVALLO_MS));
}

if (!verificato) {
  console.error(`Deploy NON verificato dopo ${TENTATIVI} tentativi (~${Math.round(TENTATIVI * INTERVALLO_MS / 1000)}s). Nessuna notifica di successo verra' inviata.`);
}
process.exitCode = verificato ? 0 : 1;
