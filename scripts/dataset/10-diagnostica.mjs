// scripts/dataset/10-diagnostica.mjs
// FASE 5, parte economica: tutte le analisi che non richiedono un nuovo
// walk-forward completo, perche' usano dati gia' generati (dataset
// normalizzato + previsioni-walkforward.json). Copre i punti 6-9, 11-16
// della richiesta. I punti che richiedono un nuovo giro walk-forward
// (decay esteso, Elo tuning, v2-candidate) stanno in script separati.

import { readFileSync, writeFileSync } from 'node:fs';
import { poisson, tau } from '../model.mjs';
import { LEGHE, SPLIT } from './00-config.mjs';

const dataset = JSON.parse(readFileSync('data/normalized/dataset-matched.json', 'utf8')).partite;
const wf = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
const splitDi = (data) => data < SPLIT.trainFino ? 'TRAIN' : data <= SPLIT.validationFino ? 'VALIDATION' : 'TEST';
const testRows = wf.previsioni.filter(p => splitDi(p.date) === 'TEST');

function oneHot(e) { return e === 'H' ? [1, 0, 0] : e === 'D' ? [0, 1, 0] : [0, 0, 1]; }
function brierRow(ph, pd, pa, e) { const [oh, od, oa] = oneHot(e); return (ph - oh) ** 2 + (pd - od) ** 2 + (pa - oa) ** 2; }
function media(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

const out = {};

// ---------------------------------------------------------------- 6/7/8: goals vs xG, finishing/defensive persistence
{
  const perSquadraStagione = {}; // "lega|stagione|squadra" -> {gol,xg,npxg,ga,xga}
  for (const r of dataset) {
    for (const [sq, gol, xg, npxg, ga, xga] of [
      [r.home_team, r.goals_home, r.xG_home, r.npxG_home, r.goals_away, r.xG_away],
      [r.away_team, r.goals_away, r.xG_away, r.npxG_away, r.goals_home, r.xG_home]
    ]) {
      const k = `${r.league}|${r.season}|${sq}`;
      const acc = perSquadraStagione[k] ||= { lega: r.league, stagione: r.season, squadra: sq, gol: 0, xg: 0, npxg: 0, ga: 0, xga: 0, n: 0 };
      acc.gol += gol; acc.xg += xg ?? 0; acc.npxg += npxg ?? 0; acc.ga += ga; acc.xga += xga ?? 0; acc.n++;
    }
  }
  const righe = Object.values(perSquadraStagione).filter(r => r.n >= 20);
  for (const r of righe) { r.finishing = r.gol - r.xg; r.finishingNp = r.gol - r.npxg; r.defOver = r.ga - r.xga; }

  // persistenza stagione-su-stagione: correlazione fra finishing_delta di anno N e anno N+1, stessa squadra
  function correlazione(coppie) {
    const n = coppie.length; if (n < 5) return null;
    const mx = media(coppie.map(c => c[0])), my = media(coppie.map(c => c[1]));
    let num = 0, dx = 0, dy = 0;
    for (const [x, y] of coppie) { num += (x - mx) * (y - my); dx += (x - mx) ** 2; dy += (y - my) ** 2; }
    return (dx > 0 && dy > 0) ? +(num / Math.sqrt(dx * dy)).toFixed(3) : null;
  }
  const ordineStagioni = ['2022/23', '2023/24', '2024/25', '2025/26'];
  const coppieFinishing = [], coppieFinishingNp = [], coppieDef = [];
  for (const r of righe) {
    const idx = ordineStagioni.indexOf(r.stagione); if (idx < 0 || idx === ordineStagioni.length - 1) continue;
    const succ = righe.find(x => x.squadra === r.squadra && x.lega === r.lega && x.stagione === ordineStagioni[idx + 1]);
    if (succ) { coppieFinishing.push([r.finishing, succ.finishing]); coppieFinishingNp.push([r.finishingNp, succ.finishingNp]); coppieDef.push([r.defOver, succ.defOver]); }
  }
  out.finishing_persistence = {
    n_coppie_anno_su_anno: coppieFinishing.length,
    correlazione_goals_meno_xG: correlazione(coppieFinishing),
    correlazione_goals_meno_npxG: correlazione(coppieFinishingNp),
    interpretazione: 'correlazione vicina a 0 = nessuna abilita persistente nel finishing, e regressione totale verso xG e corretta; '
      + 'correlazione chiaramente positiva (es. >0.3) suggerirebbe una componente di abilita da NON azzerare del tutto'
  };
  out.defensive_overperformance_persistence = {
    n_coppie_anno_su_anno: coppieDef.length,
    correlazione_GA_meno_xGA: correlazione(coppieDef),
    interpretazione: 'stessa logica del finishing, sul lato difensivo/portiere'
  };
}

// ---------------------------------------------------------------- 9: league baselines
{
  out.league_baselines = {};
  for (const lega of LEGHE) {
    out.league_baselines[lega.nome] = {};
    for (const stagione of [...new Set(dataset.map(r => r.season))].sort()) {
      const righe = dataset.filter(r => r.league === lega.nome && r.season === stagione);
      if (!righe.length) continue;
      out.league_baselines[lega.nome][stagione] = {
        n: righe.length,
        gol_medi_tot: +media(righe.map(r => r.goals_home + r.goals_away)).toFixed(3),
        xg_medio_tot: +media(righe.map(r => (r.xG_home ?? 0) + (r.xG_away ?? 0))).toFixed(3),
        gol_medi_casa: +media(righe.map(r => r.goals_home)).toFixed(3),
        gol_medi_trasferta: +media(righe.map(r => r.goals_away)).toFixed(3),
        xg_medio_casa: +media(righe.map(r => r.xG_home ?? 0)).toFixed(3),
        xg_medio_trasferta: +media(righe.map(r => r.xG_away ?? 0)).toFixed(3),
        vantaggio_casa_gol: +(media(righe.map(r => r.goals_home)) - media(righe.map(r => r.goals_away))).toFixed(3)
      };
    }
  }
}

// ---------------------------------------------------------------- 11: promoted teams
{
  const squadrePerStagione = {};
  for (const r of dataset) {
    const k = `${r.league}|${r.season}`;
    (squadrePerStagione[k] ||= new Set()).add(r.home_team).add(r.away_team);
  }
  const ordineStagioni = ['2022/23', '2023/24', '2024/25', '2025/26'];
  const promosse = new Set(); // "lega|stagione|squadra"
  for (const lega of LEGHE) {
    for (let i = 1; i < ordineStagioni.length; i++) {
      const attuali = squadrePerStagione[`${lega.nome}|${ordineStagioni[i]}`] || new Set();
      const precedenti = squadrePerStagione[`${lega.nome}|${ordineStagioni[i - 1]}`] || new Set();
      for (const sq of attuali) if (!precedenti.has(sq)) promosse.add(`${lega.nome}|${ordineStagioni[i]}|${sq}`);
    }
  }

  // per ogni partita di una promossa nel TEST, quante partite ha gia' giocato in quella stagione (contando anche fuori dal TEST)
  const contaStagionale = {};
  const datasetOrdinato = [...dataset].sort((a, b) => new Date(a.date) - new Date(b.date));
  const fasceErrore = { '1-5': [], '6-10': [], '11-15': [], 'oltre15': [] };
  for (const r of datasetOrdinato) {
    for (const sq of [r.home_team, r.away_team]) {
      const k = `${r.league}|${r.season}|${sq}`;
      contaStagionale[k] = (contaStagionale[k] || 0) + 1;
    }
  }
  // ricalcola l'indice PRIMA di incrementare, serve per sapere "che partita numero e' questa per la squadra"
  const contaProgressivo = {};
  for (const r of testRows) {
    for (const [sq, casa] of [[r.home_team, true], [r.away_team, false]]) {
      const kProm = `${r.league}|2025/26|${sq}`;
      if (!promosse.has(kProm)) continue;
      const kProg = `${r.league}|2025/26|${sq}`;
      contaProgressivo[kProg] = (contaProgressivo[kProg] || 0) + 1;
      const numPartita = contaProgressivo[kProg];
      const prob = casa ? r.modelA.P1 : r.modelA.P2;
      const err = brierRow(r.modelA.P1, r.modelA.PX, r.modelA.P2, r.esito);
      const fascia = numPartita <= 5 ? '1-5' : numPartita <= 10 ? '6-10' : numPartita <= 15 ? '11-15' : 'oltre15';
      fasceErrore[fascia].push(err);
    }
  }
  out.promoted_teams_TEST = {
    squadre_promosse_2025_26: [...promosse].filter(k => k.endsWith('|2025/26'.split('|').pop()) || k.includes('|2025/26|')).map(k => k.split('|')[2]),
    brier_medio_per_fascia_partite_giocate: Object.fromEntries(Object.entries(fasceErrore).map(([f, v]) => [f, { n: v.length, brier_medio: media(v) !== null ? +media(v).toFixed(4) : null }])),
    brier_medio_generale_TEST: +media(testRows.map(r => brierRow(r.modelA.P1, r.modelA.PX, r.modelA.P2, r.esito))).toFixed(4)
  };
}

// ---------------------------------------------------------------- 12: early season phase (tutte le squadre, non solo promosse)
{
  const contaProgressivo = {};
  const fasce = { '1-5': [], '6-10': [], '11-20': [], 'oltre20': [] };
  for (const r of testRows) {
    for (const sq of [r.home_team, r.away_team]) {
      const k = `${r.league}|2025/26|${sq}`;
      contaProgressivo[k] = (contaProgressivo[k] || 0) + 1;
    }
    // usa il massimo fra casa/ospite come proxy della "fase stagione" della partita
    const num = Math.max(contaProgressivo[`${r.league}|2025/26|${r.home_team}`], contaProgressivo[`${r.league}|2025/26|${r.away_team}`]);
    const err = brierRow(r.modelA.P1, r.modelA.PX, r.modelA.P2, r.esito);
    const fascia = num <= 5 ? '1-5' : num <= 10 ? '6-10' : num <= 20 ? '11-20' : 'oltre20';
    fasce[fascia].push(err);
  }
  out.early_season_TEST = Object.fromEntries(Object.entries(fasce).map(([f, v]) => [f, { n: v.length, brier_medio: v.length ? +media(v).toFixed(4) : null }]));
}

// ---------------------------------------------------------------- 13: error segmentation
{
  const segmenti = {};
  const add = (categoria, chiave, err) => { (segmenti[categoria] ||= {})[chiave] ||= []; segmenti[categoria][chiave].push(err); };
  for (const r of testRows) {
    const err = brierRow(r.modelA.P1, r.modelA.PX, r.modelA.P2, r.esito);
    add('per_lega', r.league, err);
    add('per_esito', r.esito === 'H' ? 'casa vince' : r.esito === 'D' ? 'pareggio' : 'trasferta vince', err);
    const favorito = r.modelA.P1 > r.modelA.P2 ? (r.modelA.P1 > r.modelA.PX ? 'H' : 'X') : (r.modelA.P2 > r.modelA.PX ? 'A' : 'X');
    add('favorito_vince', favorito === r.esito ? 'si' : 'no', err);
    const eloAbs = Math.abs(r.eloDiffPrima ?? 0);
    add('scarto_elo', eloAbs < 50 ? 'piccolo (<50)' : eloAbs < 150 ? 'medio (50-150)' : 'grande (>150)', err);
    const totGolAtteso = r.modelA.lambda_home + r.modelA.lambda_away;
    add('gol_attesi_totali', totGolAtteso < 2.3 ? 'bassi (<2.3)' : totGolAtteso < 2.8 ? 'medi (2.3-2.8)' : 'alti (>2.8)', err);
  }
  out.error_segmentation_TEST = {};
  for (const [cat, gruppi] of Object.entries(segmenti))
    out.error_segmentation_TEST[cat] = Object.fromEntries(Object.entries(gruppi).map(([k, v]) => [k, { n: v.length, brier_medio: +media(v).toFixed(4) }]));
}

// ---------------------------------------------------------------- 14: draw model
{
  const drawRows = testRows;
  const brierDraw = media(drawRows.map(r => (r.modelA.PX - (r.esito === 'D' ? 1 : 0)) ** 2));
  const brierDrawMkt = media(drawRows.filter(r => r.market).map(r => (r.market.PX - (r.esito === 'D' ? 1 : 0)) ** 2));
  // calibrazione pareggio a bucket
  const bucket = Array.from({ length: 10 }, (_, i) => ({ da: i * 10, a: (i + 1) * 10, n: 0, sommaP: 0, positivi: 0 }));
  for (const r of drawRows) { const idx = Math.min(9, Math.floor(r.modelA.PX * 10)); bucket[idx].n++; bucket[idx].sommaP += r.modelA.PX; if (r.esito === 'D') bucket[idx].positivi++; }
  // frequenza reale del pareggio vs rho medio usato
  const freqDrawReale = +(drawRows.filter(r => r.esito === 'D').length / drawRows.length * 100).toFixed(1);
  const pxMediaModello = +(media(drawRows.map(r => r.modelA.PX)) * 100).toFixed(1);
  const rhoMedio = +media(drawRows.map(r => r.modelA.rho)).toFixed(4);
  out.draw_analysis_TEST = {
    brier_draw_modello: +brierDraw.toFixed(4), brier_draw_mercato: +brierDrawMkt.toFixed(4),
    frequenza_pareggio_reale_pct: freqDrawReale, probabilita_media_prevista_pct: pxMediaModello,
    rho_medio_usato: rhoMedio,
    bucket: bucket.filter(b => b.n > 0).map(b => ({ fascia: `${b.da}-${b.a}%`, n: b.n, prevista: +(b.sommaP / b.n * 100).toFixed(1), osservata: +(b.positivi / b.n * 100).toFixed(1) })),
    interpretazione: pxMediaModello < freqDrawReale
      ? 'il modello SOTTOSTIMA la probabilita di pareggio in media: rho o il bilanciamento lambda potrebbero non catturare abbastanza la parita fra squadre'
      : 'il modello SOVRASTIMA la probabilita di pareggio in media'
  };
}

// ---------------------------------------------------------------- 15: score matrix truncation
{
  // usa lambda tipici (media TEST) per stimare la massa persa oltre 10 gol per squadra
  const lhMedio = media(testRows.map(r => r.modelA.lambda_home));
  const laMedio = media(testRows.map(r => r.modelA.lambda_away));
  let dentro = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) dentro += poisson(i, lhMedio) * poisson(j, laMedio);
  out.score_matrix_truncation = {
    lambda_home_medio_TEST: +lhMedio.toFixed(3), lambda_away_medio_TEST: +laMedio.toFixed(3),
    massa_probabilita_dentro_11x11_pct: +(dentro * 100).toFixed(4),
    massa_persa_pct: +((1 - dentro) * 100).toFixed(4),
    conclusione: (1 - dentro) < 0.001 ? 'trascurabile, 11x11 e sufficiente' : 'non trascurabile, valutare una matrice piu ampia'
  };
}

