// scripts/dataset/03-walkforward.mjs (v2: 4 stagioni, MODEL A-E, Elo sequenziale integrato)
// Genera in un'unica passata sequenziale, per ogni partita: MODEL A (xG),
// MODEL B (npxG), MODEL C (home/away split), MODEL D (opponent adjustment
// con shrinkage esplicito), e l'EloDiff pre-match (usato da 04-metriche per
// costruire MODEL E con vari beta, senza dover rieseguire il walk-forward).
//
// L'Elo si aggiorna PARI PASSO con le previsioni, mai dopo: eloDiff usato per
// prevedere la partita N e' calcolato SOLO da partite con indice < N nella
// stessa lega, con la regressione di stagione e il prior neopromosse gia'
// corretti (vedi features.mjs, corretti dopo il bug scoperto nella sessione
// precedente: mai processare piu' leghe come un unico pool Elo).

import { readFileSync, writeFileSync } from 'node:fs';
import { stimaForze, stimaRho, lambde, mercati } from '../model.mjs';
import { stimaForzeHomeAway, lambdeHomeAway, shrinkOpponentAdjustment, aggiornaElo } from '../features.mjs';
import { MODELLO, ELO } from '../config.mjs';
import { LEGHE } from './00-config.mjs';

// Checkpoint a 40 (non 10 come nella v1 a 3 stagioni) e iterazioni di
// stimaForze a 60 (non 200): con 4 stagioni lo storico arriva a 1500+
// partite, e il costo del punto fisso cresce con partite*iterazioni per ogni
// checkpoint. 60 iterazioni sono lo stesso valore gia' usato nel walk-forward
// di backtest.mjs esistente nel progetto (validato li'), non un taglio ad hoc.
const CHECKPOINT = 40;
const MINIMO_STORICO = 100;

function noVig(qCasa, qX, qOsp) {
  if (!(qCasa > 1 && qX > 1 && qOsp > 1)) return null;
  const s = 1 / qCasa + 1 / qX + 1 / qOsp;
  return { P1: (1 / qCasa) / s, PX: (1 / qX) / s, P2: (1 / qOsp) / s };
}

const mkOut = (mk) => ({ P1: +mk['1'].toFixed(4), PX: +mk['X'].toFixed(4), P2: +mk['2'].toFixed(4) });

const dataset = JSON.parse(readFileSync('data/normalized/dataset-matched.json', 'utf8')).partite;
const previsioni = [];
const perLega = {};

