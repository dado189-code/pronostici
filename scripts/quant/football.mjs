import {fit,validMatch} from '../engine.mjs';
import {stimaForze,stimaRho,lambde, tau} from '../model.mjs';
import {finite, timestamp} from './math.mjs';
export function footballFromRates({homeXG, awayXG, rho = 0, tolerance = 1e-12}) {
  finite(homeXG, 'homeXG', 0.000001, 20); finite(awayXG, 'awayXG', 0.000001, 20);
  finite(rho, 'rho'); finite(tolerance, 'tolleranza', 1e-14, 1e-6);
  for (const [i, j] of [[0,0],[0,1],[1,0],[1,1]]) if (tau(i,j,homeXG,awayXG,rho) < 0) throw new RangeError('Rho produce probabilità negative');
  const poisson = lambda => {
    const p = [Math.exp(-lambda)]; let mass = p[0];
    while (1 - mass > tolerance / 2 && p.length < 200) {p.push(p.at(-1) * lambda / p.length); mass += p.at(-1);}
    if (1 - mass > tolerance / 2) throw new Error('Coda Poisson non convergente');
    return p;
  };
  const h = poisson(homeXG), a = poisson(awayXG);
  const matrix = h.map((v,i) => a.map((w,j) => v * w * tau(i,j,homeXG,awayXG,rho)));
  const mass = matrix.flat().reduce((x,y) => x+y,0);
  const markets = {'1':0, X:0, '2':0, over25:0, under25:0, goal:0, noGoal:0};
  matrix.forEach((row,i) => row.forEach((v,j) => {
    row[j] = v / mass;
    markets[i>j?'1':i===j?'X':'2'] += row[j];
    markets[i+j>2?'over25':'under25'] += row[j];
    markets[i>0&&j>0?'goal':'noGoal'] += row[j];
  }));
  return {version:'dc-xg-adaptive-1', homeXG, awayXG, rho, matrix, markets, omittedMass:Math.max(0,1-mass)};
}
export function fitFootball(history, asOf, {halfLifeDays=60}={}) {
  timestamp(asOf);
  if (!Array.isArray(history)) throw new TypeError('Storico JSON richiesto');
  const ids = new Set();
  const rows = history.map(r => {
    if (typeof r.id !== 'string' || !r.id || ids.has(r.id)) throw new Error('ID partita mancante o duplicato');
    ids.add(r.id); timestamp(r.kickoff); timestamp(r.observedAt);
    if (timestamp(r.observedAt) < timestamp(r.kickoff)) throw new Error('Risultato osservato prima della partita');
    return {...r, data:new Date(r.kickoff), casa:r.home, ospite:r.away, xgCasa:r.homeXG, xgOspite:r.awayXG, golCasa:r.homeGoals, golOspite:r.awayGoals};
  }).filter(r => timestamp(r.observedAt) < timestamp(asOf));
  finite(halfLifeDays,'halfLifeDays',.001,36500);
  if(rows.some(r=>!validMatch(r)))throw new Error('Storico invalido');rows.sort((a,b)=>a.data-b.data);
  if(rows.length<100)throw new Error('Almeno 100 partite richieste');
  const forces=stimaForze(rows,{oggi:new Date(asOf),emivita:halfLifeDays,iterazioni:200});
  const model={forces,rho:stimaRho(rows.slice(-300),forces),trainingMax:rows.at(-1).data.toISOString(),n:rows.length,halfLifeDays};
  if (!model) throw new Error('Almeno 100 partite pregresse richieste');
  return {...model, asOf, observationsMax:rows.reduce((m,r)=>r.observedAt>m?r.observedAt:m,'')};
}
export function predictFootball(model, home, away) {
  if (!model?.forces || home === away || !model.forces.squadre.includes(home) || !model.forces.squadre.includes(away)) throw new Error('Identità squadra non presente nel modello');
  const {lh,la} = lambde(model.forces,home,away);
  return {...footballFromRates({homeXG:lh,awayXG:la,rho:model.rho}), trainingMax:model.trainingMax};
}