// ---------------------------------------------------------------- 16: rho robustness
{
  const rhoAnalisi = JSON.parse(readFileSync('data/backtests/analisi-rho.json', 'utf8'));
  const rhoDecayFile = JSON.parse(readFileSync('data/backtests/decay-rho.json', 'utf8'));
  out.rho_robustness = {
    rho_per_lega_train_validation_2024_25: rhoAnalisi.perLega, // dalla v1 (fino a 2024/25)
    rho_per_lega_train_validation_2025_26: rhoDecayFile.rhoPerLega, // dalla v2 (fino a 2025/26)
    nota: 'confronto fra la stima con TRAIN+VALIDATION fino a fine 2024/25 (prima estensione) e fino a fine 2025/26 '
      + '(seconda estensione, un anno di dati in piu): se il rho ottimale si sposta molto da una stima all altra, '
      + 'e un segnale di instabilita season-to-season che sconsiglia un rho iper-specifico per lega'
  };
  const spostamenti = {};
  for (const lega of LEGHE) {
    const a = rhoAnalisi.perLega[lega.nome]?.rho_ottimo, b = rhoDecayFile.rhoPerLega[lega.nome]?.rho_ottimo;
    if (a !== undefined && b !== undefined) spostamenti[lega.nome] = { stima_fino_2024_25: a, stima_fino_2025_26: b, spostamento: +(b - a).toFixed(4) };
  }
  out.rho_robustness.spostamento_stagione_su_stagione = spostamenti;
}

writeFileSync('data/backtests/diagnostica-fase5.json', JSON.stringify({ generato_il: new Date().toISOString(), ...out }, null, 1));

console.log('Finishing persistence (corr goals-xG anno su anno):', out.finishing_persistence.correlazione_goals_meno_xG,
  '| defensive:', out.defensive_overperformance_persistence.correlazione_GA_meno_xGA);
console.log('Draw: Brier modello', out.draw_analysis_TEST.brier_draw_modello, 'vs mercato', out.draw_analysis_TEST.brier_draw_mercato,
  '| prob media modello', out.draw_analysis_TEST.probabilita_media_prevista_pct + '%', 'vs frequenza reale', out.draw_analysis_TEST.frequenza_pareggio_reale_pct + '%');
console.log('Score matrix: massa persa oltre 11x11 =', out.score_matrix_truncation.massa_persa_pct + '%');
console.log('Rho spostamento stagione su stagione:', JSON.stringify(out.rho_robustness.spostamento_stagione_su_stagione));
console.log('Early season Brier per fascia:', JSON.stringify(out.early_season_TEST));
console.log('Promoted teams Brier per fascia partite:', JSON.stringify(out.promoted_teams_TEST.brier_medio_per_fascia_partite_giocate));
