// scripts/dataset/14-feature-extraction-ml.mjs
// FASE 6, punto 4: estrae il dataset tabulare per il modello ML, in CSV,
// pronto per Python/LightGBM. Ogni riga = una partita futura, ogni feature
// calcolata SOLO da partite con data < data della partita (stesso principio
// del walk-forward Dixon-Coles, riusato qui per il ML).
//
// Riusa le funzioni pure gia' scritte per la Fase 1-2 (npxGDFinestre,
// formaCasaTrasferta, xPointsDelta) invece di riscriverle: e' lo stesso
// principio "non duplicare la logica di liquidazione" applicato alle feature.

import { readFileSync, writeFileSync } from 'node:fs';
import { npxGDFinestre, xPointsDelta, aggiornaElo } from '../features.mjs';
import { ELO, FINESTRE_FORMA } from '../config.mjs';
import { LEGHE, SPLIT } from './00-config.mjs';

const dataset = JSON.parse(readFileSync('data/normalized/dataset-matched.json', 'utf8'));
const partiteTutte = dataset.partite;
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';

function media(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

const righeCsv = [];
const colonne = [
  'match_id', 'league', 'season', 'date', 'split', 'target',
  'home_team', 'away_team',
  // rolling per casa/ospite, tutte le finestre
  ...FINESTRE_FORMA.map(n => `home_xg_last${n}`), 'home_xg_season',
  ...FINESTRE_FORMA.map(n => `home_xga_last${n}`), 'home_xga_season',
  ...FINESTRE_FORMA.map(n => `home_npxg_last${n}`), 'home_npxg_season',
  ...FINESTRE_FORMA.map(n => `home_npxga_last${n}`), 'home_npxga_season',
  ...FINESTRE_FORMA.map(n => `away_xg_last${n}`), 'away_xg_season',
  ...FINESTRE_FORMA.map(n => `away_xga_last${n}`), 'away_xga_season',
  ...FINESTRE_FORMA.map(n => `away_npxg_last${n}`), 'away_npxg_season',
  ...FINESTRE_FORMA.map(n => `away_npxga_last${n}`), 'away_npxga_season',
  'xg_diff_last10', 'xga_diff_last10', 'npxgd_diff_season',
  'elo_before_home', 'elo_before_away', 'elo_diff', 'elo_trend_home', 'elo_trend_away',
  'xpoints_delta_home', 'xpoints_delta_away',
  'ppda_home_last10', 'ppda_away_last10', 'deep_home_last10', 'deep_away_last10',
  'strength_of_schedule_home', 'strength_of_schedule_away',
  'league_cat', 'season_phase', 'matchday_home', 'matchday_away',
  'sample_size_home', 'sample_size_away',
  'promoted_home', 'promoted_away',
  'days_since_prev_home', 'days_since_prev_away'
];

for (const lega of LEGHE) {
  const partite = partiteTutte.filter(r => r.league === lega.nome)
    .map(r => ({ ...r, dataObj: new Date(r.date) })).sort((a, b) => a.dataObj - b.dataObj);

  // storia per squadra: array di {date, h_a, xG, xGA, npxG, npxGA, ppda, deep, xpts, pts}
  const storiaSquadra = {};
  const contaStagionale = {}; // "squadra|stagione" -> quante partite gia' giocate
  const ultimaData = {}; // "squadra" -> data ultima partita
  const eloAttuale = {}, eloUltimaVar = {}; // per trend, storia elo per squadra
  const eloStoriaSquadra = {};
  let stagioneEloCorrente = null;

  // elenco squadre per stagione, per il flag promosso
  const squadrePerStagione = {};
  for (const r of partite) { (squadrePerStagione[r.season] ||= new Set()).add(r.home_team).add(r.away_team); }
  const stagioniOrdine = [...new Set(partite.map(r => r.season))].sort();

  const mediaEloLega = () => { const v = Object.values(eloAttuale); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : ELO.partenza; };

  for (const p of partite) {
    const split = splitDi(p.date);
    const casa = p.home_team, ospite = p.away_team;

    // --- storico pre-match per casa e ospite (SOLO partite precedenti)
    const storiaCasa = (storiaSquadra[casa] || []);
    const storiaOspite = (storiaSquadra[ospite] || []);

    const finCasa = npxGDFinestre(storiaCasa, p.dataObj, FINESTRE_FORMA, 180);
    const finOspite = npxGDFinestre(storiaOspite, p.dataObj, FINESTRE_FORMA, 180);
    // npxGDFinestre calcola solo npxG/npxGA: replico la stessa aggregazione anche per xG/xGA grezzo
    function finestreCampo(storia, campo, finestre) {
      const out = {};
      for (const n of finestre) { const fetta = storia.slice(0, n); out[`last${n}`] = fetta.length ? media(fetta.map(h => h[campo] ?? 0)) : null; }
      out.season = storia.length ? media(storia.map(h => h[campo] ?? 0)) : null;
      return out;
    }
    const xgCasa = finestreCampo(storiaCasa, 'xG', FINESTRE_FORMA), xgaCasa = finestreCampo(storiaCasa, 'xGA', FINESTRE_FORMA);
    const xgOspite = finestreCampo(storiaOspite, 'xG', FINESTRE_FORMA), xgaOspite = finestreCampo(storiaOspite, 'xGA', FINESTRE_FORMA);
    const ppdaCasa = finestreCampo(storiaCasa.map(h => ({ ppdaVal: h.ppda ? h.ppda.att / Math.max(1, h.ppda.def) : null })), 'ppdaVal', [10]);
    const ppdaOspite = finestreCampo(storiaOspite.map(h => ({ ppdaVal: h.ppda ? h.ppda.att / Math.max(1, h.ppda.def) : null })), 'ppdaVal', [10]);
    const deepCasa = finestreCampo(storiaCasa, 'deep', [10]), deepOspite = finestreCampo(storiaOspite, 'deep', [10]);

    const xpCasa = xPointsDelta(storiaCasa), xpOspite = xPointsDelta(storiaOspite);

    // --- Elo pre-match (sequenziale, transizioni di stagione, come nel walk-forward)
    if (p.season !== stagioneEloCorrente) {
      if (stagioneEloCorrente !== null && ELO.regressioneStagionale > 0) { const m = mediaEloLega(); for (const s of Object.keys(eloAttuale)) eloAttuale[s] += ELO.regressioneStagionale * (m - eloAttuale[s]); }
      stagioneEloCorrente = p.season;
    }
    const priorElo = Object.keys(eloAttuale).length ? mediaEloLega() - ELO.handicapNeopromossa : ELO.partenza;
    if (eloAttuale[casa] === undefined) eloAttuale[casa] = priorElo;
    if (eloAttuale[ospite] === undefined) eloAttuale[ospite] = priorElo;
    const eloBeforeHome = eloAttuale[casa], eloBeforeAway = eloAttuale[ospite];

    // trend: variazione elo nelle ultime 5 partite della squadra
    const trendDi = (sq) => { const st = eloStoriaSquadra[sq] || []; if (st.length < 2) return 0; const ultime = st.slice(-5); return ultime.at(-1) - ultime[0]; };
    const eloTrendHome = trendDi(casa), eloTrendAway = trendDi(ospite);

    // strength of schedule: Elo medio degli ultimi 5 avversari affrontati
    const sosDi = (avversari) => { const v = avversari.slice(-5).map(a => eloStoriaSquadra[a] ? eloStoriaSquadra[a].at(-1) : null).filter(x => x !== null && x !== undefined); return v.length ? media(v) : null; };
    // gli avversari li teniamo in una lista parallela
    const avversariCasa = (storiaSquadra[`${casa}__avv`] || []);
    const avversariOspite = (storiaSquadra[`${ospite}__avv`] || []);

    const kCasa = `${casa}|${p.season}`, kOspite = `${ospite}|${p.season}`;
    const matchdayHome = (contaStagionale[kCasa] || 0) + 1, matchdayAway = (contaStagionale[kOspite] || 0) + 1;

    const promossaCasa = stagioniOrdine.indexOf(p.season) > 0 && !squadrePerStagione[stagioniOrdine[stagioniOrdine.indexOf(p.season) - 1]]?.has(casa) ? 1 : 0;
    const promossaOspite = stagioniOrdine.indexOf(p.season) > 0 && !squadrePerStagione[stagioniOrdine[stagioniOrdine.indexOf(p.season) - 1]]?.has(ospite) ? 1 : 0;

    const daysSincePrevHome = ultimaData[casa] ? Math.round((p.dataObj - ultimaData[casa]) / 864e5) : null;
    const daysSincePrevAway = ultimaData[ospite] ? Math.round((p.dataObj - ultimaData[ospite]) / 864e5) : null;

    const target = p.goals_home > p.goals_away ? 'H' : p.goals_home < p.goals_away ? 'A' : 'D';

    // scrive la riga SOLO se entrambe le squadre hanno almeno un minimo di storico
    // (altrimenti troppi null per essere utile, e coerente col MINIMO_STORICO di Dixon-Coles)
    if (storiaCasa.length >= 5 && storiaOspite.length >= 5) {
      righeCsv.push({
        match_id: p.match_id, league: lega.nome, season: p.season, date: p.date, split, target,
        home_team: casa, away_team: ospite,
        ...Object.fromEntries(FINESTRE_FORMA.map(n => [`home_xg_last${n}`, xgCasa[`last${n}`]])), home_xg_season: xgCasa.season,
        ...Object.fromEntries(FINESTRE_FORMA.map(n => [`home_xga_last${n}`, xgaCasa[`last${n}`]])), home_xga_season: xgaCasa.season,
        ...Object.fromEntries(FINESTRE_FORMA.map(n => [`home_npxg_last${n}`, finCasa[`last${n}`]?.npxG])), home_npxg_season: finCasa.season?.npxG,
        ...Object.fromEntries(FINESTRE_FORMA.map(n => [`home_npxga_last${n}`, finCasa[`last${n}`]?.npxGA])), home_npxga_season: finCasa.season?.npxGA,
        ...Object.fromEntries(FINESTRE_FORMA.map(n => [`away_xg_last${n}`, xgOspite[`last${n}`]])), away_xg_season: xgOspite.season,
        ...Object.fromEntries(FINESTRE_FORMA.map(n => [`away_xga_last${n}`, xgaOspite[`last${n}`]])), away_xga_season: xgaOspite.season,
        ...Object.fromEntries(FINESTRE_FORMA.map(n => [`away_npxg_last${n}`, finOspite[`last${n}`]?.npxG])), away_npxg_season: finOspite.season?.npxG,
        ...Object.fromEntries(FINESTRE_FORMA.map(n => [`away_npxga_last${n}`, finOspite[`last${n}`]?.npxGA])), away_npxga_season: finOspite.season?.npxGA,
        xg_diff_last10: (xgCasa.last10 ?? 0) - (xgOspite.last10 ?? 0),
        xga_diff_last10: (xgaCasa.last10 ?? 0) - (xgaOspite.last10 ?? 0),
        npxgd_diff_season: (finCasa.season?.npxGD ?? 0) - (finOspite.season?.npxGD ?? 0),
        elo_before_home: eloBeforeHome, elo_before_away: eloBeforeAway, elo_diff: eloBeforeHome - eloBeforeAway,
        elo_trend_home: eloTrendHome, elo_trend_away: eloTrendAway,
        xpoints_delta_home: xpCasa.delta, xpoints_delta_away: xpOspite.delta,
        ppda_home_last10: ppdaCasa.last10, ppda_away_last10: ppdaOspite.last10,
        deep_home_last10: deepCasa.last10, deep_away_last10: deepOspite.last10,
        strength_of_schedule_home: sosDi(avversariCasa), strength_of_schedule_away: sosDi(avversariOspite),
        league_cat: lega.nome, season_phase: matchdayHome <= 10 ? 'early' : matchdayHome <= 28 ? 'mid' : 'late',
        matchday_home: matchdayHome, matchday_away: matchdayAway,
        sample_size_home: storiaCasa.length, sample_size_away: storiaOspite.length,
        promoted_home: promossaCasa, promoted_away: promossaOspite,
        days_since_prev_home: daysSincePrevHome, days_since_prev_away: daysSincePrevAway
      });
    }

    // --- aggiorna stato DOPO aver generato la riga (mai prima)
    storiaSquadra[casa] = [{ date: p.date, h_a: 'h', xG: p.xG_home, xGA: p.xG_away, npxG: p.npxG_home, npxGA: p.npxG_away, npxGD: (p.npxG_home ?? 0) - (p.npxG_away ?? 0), ppda: p.ppda_home, deep: p.deep_home, xpts: p.xpts_home, pts: target === 'H' ? 3 : target === 'D' ? 1 : 0 }, ...storiaCasa];
    storiaSquadra[ospite] = [{ date: p.date, h_a: 'a', xG: p.xG_away, xGA: p.xG_home, npxG: p.npxG_away, npxGA: p.npxG_home, npxGD: (p.npxG_away ?? 0) - (p.npxG_home ?? 0), ppda: p.ppda_away, deep: p.deep_away, xpts: p.xpts_away, pts: target === 'A' ? 3 : target === 'D' ? 1 : 0 }, ...storiaOspite];
    storiaSquadra[`${casa}__avv`] = [...avversariCasa, ospite];
    storiaSquadra[`${ospite}__avv`] = [...avversariOspite, casa];
    contaStagionale[kCasa] = matchdayHome; contaStagionale[kOspite] = matchdayAway;
    ultimaData[casa] = p.dataObj; ultimaData[ospite] = p.dataObj;

    const rElo = aggiornaElo(eloAttuale[casa], eloAttuale[ospite], p.goals_home, p.goals_away, ELO);
    eloAttuale[casa] = rElo.eloCasaDopo; eloAttuale[ospite] = rElo.eloOspiteDopo;
    eloStoriaSquadra[casa] = [...(eloStoriaSquadra[casa] || []), eloAttuale[casa]];
    eloStoriaSquadra[ospite] = [...(eloStoriaSquadra[ospite] || []), eloAttuale[ospite]];
  }
}

// ---------------------------------------------------------------- scrivi CSV
function csvValue(v) { if (v === null || v === undefined) return ''; if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`; return v; }
const linee = [colonne.join(',')];
for (const r of righeCsv) linee.push(colonne.map(c => csvValue(r[c])).join(','));
writeFileSync('data/dataset/ml-features.csv', linee.join('\n'));

const perSplit = {}; for (const r of righeCsv) perSplit[r.split] = (perSplit[r.split] || 0) + 1;
console.log(`Righe totali: ${righeCsv.length}`, JSON.stringify(perSplit));
console.log(`Colonne: ${colonne.length}`);
console.log('Salvato: data/dataset/ml-features.csv');
