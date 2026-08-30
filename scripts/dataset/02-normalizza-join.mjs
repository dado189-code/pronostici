// scripts/dataset/02-normalizza-join.mjs
// STEP 3-5: normalizza le due fonti su una chiave comune (lega, stagione,
// data, casa, ospite) e le unisce. Il join usa SOLO team-aliases.json
// (esplicito, versionato) per i nomi divergenti: nessun fuzzy matching che
// accetti automaticamente un abbinamento incerto. Se un nome non e' ne'
// identico ne' in team-aliases.json, la partita resta non unita e finisce
// nel report invece di essere abbinata per somiglianza.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { LEGHE, STAGIONI, RAW_UNDERSTAT_DIR, RAW_FOOTBALLDATA_DIR, NORMALIZED_DIR } from './00-config.mjs';

mkdirSync(NORMALIZED_DIR, { recursive: true });
const aliasFile = JSON.parse(readFileSync('data/team-aliases.json', 'utf8'));
const alias = (nome) => aliasFile.mappa[nome] || nome;

function csv(testo) {
  const righe = testo.trim().split(/\r?\n/);
  const intest = righe[0].split(',');
  return righe.slice(1).map(r => {
    const c = r.split(',');
    return Object.fromEntries(intest.map((h, i) => [h.trim(), c[i]]));
  });
}

// football-data usa dd/mm/yy o dd/mm/yyyy secondo la stagione
function dataFootballData(s) {
  const [g, m, a] = (s || '').split('/');
  if (!g) return null;
  const anno = a.length === 2 ? 2000 + Number(a) : Number(a);
  return new Date(Date.UTC(anno, Number(m) - 1, Number(g)));
}

const isoGiorno = (d) => d.toISOString().slice(0, 10);

const reportGlobale = [];
const datasetCompleto = [];

