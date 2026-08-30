// scripts/dataset/12-walkforward-v2.mjs
// football-v2-candidate: baseline Dixon-Coles (xG grezzo, invariato) con
// DUE sole modifiche, entrambe scelte SOLO su TRAIN+VALIDATION prima di
// vedere questo script toccare il TEST:
//   1) emivita 365gg invece di 180gg (unico cambio con un supporto minimamente
//      solido: plateau netto su Premier League, guadagno piccolo ma non
//      negativo sulle altre 4 leghe; un decadimento quasi-nullo e' stato
//      scartato nonostante vincesse la ricerca grezza, perche' il margine era
//      trascurabile e la Premier League lo rifiutava con un plateau chiaro)
//   2) correzione Elo ai lambda con i parametri trovati dalla coordinate
//      search (K=10, vantaggioCasa=30, regressione=0.10, handicap=100, beta=0.18)
//
// Un solo modello Dixon-Coles per checkpoint (non cinque come nel v1
// walk-forward): questo giro e' quindi molto piu veloce.

import { readFileSync, writeFileSync } from 'node:fs';
import { stimaForze, stimaRho, lambde, mercati } from '../model.mjs';
import { aggiornaElo, correggiConElo } from '../features.mjs';
import { MODELLO } from '../config.mjs';
import { LEGHE } from './00-config.mjs';

const CHECKPOINT = 40;
const MINIMO_STORICO = 100;
const EMIVITA_V2 = 365;
const ELO_V2 = { partenza: 1500, kFactor: 10, vantaggioCasa: 30, regressioneStagionale: 0.10, handicapNeopromossa: 100, pesoMarginale: true };
const BETA_V2 = 0.18;

function noVig(qc, qx, qo) { if (!(qc > 1 && qx > 1 && qo > 1)) return null; const s = 1 / qc + 1 / qx + 1 / qo; return { P1: (1 / qc) / s, PX: (1 / qx) / s, P2: (1 / qo) / s }; }
const mkOut = mk => ({ P1: +mk['1'].toFixed(4), PX: +mk['X'].toFixed(4), P2: +mk['2'].toFixed(4) });

const dataset = JSON.parse(readFileSync('data/normalized/dataset-matched.json', 'utf8')).partite;
const previsioni = [];

for (const lega of LEGHE) {
  const partite = dataset.filter(r => r.league === lega.nome)
    .map(r => ({ ...r, data: new Date(r.date), casa: r.home_team, ospite: r.away_team,
      xgCasa: r.xG_home, xgOspite: r.xG_away, golCasa: r.goals_home, golOspite: r.goals_away }))
    .sort((a, b) => a.data - b.data);

  const elo = {}; let stagioneCorrente = null;
  const mediaLega = () => { const v = Object.values(elo); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : ELO_V2.partenza; };
  let cache = null, ultimoCheckpoint = -1;
  let n = 0;

  for (let i = MINIMO_STORICO; i < partite.length; i++) {
    const p = partite[i];
    const storico = partite.slice(0, i);

    if (i - ultimoCheckpoint >= CHECKPOINT || !cache) {
      const forze = stimaForze(storico, { emivita: EMIVITA_V2, iterazioni: 60, oggi: p.data, campoXG: 'xg' });
      const rho = stimaRho(storico.slice(-300), forze, MODELLO);
      cache = { forze, rho }; ultimoCheckpoint = i;
    }

    const prior = Object.keys(elo).length ? mediaLega() - ELO_V2.handicapNeopromossa : ELO_V2.partenza;
    if (elo[p.casa] === undefined) elo[p.casa] = prior;
    if (elo[p.ospite] === undefined) elo[p.ospite] = prior;
    const eloDiffPrima = elo[p.casa] - elo[p.ospite];

    const l = lambde(cache.forze, p.casa, p.ospite);
    if (!l.lh || !l.la) {
      const r = aggiornaElo(elo[p.casa], elo[p.ospite], p.golCasa, p.golOspite, ELO_V2);
      elo[p.casa] = r.eloCasaDopo; elo[p.ospite] = r.eloOspiteDopo;
      continue;
    }

    const { lh, la } = correggiConElo(l.lh, l.la, eloDiffPrima, BETA_V2);
    const mk = mercati(lh, la, cache.rho);
    const nv = noVig(p.closing_home, p.closing_draw, p.closing_away);
    const esito = p.golCasa > p.golOspite ? 'H' : p.golCasa < p.golOspite ? 'A' : 'D';

    previsioni.push({
      match_id: p.match_id, league: lega.nome, season: p.season, date: p.date,
      home_team: p.casa, away_team: p.ospite, goals_home: p.golCasa, goals_away: p.golOspite, esito,
      modelV2: { lambda_home: +lh.toFixed(4), lambda_away: +la.toFixed(4), ...mkOut(mk), rho: +cache.rho.toFixed(4) },
      market: nv ? { P1: +nv.P1.toFixed(4), PX: +nv.PX.toFixed(4), P2: +nv.P2.toFixed(4),
        closing_home: p.closing_home, closing_draw: p.closing_draw, closing_away: p.closing_away,
        opening_home: p.opening_home, opening_draw: p.opening_draw, opening_away: p.opening_away } : null
    });
    n++;

    if (p.season !== stagioneCorrente) {
      if (stagioneCorrente !== null && ELO_V2.regressioneStagionale > 0) { const m = mediaLega(); for (const s of Object.keys(elo)) elo[s] += ELO_V2.regressioneStagionale * (m - elo[s]); }
      stagioneCorrente = p.season;
    }
    const r = aggiornaElo(elo[p.casa], elo[p.ospite], p.golCasa, p.golOspite, ELO_V2);
    elo[p.casa] = r.eloCasaDopo; elo[p.ospite] = r.eloOspiteDopo;
  }
  console.log(`${lega.nome}: ${n} previsioni v2`);
}

writeFileSync('data/dataset/previsioni-v2-candidate.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  formula: 'football-v2-candidate = Dixon-Coles su xG grezzo, emivita 365gg (era 180gg), rho per lega '
    + '(MLE su gol veri, invariato), corretto moltiplicativamente da Elo: lambda_home *= exp(beta*eloDiff/400), '
    + 'lambda_away /= exp(beta*eloDiff/400), con beta=0.18. Elo: partenza 1500, K=10, vantaggio casa=30 punti, '
    + 'regressione di stagione 10%, prior neopromossa = media lega - 100, margine di vittoria attivo.',
  parametri: { emivita: EMIVITA_V2, elo: ELO_V2, betaElo: BETA_V2, checkpoint: CHECKPOINT, minimoStorico: MINIMO_STORICO },
  previsioni
}, null, 1));
console.log(`\nTotale previsioni v2: ${previsioni.length}`);
