// scripts/dataset/01-scarica-raw.mjs
// STEP 2: scarica una volta sola, salva raw immutabile. Ogni file porta
// source, download_timestamp, league, season, endpoint/url. Da qui in poi
// tutto il resto del lavoro (normalizzazione, join, backtest) legge solo
// questi file: nessuno script successivo richiama piu' la rete (STEP 23).
//
// Rilanciarlo non sovrascrive un file gia' presente: il raw e' immutabile per
// definizione. Per riscaricare di proposito, cancellare il file a mano.

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { LEGHE, STAGIONI, RAW_UNDERSTAT_DIR, RAW_FOOTBALLDATA_DIR } from './00-config.mjs';

mkdirSync(RAW_UNDERSTAT_DIR, { recursive: true });
mkdirSync(RAW_FOOTBALLDATA_DIR, { recursive: true });

const HEADERS_UNDERSTAT = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01'
};

async function scaricaUnderstatRaw(lega) {
  const headers = { ...HEADERS_UNDERSTAT, Referer: `https://understat.com/league/${lega.understat}/2024` };
  for (const st of STAGIONI) {
    const file = `${RAW_UNDERSTAT_DIR}/${lega.understat}-${st.understat}.json`;
    if (existsSync(file)) { console.log(`gia presente: ${file}`); continue; }
    const url = `https://understat.com/getLeagueData/${lega.understat}/${st.understat}`;
    let dati = null, ultimo = '';
    for (let t = 1; t <= 3 && !dati; t++) {
      if (t > 1) await new Promise(r => setTimeout(r, 1000 * t));
      const res = await fetch(url, { headers });
      if (!res.ok) { ultimo = `HTTP ${res.status}`; continue; }
      try { dati = JSON.parse(await res.text()); } catch (e) { ultimo = e.message; }
    }
    if (!dati) { console.warn(`FALLITO ${url}: ${ultimo}`); continue; }
    writeFileSync(file, JSON.stringify({
      source: 'understat', download_timestamp: new Date().toISOString(),
      league: lega.nome, season: st.etichetta, endpoint: url, data: dati
    }, null, 1));
    console.log(`salvato ${file} (${dati.dates?.length ?? 0} partite)`);
    await new Promise(r => setTimeout(r, 600)); // non martellare il server
  }
}

async function scaricaFootballDataRaw(lega) {
  for (const st of STAGIONI) {
    const file = `${RAW_FOOTBALLDATA_DIR}/${lega.footballData}-${st.footballData}.csv`;
    const fileMeta = `${RAW_FOOTBALLDATA_DIR}/${lega.footballData}-${st.footballData}.meta.json`;
    if (existsSync(file)) { console.log(`gia presente: ${file}`); continue; }
    const url = `https://www.football-data.co.uk/mmz4281/${st.footballData}/${lega.footballData}.csv`;
    const res = await fetch(url);
    if (!res.ok) { console.warn(`FALLITO ${url}: HTTP ${res.status}`); continue; }
    const testo = await res.text();
    writeFileSync(file, testo);
    writeFileSync(fileMeta, JSON.stringify({
      source: 'football-data.co.uk', download_timestamp: new Date().toISOString(),
      league: lega.nome, season: st.etichetta, url
    }, null, 1));
    console.log(`salvato ${file} (${testo.trim().split('\n').length - 1} righe)`);
    await new Promise(r => setTimeout(r, 300));
  }
}

for (const lega of LEGHE) {
  await scaricaUnderstatRaw(lega);
  await scaricaFootballDataRaw(lega);
}
console.log('\nRaw completato.');