for (const lega of LEGHE) {
  for (const st of STAGIONI) {
    // --- Understat: dati risultato + xG per partita ---
    const rawU = JSON.parse(readFileSync(`${RAW_UNDERSTAT_DIR}/${lega.understat}-${st.understat}.json`, 'utf8'));
    const perSquadraGiorno = {};
    for (const t of Object.values(rawU.data.teams))
      for (const h of t.history) perSquadraGiorno[`${t.title}|${h.date.slice(0, 10)}`] = h;

    const partiteU = rawU.data.dates.filter(p => p.isResult).map(p => {
      const giorno = p.datetime.slice(0, 10);
      const hCasa = perSquadraGiorno[`${p.h.title}|${giorno}`];
      const hOspite = perSquadraGiorno[`${p.a.title}|${giorno}`];
      return {
        data: giorno, casa: p.h.title, ospite: p.a.title,
        golCasa: parseInt(p.goals.h, 10), golOspite: parseInt(p.goals.a, 10),
        xgCasa: parseFloat(p.xG.h), xgOspite: parseFloat(p.xG.a),
        npxgCasa: hCasa ? parseFloat(hCasa.npxG) : null, npxgOspite: hOspite ? parseFloat(hOspite.npxG) : null,
        ppdaCasa: hCasa ? hCasa.ppda : null, ppdaOspite: hOspite ? hOspite.ppda : null,
        deepCasa: hCasa ? hCasa.deep : null, deepOspite: hOspite ? hOspite.deep : null,
        xptsCasa: hCasa ? hCasa.xpts : null, xptsOspite: hOspite ? hOspite.xpts : null,
        chiave: `${giorno}|${p.h.title}|${p.a.title}`, usato: false
      };
    });

    // --- football-data: risultato + quote ---
    const rawCsv = readFileSync(`${RAW_FOOTBALLDATA_DIR}/${lega.footballData}-${st.footballData}.csv`, 'utf8');
    const righeFd = csv(rawCsv).map(r => {
      const d = dataFootballData(r.Date);
      return {
        data: d ? isoGiorno(d) : null,
        casaRaw: r.HomeTeam, ospiteRaw: r.AwayTeam,
        casa: alias(r.HomeTeam), ospite: alias(r.AwayTeam),
        golCasa: Number(r.FTHG), golOspite: Number(r.FTAG),
        aperturaCasa: Number(r.PSH || r.B365H) || null, aperturaX: Number(r.PSD || r.B365D) || null, aperturaOsp: Number(r.PSA || r.B365A) || null,
        chiusuraCasa: Number(r.PSCH || r.B365CH || r.AvgCH) || null, chiusuraX: Number(r.PSCD || r.B365CD || r.AvgCD) || null, chiusuraOsp: Number(r.PSCA || r.B365CA || r.AvgCA) || null,
        bookmaker: r.PSCH ? 'Pinnacle' : (r.B365CH ? 'Bet365' : (r.AvgCH ? 'media mercato' : null)),
        usato: false
      };
    }).filter(r => r.data);

    // --- join: chiave esatta (giorno, casa normalizzata, ospite normalizzata) ---
    const indiceFd = {};
    for (const r of righeFd) {
      const k = `${r.data}|${r.casa}|${r.ospite}`;
      (indiceFd[k] ||= []).push(r);
    }

    let matched = 0, ambiguous = 0;
    const righeDataset = [];

    for (const u of partiteU) {
      const candidati = indiceFd[u.chiave] || [];
      if (candidati.length === 1) {
        const f = candidati[0];
        u.usato = true; f.usato = true;
        matched++;
        righeDataset.push({
          match_id: `${lega.footballData}-${st.footballData}-${u.chiave}`.replace(/[^a-zA-Z0-9-]/g, '_'),
          league: lega.nome, season: st.etichetta, date: u.data,
          home_team: u.casa, away_team: u.ospite,
          home_team_raw_understat: u.casa, away_team_raw_understat: u.ospite,
          home_team_raw_odds: f.casaRaw, away_team_raw_odds: f.ospiteRaw,
          join_status: 'MATCHED',
          goals_home: u.golCasa, goals_away: u.golOspite,
          xG_home: u.xgCasa, xG_away: u.xgOspite,
          npxG_home: u.npxgCasa, npxG_away: u.npxgOspite,
          ppda_home: u.ppdaCasa, ppda_away: u.ppdaOspite,
          deep_home: u.deepCasa, deep_away: u.deepOspite,
          xpts_home: u.xptsCasa, xpts_away: u.xptsOspite,
          opening_home: f.aperturaCasa, opening_draw: f.aperturaX, opening_away: f.aperturaOsp,
          closing_home: f.chiusuraCasa, closing_draw: f.chiusuraX, closing_away: f.chiusuraOsp,
          odds_source: f.bookmaker
        });
      } else if (candidati.length > 1) {
        ambiguous++;
        righeDataset.push({
          match_id: `${lega.footballData}-${st.footballData}-${u.chiave}-AMBIGUOUS`.replace(/[^a-zA-Z0-9-]/g, '_'),
          league: lega.nome, season: st.etichetta, date: u.data,
          home_team: u.casa, away_team: u.ospite, join_status: 'AMBIGUOUS',
          nota: `${candidati.length} righe football-data corrispondono alla stessa chiave`
        });
      }
    }
    for (const u of partiteU) if (!u.usato && !(indiceFd[u.chiave]?.length > 1))
      righeDataset.push({
        match_id: `${lega.footballData}-${st.footballData}-${u.chiave}-U`.replace(/[^a-zA-Z0-9-]/g, '_'),
        league: lega.nome, season: st.etichetta, date: u.data,
        home_team: u.casa, away_team: u.ospite, join_status: 'UNMATCHED_UNDERSTAT'
      });
    for (const f of righeFd) if (!f.usato)
      righeDataset.push({
        match_id: `${lega.footballData}-${st.footballData}-${f.data}-${f.casa}-${f.ospite}-O`.replace(/[^a-zA-Z0-9-]/g, '_'),
        league: lega.nome, season: st.etichetta, date: f.data,
        home_team: f.casa, away_team: f.ospite, join_status: 'UNMATCHED_ODDS'
      });

    const tot = righeDataset.length;
    const unmatchedU = righeDataset.filter(r => r.join_status === 'UNMATCHED_UNDERSTAT').length;
    const unmatchedO = righeDataset.filter(r => r.join_status === 'UNMATCHED_ODDS').length;
    reportGlobale.push({
      league: lega.nome, season: st.etichetta, totale_righe: tot,
      matched, unmatched_understat: unmatchedU, unmatched_odds: unmatchedO, ambiguous,
      pct_matched: +(matched / tot * 100).toFixed(1),
      pct_unmatched: +((unmatchedU + unmatchedO) / tot * 100).toFixed(1),
      pct_ambiguous: +(ambiguous / tot * 100).toFixed(1)
    });

    const nomeFile = `${NORMALIZED_DIR}/${lega.footballData}-${st.footballData}.json`;
    writeFileSync(nomeFile, JSON.stringify({ league: lega.nome, season: st.etichetta, righe: righeDataset }, null, 1));
    datasetCompleto.push(...righeDataset.filter(r => r.join_status === 'MATCHED'));
  }
}

const globaleMatched = reportGlobale.reduce((a, r) => a + r.matched, 0);
const globaleTot = reportGlobale.reduce((a, r) => a + r.totale_righe, 0);

writeFileSync(`${NORMALIZED_DIR}/report-qualita-join.json`, JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'join esplicito su (lega, stagione, data, casa, ospite) via team-aliases.json, nessun fuzzy matching automatico',
  globale: { totale_righe: globaleTot, matched: globaleMatched, pct_matched: +(globaleMatched / globaleTot * 100).toFixed(2) },
  perLegaStagione: reportGlobale
}, null, 1));

writeFileSync(`${NORMALIZED_DIR}/dataset-matched.json`, JSON.stringify({
  generato_il: new Date().toISOString(), nPartite: datasetCompleto.length, partite: datasetCompleto
}, null, 1));

console.log(`Join completato: ${globaleMatched}/${globaleTot} partite abbinate (${(globaleMatched / globaleTot * 100).toFixed(2)}%)`);
console.table(reportGlobale);
