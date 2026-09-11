import {finite, timestamp, solve, normalCDF} from './math.mjs';
const KEYS=['efg','tov','orb','ftRate'];
function factors(x) {
  if(!x)throw new Error('Four Factors mancanti');
  finite(x.efg,'eFG',0,1.5);finite(x.tov,'TOV',0,1);finite(x.orb,'ORB',0,1);finite(x.ftRate,'FT/FGA',0);
  return KEYS.map(k=>x[k]);
}
export function fourFactors(box, opponent, {minutes=48,regulationMinutes=48,freeThrowWeight=0.44}={}) {
  finite(minutes,'minuti',1);finite(regulationMinutes,'durata regolamentare',1);finite(freeThrowWeight,'peso liberi',0,1);
  for(const b of [box,opponent]) {
    if(!b)throw new Error('Box score mancante');
    for(const k of ['fgm','fga','threeMade','ftm','fta','tov','orb','drb']){finite(b[k],k,0);if(!Number.isInteger(b[k]))throw new Error('Box score richiede conteggi interi');}
    if(b.fga===0||b.fgm>b.fga||b.threeMade>b.fgm||b.ftm>b.fta)throw new Error('Box score incoerente');
  }
  const possessions=b=>b.fga+freeThrowWeight*b.fta-b.orb+b.tov;
  const own=possessions(box),opp=possessions(opponent);
  if(own<=0||opp<=0||box.orb+opponent.drb===0)throw new Error('Possessi o opportunità rimbalzo insufficienti');
  const sharedPossessions=(own+opp)/2;
  return {efg:(box.fgm+0.5*box.threeMade)/box.fga,
    tov:box.tov/(box.fga+freeThrowWeight*box.fta+box.tov),
    orb:box.orb/(box.orb+opponent.drb),ftRate:box.ftm/box.fga,
    possessions:sharedPossessions,pace:sharedPossessions*regulationMinutes/minutes,
    points:2*box.fgm+box.threeMade+box.ftm,freeThrowWeight,regulationMinutes};
}
function features(own,allowed,isHome) {
  if(typeof isHome!=='boolean')throw new Error('isHome deve essere booleano');
  return [...factors(own),...factors(allowed),isHome?1:0];
}
export function fitBasketball(rows,{asOf,ridge=1,minSamples=30}={}) {
  const cutoff=timestamp(asOf);finite(ridge,'ridge',0.000001);finite(minSamples,'campione minimo',30);
  if(!Array.isArray(rows))throw new Error('Storico basket richiesto');
  const ids=new Set(),past=[];
  for(const r of rows) {
    if(typeof r.id!=='string'||!r.id||ids.has(r.id))throw new Error('ID osservazione duplicato o mancante');ids.add(r.id);
    const f=timestamp(r.featuresAt),k=timestamp(r.kickoff),o=timestamp(r.observedAt);
    if(f>=k||o<=k)throw new Error('Leakage: fattori devono precedere la partita e risultato deve seguirla');
    finite(r.points,'punti',0);finite(r.possessions,'possessi',1);
    const x=features(r.own,r.opponentAllowed,r.isHome);
    if(o<cutoff)past.push({x,y:100*r.points/r.possessions,observedAt:r.observedAt});
  }
  if(past.length<minSamples)throw new Error('Campione basket insufficiente');
  const n=past.length,d=9,mean=Array(d).fill(0),scale=Array(d).fill(0);
  for(let j=0;j<d;j++) {
    mean[j]=past.reduce((s,r)=>s+r.x[j],0)/n;
    scale[j]=Math.sqrt(past.reduce((s,r)=>s+(r.x[j]-mean[j])**2,0)/n)||1;
  }
  const gram=Array.from({length:d+1},()=>Array(d+1).fill(0)),rhs=Array(d+1).fill(0);
  for(const row of past) {
    const x=[1,...row.x.map((v,j)=>(v-mean[j])/scale[j])];
    for(let i=0;i<=d;i++){rhs[i]+=x[i]*row.y;for(let j=0;j<=d;j++)gram[i][j]+=x[i]*x[j];}
  }
  for(let i=1;i<=d;i++)gram[i][i]+=ridge;
  return {version:'four-factors-ridge-1',coefficients:solve(gram,rhs),mean,scale,ridge,n,asOf,
    trainingEnd:past.reduce((m,r)=>timestamp(r.observedAt)>timestamp(m)?r.observedAt:m,past[0].observedAt),
    features:['own eFG','own TOV','own ORB','own FT/FGA','allowed eFG','allowed TOV','allowed ORB','allowed FT/FGA','home']};
}
export function fitBasketballResiduals(rows,{asOf,minSamples=30}={}) {
  const cutoff=timestamp(asOf);finite(minSamples,'campione minimo',30);
  if(!Array.isArray(rows))throw new Error('Residui fuori campione richiesti');
  const ids=new Set(),past=[];
  for(const r of rows) {
    if(typeof r.id!=='string'||!r.id||ids.has(r.id))throw new Error('ID residuo duplicato o mancante');ids.add(r.id);
    const train=timestamp(r.trainingEnd),issued=timestamp(r.forecastAt),kick=timestamp(r.kickoff),observed=timestamp(r.observedAt);
    if(!(train<issued&&issued<kick&&kick<observed))throw new Error('Residuo non dimostrato fuori campione temporalmente');
    for(const k of ['predictedHome','predictedAway','actualHome','actualAway'])finite(r[k],k,0);
    if(observed<cutoff)past.push({margin:r.actualHome-r.actualAway-r.predictedHome+r.predictedAway,total:r.actualHome+r.actualAway-r.predictedHome-r.predictedAway,observedAt:r.observedAt});
  }
  if(past.length<minSamples)throw new Error('Residui fuori campione insufficienti');
  const result={n:past.length,asOf};
  for(const k of ['margin','total']) {
    const mean=past.reduce((s,r)=>s+r[k],0)/past.length;
    const sd=Math.sqrt(past.reduce((s,r)=>s+(r[k]-mean)**2,0)/(past.length-1));
    if(sd<1e-8)throw new Error('Dispersione residui nulla');result[k]={mean,sd};
  }
  return result;
}
export function predictBasketball(model,{home,away,leaguePace,at},residualModel=null) {
  const cutoff=timestamp(at);
  if(timestamp(model.asOf)>cutoff||timestamp(model.trainingEnd)>=cutoff)throw new Error('Modello successivo alla previsione');
  finite(leaguePace,'pace lega',1);
  for(const team of [home,away]) {
    if(timestamp(team.featuresAt)>=cutoff)throw new Error('Feature non precedenti alla previsione');
    finite(team.pace,'pace squadra',1);factors(team.own);factors(team.allowed);
  }
  if(home.regulationMinutes!==away.regulationMinutes||![40,48].includes(home.regulationMinutes))throw new Error('Pace deve usare la stessa durata regolamentare');
  const rate=(own,allowed,isHome)=>{
    const x=features(own,allowed,isHome);
    const y=model.coefficients[0]+x.reduce((s,v,j)=>s+model.coefficients[j+1]*(v-model.mean[j])/model.scale[j],0);
    finite(y,'rating previsto',0.000001,250);return y;
  };
  // Multiplicative matchup pace relative to the league baseline: explicit model assumption.
  const pace=home.pace*away.pace/leaguePace;
  finite(pace,'pace previsto',1,200);
  const homeRating=rate(home.own,away.allowed,true),awayRating=rate(away.own,home.allowed,false);
  const expectedHome=homeRating*pace/100,expectedAway=awayRating*pace/100;
  const out={version:model.version,pace,homeRating,awayRating,expectedHome,expectedAway,expectedTotal:expectedHome+expectedAway,expectedMargin:expectedHome-expectedAway,pHome:null,pAway:null};
  if(residualModel) {
    if(timestamp(residualModel.asOf)>cutoff)throw new Error('Residui futuri');
    for(const k of ['margin','total']) {finite(residualModel[k].mean,'bias');finite(residualModel[k].sd,'deviazione',0.000001);}
    out.pHome=normalCDF((out.expectedMargin+residualModel.margin.mean)/residualModel.margin.sd);out.pAway=1-out.pHome;
    out.distribution={margin:{mean:out.expectedMargin+residualModel.margin.mean,sd:residualModel.margin.sd},total:{mean:out.expectedTotal+residualModel.total.mean,sd:residualModel.total.sd}};
    out.probabilityAssumption='Residui gaussiani per punteggi finali inclusi overtime; probabilità da validare, nessun pareggio modellato.';
  }
  return out;
}
export function basketballTotals(prediction,line) {
  finite(line,'linea',0);
  if(line%1!==0.5||!prediction.distribution)throw new Error('Servono linea mezzo punto e residui fuori campione');
  const {mean,sd}=prediction.distribution.total;
  const under=normalCDF((line-mean)/sd);return {under,over:1-under,line};
}
