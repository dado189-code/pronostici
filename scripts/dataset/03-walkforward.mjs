// scripts/dataset/03-walkforward.mjs
// STEP 8+10: genera le previsioni MODEL A (xG, football-v1-baseline) e
// MODEL B (npxG, football-v2-understat) partita per partita, usando per
// ognuna SOLO le partite precedenti nello stesso storico (nessun leakage).
//
// Come nel backtest esistente (scripts/backtest.mjs), le forze si ricalcolano
// ogni CHECKPOINT partite invece che per ognuna: i rating non cambiano nel
// mezzo di una giornata di campionato, e ricalcolare 200 iterazioni di punto
// fisso per ogni singola partita renderebbe il backtest su ~5000 partite
// proibitivo senza cambiare il risultato in modo apprezzabile.
//
// Nessuna chiamata di rete qui: tutto legge data/normalized/, gia' scaricato
// e unito offline (STEP 23).

import { readFileSync, writeFileSync } from 'node:fs';
import { stimaForze, stimaRho, lambde, mercati, consenso } from '../model.mjs';
import { MODELLO } from '../config.mjs';
import { LEGHE, STAGIONI } from './00-config.mjs';

const CHECKPOINT = 10;
const MINIMO_STORICO = 100; // partite indietro prima di iniziare a prevedere

const dataset = JSON.parse(readFileSync('data/normalized/dataset-matched.json', 'utf8')).partite;

// no-vig proporzionale dalle quote di chiusura: qui il "book" e' uno solo
// (quello riportato dal CSV, gia' la migliore fonte disponibile per riga),
// quindi la normalizzazione a somma 1 e' l'intero passo, niente media fra piu' book.
function noVig(qCasa, qX, qOsp) {
  if (!(qCasa > 1 && qX > 1 && qOsp > 1)) return null;
  const s = 1 / qCasa + 1 / qX + 1 / qOsp;
  return { P1: (1 / qCasa) / s, PX: (1 / qX) / s, P2: (1 / qOsp) / s };
}

const previsioni = [];
const perLega = {};

for (const lega of LEGHE) {
  const partiteLega = dataset
    .filter(r => r.league === lega.nome)
    .map(r => ({
      ...r,
      data: new Date(r.date),
      casa: r.home_team, ospite: r.away_team,
      xgCasa: r.xG_home, xgOspite: r.xG_away,
      npxgCasa: r.npxG_home, npxgOspite: r.npxG_away,
      golCasa: r.goals_home, golOspite: r.goals_away
    }))
    .sort((a, b) => a.data - b.data);

  perLega[lega.nome] = { totali: partiteLega.length, previste: 0 };

  let cacheA = null, cacheB = null, ultimoCheckpoint = -1;

  for (let i = MINIMO_STORICO; i < partiteLega.length; i++) {
    const p = partiteLega[i];
    const storico = partiteLega.slice(0, i); // rigorosamente solo il passato

    if (i - ultimoCheckpoint >= CHECKPOINT || !cacheA) {
      const forzeA = stimaForze(storico, { emivita: MODELLO.emivitaGiorni, oggi: p.data, campoXG: 'xg' });
      const rhoA = stimaRho(storico.slice(-300), forzeA, MODELLO);
      const forzeB = stimaForze(storico, { emivita: MODELLO.emivitaGiorni, oggi: p.data, campoXG: 'npxg' });
      const rhoB = stimaRho(storico.slice(-300), forzeB, MODELLO);
      cacheA = { forze: forzeA, rho: rhoA }; cacheB = { forze: forzeB, rho: rhoB };
      ultimoCheckpoint = i;
    }

    const lA = lambde(cacheA.forze, p.casa, p.ospite);
    const lB = lambde(cacheB.forze, p.casa, p.ospite);
    if (!lA.lh || !lA.la || !lB.lh || !lB.la) continue; // squadra ancora senza rating stabile

    const mkA = mercati(lA.lh, lA.la, cacheA.rho);
    const mkB = mercati(lB.lh, lB.la, cacheB.rho);
    const nv = noVig(p.closing_home, p.closing_draw, p.closing_away);

    const esito = p.golCasa > p.golOspite ? 'H' : p.golCasa < p.golOspite ? 'A' : 'D';

    previsioni.push({
      match_id: p.match_id, league: lega.nome, season: p.season, date: p.date,
      home_team: p.casa, away_team: p.ospite,
      goals_home: p.golCasa, goals_away: p.golOspite, esito,
      n_storico: storico.length,
      modelA: { lambda_home: +lA.lh.toFixed(4), lambda_away: +lA.la.toFixed(4),
        P1: +mkA['1'].toFixed(4), PX: +mkA['X'].toFixed(4), P2: +mkA['2'].toFixed(4), rho: +cacheA.rho.toFixed(4) },
      modelB: { lambda_home: +lB.lh.toFixed(4), lambda_away: +lB.la.toFixed(4),
        P1: +mkB['1'].toFixed(4), PX: +mkB['X'].toFixed(4), P2: +mkB['2'].toFixed(4), rho: +cacheB.rho.toFixed(4) },
      market: nv ? { P1: +nv.P1.toFixed(4), PX: +nv.PX.toFixed(4), P2: +nv.P2.toFixed(4),
        closing_home: p.closing_home, closing_draw: p.closing_draw, closing_away: p.closing_away,
        opening_home: p.opening_home, opening_draw: p.opening_draw, opening_away: p.opening_away } : null
    });
    perLega[lega.nome].previste++;
  }
  console.log(`${lega.nome}: ${perLega[lega.nome].previste}/${perLega[lega.nome].totali} partite previste (walk-forward)`);
}

writeFileSync('data/dataset/previsioni-walkforward.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  checkpoint: CHECKPOINT, minimoStorico: MINIMO_STORICO,
  nota: 'Le forze si ricalcolano ogni ' + CHECKPOINT + ' partite, non a ogni previsione: '
    + 'i rating non cambiano nel mezzo di una giornata di campionato. Ogni previsione usa '
    + 'esclusivamente partite con data precedente alla partita prevista (nessun leakage).',
  perLega,
  previsioni
}, null, 1));

console.log(`\nTotale previsioni: ${previsioni.length}`);
