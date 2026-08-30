// scripts/dataset/22-promoted-second-division.mjs
// FASE 8, punti 7-9: prior per neopromosse da statistiche REALI di seconda
// divisione (football-data.co.uk, gratis, verificato in Fase 7). Nessun xG
// per le seconde serie: solo PPG, GD/game, GF/game, GA/game, posizione
// finale — dichiarato esplicitamente, non inventato oltre questo.

import { readFileSync, writeFileSync } from 'node:fs';
import { LEGHE } from './00-config.mjs';

const SECONDE_SERIE = {
  'Premier League': 'E1', 'Liga': 'SP2', 'Serie A': 'I2', 'Bundesliga': 'D2', 'Ligue 1': 'F2'
};
// stagione di seconda serie = quella immediatamente precedente alla promozione
const STAGIONI_SECONDA = ['2122', '2223', '2324', '2425'];

async function scaricaSecondaSerie(codice, stagione) {
  const url = `https://www.football-data.co.uk/mmz4281/${stagione}/${codice}.csv`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const testo = await r.text();
  const righe = testo.trim().split(/\r?\n/);
  const intest = righe[0].split(',');
  const iH = intest.indexOf('HomeTeam'), iA = intest.indexOf('AwayTeam'), iFTHG = intest.indexOf('FTHG'), iFTAG = intest.indexOf('FTAG');
  const partite = righe.slice(1).map(r => { const c = r.split(','); return { home: c[iH], away: c[iA], gh: Number(c[iFTHG]), ga: Number(c[iFTAG]) }; })
    .filter(p => p.home && Number.isFinite(p.gh));
  // classifica finale da zero: punti, GF, GA, partite
  const tab = {};
  for (const p of partite) {
    for (const [sq, gf, ga, pt] of [[p.home, p.gh, p.ga, p.gh > p.ga ? 3 : p.gh === p.ga ? 1 : 0], [p.away, p.ga, p.gh, p.ga > p.gh ? 3 : p.ga === p.gh ? 1 : 0]]) {
      const t = tab[sq] ||= { squadra: sq, punti: 0, gf: 0, ga: 0, partite: 0 };
      t.punti += pt; t.gf += gf; t.ga += ga; t.partite++;
    }
  }
  const classifica = Object.values(tab).sort((a, b) => b.punti - a.punti);
  classifica.forEach((t, i) => { t.posizione = i + 1; t.ppg = +(t.punti / t.partite).toFixed(3); t.gfPg = +(t.gf / t.partite).toFixed(3); t.gaPg = +(t.ga / t.partite).toFixed(3); t.gdPg = +((t.gf - t.ga) / t.partite).toFixed(3); });
  return classifica;
}

// alias minimi, verificati sul bisogno reale (nomi football-data seconda serie -> Understat)
const ALIAS_SECONDA = {
  'Sunderland': 'Sunderland', 'Burnley': 'Burnley', 'Leeds': 'Leeds',
  'Sassuolo': 'Sassuolo', 'Cremonese': 'Cremonese', 'Pisa': 'Pisa',
  'FC Koln': 'FC Cologne', 'Hamburg': 'Hamburger SV', "Nott'm Forest": 'Nottingham Forest',
  'Ipswich': 'Ipswich', 'Southampton': 'Southampton', 'Leicester': 'Leicester', 'Luton': 'Luton',
  'Empoli': 'Empoli', 'Frosinone': 'Frosinone', 'Verona': 'Verona', 'Como': 'Como', 'Venezia': 'Venezia', 'Parma': 'Parma Calcio 1913', 'Monza': 'Monza',
  'Almeria': 'Almeria', 'Girona': 'Girona', 'Las Palmas': 'Las Palmas', 'Leganes': 'Leganes', 'Valladolid': 'Real Valladolid', 'Elche': 'Elche', 'Levante': 'Levante', 'Oviedo': 'Real Oviedo',
  'Darmstadt': 'Darmstadt', 'Heidenheim': 'FC Heidenheim', 'St Pauli': 'St. Pauli', 'Holstein Kiel': 'Holstein Kiel',
  'Le Havre': 'Le Havre', 'Metz': 'Metz', 'Troyes': 'Troyes', 'Auxerre': 'Auxerre', 'Angers': 'Angers', 'St Etienne': 'Saint-Etienne', 'Lorient': 'Lorient', 'Paris FC': 'Paris FC'
};

const wf = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const dataset = JSON.parse(readFileSync('data/normalized/dataset-matched.json', 'utf8')).partite;
const squadrePerStagione = {};
for (const r of dataset) (squadrePerStagione[`${r.league}|${r.season}`] ||= new Set()).add(r.home_team).add(r.away_team);
const STAGIONI_ORDINE = ['2022/23', '2023/24', '2024/25', '2025/26'];
function ePromossa(lega, stagione, squadra) {
  const idx = STAGIONI_ORDINE.indexOf(stagione);
  if (idx <= 0) return false;
  const prec = squadrePerStagione[`${lega}|${STAGIONI_ORDINE[idx - 1]}`];
  return prec ? !prec.has(squadra) : false;
}

// mappa stagione massima serie -> stagione seconda serie precedente (codice football-data)
const MAPPA_STAGIONE_SECONDA = { '2022/23': '2122', '2023/24': '2223', '2024/25': '2324', '2025/26': '2425' };

