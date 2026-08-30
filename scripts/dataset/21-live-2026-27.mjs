// scripts/dataset/21-live-2026-27.mjs
// FASE 8, Parte 2: modello live 2026/27. Storico 2025/26 (decayed) + partite
// 2026/27 gia' giocate, nello stesso stimaForze gia' validato — nessuna
// logica speciale di "pesi per prime giornate": il decadimento esponenziale
// gia' fa esattamente questo (le partite piu' vecchie pesano meno man mano
// che la stagione nuova avanza), come gia' raccomandato in Fase 4.
//
// Stato persistente per squadra: salvato su file, non ricalcolato da zero in
// modo incoerente a ogni run (punto 6). "historical_strength" e
// "current_season_strength" sono calcolati separatamente SOLO per
// trasparenza/ispezione: la previsione vera usa sempre "combined_strength"
// (l'unico output di stimaForze sullo storico unito, che e' gia' la
// combinazione corretta via decay, non una media manuale dei due).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { stimaForze, stimaRho, lambde, mercati } from '../model.mjs';
import { MODELLO } from '../config.mjs';
import { LEGHE } from './00-config.mjs';

const HEADERS_UNDERSTAT = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01'
};

async function scaricaUnderstat2027(lega) {
  const url = `https://understat.com/getLeagueData/${lega.understat}/2026`;
  const headers = { ...HEADERS_UNDERSTAT, Referer: `https://understat.com/league/${lega.understat}/2026` };
  const res = await fetch(url, { headers });
  const dati = JSON.parse(await res.text());
  return dati.dates.filter(d => d.isResult).map(p => ({
    data: new Date(p.datetime), casa: p.h.title, ospite: p.a.title,
    xgCasa: parseFloat(p.xG.h), xgOspite: parseFloat(p.xG.a),
    golCasa: parseInt(p.goals.h, 10), golOspite: parseInt(p.goals.a, 10)
  }));
}
async function partiteFutureUnderstat(lega) {
  const url = `https://understat.com/getLeagueData/${lega.understat}/2026`;
  const headers = { ...HEADERS_UNDERSTAT, Referer: `https://understat.com/league/${lega.understat}/2026` };
  const res = await fetch(url, { headers });
  const dati = JSON.parse(await res.text());
  return dati.dates.filter(d => !d.isResult).map(p => ({ casa: p.h.title, ospite: p.a.title, data: new Date(p.datetime) }));
}

mkdirSync('data/live', { recursive: true });
const risultatoLive = [];
const statoPersistente = existsSyncSafe('data/live/team-state.json') ? JSON.parse(readFileSync('data/live/team-state.json', 'utf8')) : { squadre: {} };
function existsSyncSafe(p) { try { readFileSync(p); return true; } catch { return false; } }

