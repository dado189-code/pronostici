// scripts/dataset/17-promoted-analysis.mjs
// FASE 7, punto 17: la Fase 5 aveva trovato Brier ~0.642 nelle prime 5
// partite delle neopromosse. Qui si scompone: il modello le sovrastima o le
// sottostima? Di piu' in attacco o in difesa? In casa o in trasferta?

import { readFileSync, writeFileSync } from 'node:fs';
import { LEGHE, SPLIT } from './00-config.mjs';

const dataset = JSON.parse(readFileSync('data/normalized/dataset-matched.json', 'utf8')).partite;
const wf = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';

const squadrePerStagione = {};
for (const r of dataset) (squadrePerStagione[`${r.league}|${r.season}`] ||= new Set()).add(r.home_team).add(r.away_team);
const stagioniOrdine = ['2022/23', '2023/24', '2024/25', '2025/26'];

function ePromossa(lega, stagione, squadra) {
  const idx = stagioniOrdine.indexOf(stagione);
  if (idx <= 0) return false;
  const precedenti = squadrePerStagione[`${lega}|${stagioniOrdine[idx - 1]}`];
  return precedenti ? !precedenti.has(squadra) : false;
}

// numero progressivo di partite giocate dalla squadra in quella stagione (nel dataset, quindi solo campionato)
const contaProgressivo = {};
const righeAnalisi = [];

for (const p of wf.previsioni) {
  for (const [sq, casa] of [[p.home_team, true], [p.away_team, false]]) {
    const k = `${p.league}|${p.season}|${sq}`;
    if (!ePromossa(p.league, p.season, sq)) continue;
    contaProgressivo[k] = (contaProgressivo[k] || 0) + 1;
    const num = contaProgressivo[k];
    if (num > 15) continue; // solo le prime 15 per questa analisi
    const golAttesi = casa ? p.modelA.lambda_home : p.modelA.lambda_away;
    const golVeri = casa ? p.goals_home : p.goals_away;
    const golSubitiAttesi = casa ? p.modelA.lambda_away : p.modelA.lambda_home;
    const golSubitiVeri = casa ? p.goals_away : p.goals_home;
    righeAnalisi.push({ squadra: sq, lega: p.league, stagione: p.season, num, casa,
      golAttesi, golVeri, golSubitiAttesi, golSubitiVeri,
      probEsitoGiusto: casa ? p.modelA.P1 : p.modelA.P2, esito: p.esito, vinta: (casa && p.esito === 'H') || (!casa && p.esito === 'A') });
  }
}

function media(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

const fasce = { '1-5': r => r.num <= 5, '6-10': r => r.num > 5 && r.num <= 10, '11-15': r => r.num > 10 && r.num <= 15 };
const out = {};
for (const [fascia, filtro] of Object.entries(fasce)) {
  const rows = righeAnalisi.filter(filtro);
  const home = rows.filter(r => r.casa), away = rows.filter(r => !r.casa);
  out[fascia] = {
    n: rows.length,
    // bias attacco: positivo = sovrastimiamo i gol fatti dalla neopromossa (attesi > veri)
    bias_attacco: +(media(rows.map(r => r.golAttesi)) - media(rows.map(r => r.golVeri))).toFixed(3),
    bias_difesa: +(media(rows.map(r => r.golSubitiAttesi)) - media(rows.map(r => r.golSubitiVeri))).toFixed(3),
    gol_attesi_medi: +media(rows.map(r => r.golAttesi)).toFixed(3), gol_veri_medi: +media(rows.map(r => r.golVeri)).toFixed(3),
    gol_subiti_attesi_medi: +media(rows.map(r => r.golSubitiAttesi)).toFixed(3), gol_subiti_veri_medi: +media(rows.map(r => r.golSubitiVeri)).toFixed(3),
    n_home: home.length, n_away: away.length,
    bias_attacco_home: home.length ? +(media(home.map(r => r.golAttesi)) - media(home.map(r => r.golVeri))).toFixed(3) : null,
    bias_attacco_away: away.length ? +(media(away.map(r => r.golAttesi)) - media(away.map(r => r.golVeri))).toFixed(3) : null,
    win_rate_reale_pct: +(rows.filter(r => r.vinta).length / rows.length * 100).toFixed(1),
    win_prob_media_modello_pct: +(media(rows.map(r => r.probEsitoGiusto)) * 100).toFixed(1)
  };
}

writeFileSync('data/backtests/promoted-team-analysis.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'bias_attacco = gol_attesi_medi - gol_veri_medi: positivo = il modello SOVRASTIMA quanto segna la neopromossa. '
    + 'bias_difesa = gol_subiti_attesi - gol_subiti_veri: positivo = il modello SOVRASTIMA quanti gol subisce '
    + '(cioe pensa che la difesa sia peggiore di quanto sia davvero).',
  per_fascia: out
}, null, 1));

console.log(JSON.stringify(out, null, 1));