const datiSecondaPerNeopromossa = {}; // "lega|stagione|squadra" -> {ppg, gdPg, gfPg, gaPg, posizione}
for (const lega of LEGHE) {
  const codiceSeconda = SECONDE_SERIE[lega.nome];
  for (const stagione of STAGIONI_ORDINE) {
    const codiceStagioneSeconda = MAPPA_STAGIONE_SECONDA[stagione];
    const classifica = await scaricaSecondaSerie(codiceSeconda, codiceStagioneSeconda);
    if (!classifica) { console.warn(`${lega.nome} ${stagione}: seconda serie ${codiceSeconda}/${codiceStagioneSeconda} non disponibile`); continue; }
    for (const t of classifica) {
      const nomeUnderstat = ALIAS_SECONDA[t.squadra];
      if (!nomeUnderstat) continue;
      if (ePromossa(lega.nome, stagione, nomeUnderstat)) {
        datiSecondaPerNeopromossa[`${lega.nome}|${stagione}|${nomeUnderstat}`] = { ppg: t.ppg, gdPg: t.gdPg, gfPg: t.gfPg, gaPg: t.gaPg, posizione: t.posizione, nPartiteSeconda: t.partite };
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

console.log(`Neopromosse con dato di seconda serie recuperato: ${Object.keys(datiSecondaPerNeopromossa).length}`);
console.log(JSON.stringify(datiSecondaPerNeopromossa, null, 1));

// ---------------------------------------------------------------- performance reale nelle prime 5/10/15 partite di massima serie
function oneHot(e) { return e === 'H' ? [1, 0, 0] : e === 'D' ? [0, 1, 0] : [0, 0, 1]; }
function brierRow([ph, pd, pa], e) { const [oh, od, oa] = oneHot(e); return (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2; }

const contaProgressivo = {};
const campioni = []; // {chiave, ppg, gdPg, ..., brierPrime5, brierPrime10, brierPrime15, probVittoriaMediaPrime5, ...}
const accumulo = {}; // chiave -> {brier5:[], brier10:[], brier15:[]}

for (const p of wf.previsioni) {
  for (const [sq, casa] of [[p.home_team, true], [p.away_team, false]]) {
    const chiave = `${p.league}|${p.season}|${sq}`;
    if (!datiSecondaPerNeopromossa[chiave]) continue;
    contaProgressivo[chiave] = (contaProgressivo[chiave] || 0) + 1;
    const num = contaProgressivo[chiave];
    const prob = casa ? [p.modelA.P1, p.modelA.PX, p.modelA.P2] : [p.modelA.P2, p.modelA.PX, p.modelA.P1];
    const esitoRelativo = casa ? p.esito : (p.esito === 'H' ? 'A' : p.esito === 'A' ? 'H' : 'D');
    const b = brierRow(casa ? [p.modelA.P1, p.modelA.PX, p.modelA.P2] : [p.modelA.P2, p.modelA.PX, p.modelA.P1], esitoRelativo);
    const acc = accumulo[chiave] ||= { brier5: [], brier10: [], brier15: [] };
    if (num <= 5) acc.brier5.push(b);
    if (num <= 10) acc.brier10.push(b);
    if (num <= 15) acc.brier15.push(b);
  }
}
function media(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
for (const [chiave, dati] of Object.entries(datiSecondaPerNeopromossa)) {
  const acc = accumulo[chiave];
  if (!acc || !acc.brier15.length) continue;
  campioni.push({ chiave, ...dati, brier5: media(acc.brier5), brier10: media(acc.brier10), brier15: media(acc.brier15) });
}

console.log(`\nCampioni con brier calcolabile: ${campioni.length}`);
console.table(campioni.map(c => ({ chiave: c.chiave, ppg: c.ppg, gdPg: c.gdPg, posizione: c.posizione, brier5: c.brier5?.toFixed(3), brier15: c.brier15?.toFixed(3) })));

// ---------------------------------------------------------------- regressione lineare semplice (non ML): brier15 ~ ppg
function regressioneLineare(xs, ys) {
  const n = xs.length, mx = media(xs), my = media(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den > 0 ? num / den : 0, intercept = my - slope * mx;
  // R^2
  const pred = xs.map(x => intercept + slope * x);
  const ssRes = ys.reduce((a, y, i) => a + (y - pred[i]) ** 2, 0);
  const ssTot = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope: +slope.toFixed(4), intercept: +intercept.toFixed(4), r2: +r2.toFixed(3), n };
}

const regPpg = campioni.length >= 5 ? regressioneLineare(campioni.map(c => c.ppg), campioni.map(c => c.brier15)) : null;
const regGd = campioni.length >= 5 ? regressioneLineare(campioni.map(c => c.gdPg), campioni.map(c => c.brier15)) : null;

console.log('\nRegressione lineare brier15 ~ PPG seconda serie:', JSON.stringify(regPpg));
console.log('Regressione lineare brier15 ~ GD/game seconda serie:', JSON.stringify(regGd));

writeFileSync('data/backtests/promoted-second-division.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Dati REALI da football-data.co.uk (gratis): PPG, GD/game, GF/game, GA/game, posizione finale della '
    + 'stagione di seconda serie precedente alla promozione. Nessun xG disponibile per le seconde serie, non inventato. '
    + `Campione: ${campioni.length} neopromosse con match riuscito fra le fonti (su ${Object.keys(datiSecondaPerNeopromossa).length} identificate).`,
  dati_seconda_serie: datiSecondaPerNeopromossa,
  campioni_con_performance: campioni,
  regressione_ppg_vs_brier15: regPpg, regressione_gd_vs_brier15: regGd,
  conclusione: (regPpg && Math.abs(regPpg.r2) > 0.1)
    ? `R2=${regPpg.r2}: le statistiche di seconda serie mostrano una relazione con l errore del modello nelle prime 15 partite, ma il campione (${campioni.length}) e troppo piccolo per un modello affidabile`
    : `Campione troppo piccolo (${campioni.length}) o relazione troppo debole per costruire un prior statisticamente affidabile in questa iterazione`
}, null, 2));