for (const lega of LEGHE) {
  // storico 2025/26 gia' scaricato in Fase 4 (data/raw/understat), riusato senza richieste
  const raw2526 = JSON.parse(readFileSync(`data/raw/understat/${lega.understat}-2025.json`, 'utf8'));
  const storico2526 = raw2526.data.dates.filter(d => d.isResult).map(p => ({
    data: new Date(p.datetime), casa: p.h.title, ospite: p.a.title,
    xgCasa: parseFloat(p.xG.h), xgOspite: parseFloat(p.xG.a),
    golCasa: parseInt(p.goals.h, 10), golOspite: parseInt(p.goals.a, 10)
  }));

  let storico2627 = [];
  try { storico2627 = await scaricaUnderstat2027(lega); }
  catch (e) { console.warn(`${lega.nome}: 2026/27 non disponibile (${e.message})`); }

  const oggi = new Date();
  const storicoCompleto = [...storico2526, ...storico2627].sort((a, b) => a.data - b.data);

  // solo per ispezione/trasparenza: forze calcolate SEPARATAMENTE sulle due fette,
  // NON usate per la previsione (quella usa storicoCompleto, un solo fit coerente)
  const forzeStorico = storico2526.length >= MODELLO.storicoMinimo ? stimaForze(storico2526, { emivita: MODELLO.emivitaGiorni, oggi }) : null;
  const forzeCorrente = storico2627.length >= 30 ? stimaForze(storico2627, { emivita: MODELLO.emivitaGiorni, oggi }) : null;
  const forzeCombinate = stimaForze(storicoCompleto, { emivita: MODELLO.emivitaGiorni, oggi });
  const rho = stimaRho(storicoCompleto.slice(-300), forzeCombinate, MODELLO);

  // stato persistente per squadra (punto 6)
  for (const sq of forzeCombinate.squadre) {
    statoPersistente.squadre[`${lega.nome}|${sq}`] = {
      last_updated: oggi.toISOString(),
      matches_current_season: storico2627.filter(p => p.casa === sq || p.ospite === sq).length,
      historical_strength: forzeStorico ? { att: +forzeStorico.att[sq]?.toFixed(3) || null, dif: +forzeStorico.dif[sq]?.toFixed(3) || null } : null,
      current_season_strength: forzeCorrente && forzeCorrente.att[sq] ? { att: +forzeCorrente.att[sq].toFixed(3), dif: +forzeCorrente.dif[sq].toFixed(3) } : null,
      combined_strength: { att: +forzeCombinate.att[sq].toFixed(3), dif: +forzeCombinate.dif[sq].toFixed(3) }
    };
  }

  // previsioni per le partite 2026/27 gia' giocate: quanto "pesava" lo storico
  // 2025/26 al momento di ognuna, rispetto a quello raccolto nel 2026/27 stesso
  // (calcolato SOLO usando dati fino al giorno prima di ogni partita, walk-forward)
  const partiteOrdinate = storico2627.sort((a, b) => a.data - b.data);
  for (let i = 0; i < partiteOrdinate.length; i++) {
    const p = partiteOrdinate[i];
    const storicoFinoQui = [...storico2526, ...partiteOrdinate.slice(0, i)];
    const forzeQui = stimaForze(storicoFinoQui, { emivita: MODELLO.emivitaGiorni, oggi: p.data });
    const rhoQui = stimaRho(storicoFinoQui.slice(-300), forzeQui, MODELLO);
    const { lh, la } = lambde(forzeQui, p.casa, p.ospite);
    if (!lh || !la) continue;
    const mk = mercati(lh, la, rhoQui);

    // peso indicativo: quanta massa (pesata dal decay) viene dalla stagione
    // precedente rispetto alla corrente, nello storico usato per QUESTA previsione
    const pesoDecayA = (data) => Math.pow(0.5, (p.data - data) / (864e5 * MODELLO.emivitaGiorni));
    const pesoPrec = storico2526.reduce((a, x) => a + pesoDecayA(x.data), 0);
    const pesoCorr = partiteOrdinate.slice(0, i).reduce((a, x) => a + pesoDecayA(x.data), 0);
    const totPeso = pesoPrec + pesoCorr;

    risultatoLive.push({
      league: lega.nome, date: p.data.toISOString().slice(0, 10), home_team: p.casa, away_team: p.ospite,
      goals_home: p.golCasa, goals_away: p.golOspite,
      lambda_home: +lh.toFixed(3), lambda_away: +la.toFixed(3),
      P1: +mk['1'].toFixed(4), PX: +mk['X'].toFixed(4), P2: +mk['2'].toFixed(4),
      previous_season_weight_pct: totPeso > 0 ? +(pesoPrec / totPeso * 100).toFixed(1) : null,
      current_season_weight_pct: totPeso > 0 ? +(pesoCorr / totPeso * 100).toFixed(1) : null,
      matchday_current_season: i + 1
    });
  }

  console.log(`${lega.nome}: storico 2025/26=${storico2526.length}, 2026/27 giocate=${storico2627.length}, previsioni live generate=${partiteOrdinate.length}`);
}

writeFileSync('data/live/team-state.json', JSON.stringify(statoPersistente, null, 1));
writeFileSync('data/live/previsioni-2026-27.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Ogni previsione usa SOLO partite con data precedente (walk-forward, come nel resto del progetto). '
    + 'previous_season_weight_pct / current_season_weight_pct: quota della massa di storico pesata dal decay '
    + '(emivita 180gg) che viene dalla stagione precedente rispetto alla corrente, al momento di quella previsione.',
  partite: risultatoLive
}, null, 1));

console.log(`\nTotale previsioni live 2026/27: ${risultatoLive.length}`);
console.log('Esempio pesi (prime 5 previsioni per lega, dovrebbero avere previous_season_weight alto):');
for (const lega of LEGHE) {
  const prime = risultatoLive.filter(r => r.league === lega.nome).slice(0, 2);
  for (const r of prime) console.log(`  ${lega.nome} g.${r.matchday_current_season}: ${r.home_team}-${r.away_team} | prev=${r.previous_season_weight_pct}% curr=${r.current_season_weight_pct}%`);
}