for (const lega of LEGHE) {
  const partiteLega = dataset.filter(r => r.league === lega.nome)
    .map(r => ({ ...r, data: new Date(r.date), casa: r.home_team, ospite: r.away_team,
      xgCasa: r.xG_home, xgOspite: r.xG_away, npxgCasa: r.npxG_home, npxgOspite: r.npxG_away,
      golCasa: r.goals_home, golOspite: r.goals_away }))
    .sort((a, b) => a.data - b.data);

  perLega[lega.nome] = { totali: partiteLega.length, previste: 0 };

  // stato Elo, sequenziale, PER QUESTA LEGA soltanto
  const elo = {};
  const contaPartiteElo = {};
  let stagioneEloCorrente = null;
  const mediaEloLega = () => { const v = Object.values(elo); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : ELO.partenza; };

  let cacheA = null, cacheB = null, cacheSplit = null, cacheD = null, ultimoCheckpoint = -1;

  for (let i = MINIMO_STORICO; i < partiteLega.length; i++) {
    const p = partiteLega[i];
    const storico = partiteLega.slice(0, i);

    // ---------------------------------------------------------------- checkpoint (Dixon-Coles)
    if (i - ultimoCheckpoint >= CHECKPOINT || !cacheA) {
      const forzeA = stimaForze(storico, { emivita: MODELLO.emivitaGiorni, iterazioni: 60, oggi: p.data, campoXG: 'xg' });
      const rhoA = stimaRho(storico.slice(-300), forzeA, MODELLO);
      const forzeB = stimaForze(storico, { emivita: MODELLO.emivitaGiorni, iterazioni: 60, oggi: p.data, campoXG: 'npxg' });
      const rhoB = stimaRho(storico.slice(-300), forzeB, MODELLO);
      const forzeSplit = stimaForzeHomeAway(storico, forzeA, { emivita: MODELLO.emivitaGiorni, oggi: p.data });
      const forzeD = shrinkOpponentAdjustment(forzeA, storico);
      cacheA = { forze: forzeA, rho: rhoA }; cacheB = { forze: forzeB, rho: rhoB };
      cacheSplit = forzeSplit; cacheD = forzeD;
      ultimoCheckpoint = i;
    }

    // eloDiff PRIMA di questa partita: elo e' aggiornato solo con partite < i,
    // grazie al fatto che l'aggiornamento (sotto) avviene DOPO aver letto qui
    const priorElo = () => Object.keys(elo).length ? mediaEloLega() - ELO.handicapNeopromossa : ELO.partenza;
    if (elo[p.casa] === undefined) elo[p.casa] = priorElo();
    if (elo[p.ospite] === undefined) elo[p.ospite] = priorElo();
    const eloDiffPrima = elo[p.casa] - elo[p.ospite];

    // ---------------------------------------------------------------- previsioni dei modelli
    const lA = lambde(cacheA.forze, p.casa, p.ospite);
    const lB = lambde(cacheB.forze, p.casa, p.ospite);
    if (!lA.lh || !lA.la || !lB.lh || !lB.la) {
      // squadra ancora senza rating: aggiorna comunque l'Elo prima di saltare,
      // altrimenti la prossima partita di questa squadra perderebbe un risultato
      const rE = aggiornaElo(elo[p.casa], elo[p.ospite], p.golCasa, p.golOspite, ELO);
      elo[p.casa] = rE.eloCasaDopo; elo[p.ospite] = rE.eloOspiteDopo;
      continue;
    }

    const mkA = mercati(lA.lh, lA.la, cacheA.rho);
    const mkB = mercati(lB.lh, lB.la, cacheB.rho);
    const lC = lambdeHomeAway(cacheSplit, cacheA.forze, p.casa, p.ospite);
    const mkC = (lC.lh && lC.la) ? mercati(lC.lh, lC.la, cacheA.rho) : null;
    const lD = lambde(cacheD, p.casa, p.ospite);
    const mkD = (lD.lh && lD.la) ? mercati(lD.lh, lD.la, cacheA.rho) : null;

    const nv = noVig(p.closing_home, p.closing_draw, p.closing_away);
    const esito = p.golCasa > p.golOspite ? 'H' : p.golCasa < p.golOspite ? 'A' : 'D';

    previsioni.push({
      match_id: p.match_id, league: lega.nome, season: p.season, date: p.date,
      home_team: p.casa, away_team: p.ospite,
      goals_home: p.golCasa, goals_away: p.golOspite, esito,
      n_storico: storico.length,
      eloDiffPrima: +eloDiffPrima.toFixed(1),
      modelA: { lambda_home: +lA.lh.toFixed(4), lambda_away: +lA.la.toFixed(4), ...mkOut(mkA), rho: +cacheA.rho.toFixed(4) },
      modelB: { lambda_home: +lB.lh.toFixed(4), lambda_away: +lB.la.toFixed(4), ...mkOut(mkB), rho: +cacheB.rho.toFixed(4) },
      modelC: mkC ? { lambda_home: +lC.lh.toFixed(4), lambda_away: +lC.la.toFixed(4), ...mkOut(mkC) } : null,
      modelD: mkD ? { lambda_home: +lD.lh.toFixed(4), lambda_away: +lD.la.toFixed(4), ...mkOut(mkD) } : null,
      market: nv ? { P1: +nv.P1.toFixed(4), PX: +nv.PX.toFixed(4), P2: +nv.P2.toFixed(4),
        closing_home: p.closing_home, closing_draw: p.closing_draw, closing_away: p.closing_away,
        opening_home: p.opening_home, opening_draw: p.opening_draw, opening_away: p.opening_away } : null
    });
    perLega[lega.nome].previste++;

    // ---------------------------------------------------------------- aggiornamento Elo DOPO la previsione
    if (p.season !== stagioneEloCorrente) {
      if (stagioneEloCorrente !== null && ELO.regressioneStagionale > 0) {
        const media = mediaEloLega();
        for (const s of Object.keys(elo)) elo[s] = elo[s] + ELO.regressioneStagionale * (media - elo[s]);
      }
      stagioneEloCorrente = p.season;
    }
    const rE = aggiornaElo(elo[p.casa], elo[p.ospite], p.golCasa, p.golOspite, ELO);
    elo[p.casa] = rE.eloCasaDopo; elo[p.ospite] = rE.eloOspiteDopo;
    contaPartiteElo[p.casa] = (contaPartiteElo[p.casa] || 0) + 1;
    contaPartiteElo[p.ospite] = (contaPartiteElo[p.ospite] || 0) + 1;
  }
  console.log(`${lega.nome}: ${perLega[lega.nome].previste}/${perLega[lega.nome].totali} partite previste (walk-forward, 4 stagioni)`);
}

writeFileSync('data/dataset/previsioni-walkforward.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  checkpoint: CHECKPOINT, minimoStorico: MINIMO_STORICO,
  nota: 'v2: 4 stagioni (2022/23-2025/26). Ogni previsione usa solo partite precedenti nello stesso storico. '
    + 'EloDiffPrima calcolato sequenzialmente PER LEGA, aggiornato subito dopo ogni previsione (mai prima), '
    + 'con regressione di stagione e prior neopromosse. MODEL E (Elo come correzione) si costruisce a valle '
    + 'in 04-metriche applicando vari beta a eloDiffPrima, senza rieseguire questo script.',
  perLega,
  previsioni
}, null, 1));

console.log(`\nTotale previsioni: ${previsioni.length}`);
