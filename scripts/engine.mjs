// Production contract. Market prices never enter fit() or predict().
import { stimaForze, stimaRho, lambde, matrice } from './model.mjs';
export const POLICY = Object.freeze({ zone:'Europe/Rome', hour:14, minute:7, halfLife:180,
  minHistory:100, minTeam:15, minSeason:2, maxOddsAge:6, minQuality:50,
  minConfidence:55, minEV:0.02, minEdge:0.01, maxGap:0.10, evCap:0.25,
  strongEV:0.08, strongEdge:0.05, strongConfidence:70, strongQuality:65,
  single:[1.50,1.85], combo:[1.85,2.50], high:[2.50,5], consensusBooks:3 });
export const VERSION='dc-xg-180-audited-1';
const finite = x => typeof x==='number' && Number.isFinite(x);
const clamp = x => Math.max(0,Math.min(1,x));
export function utc(s) {
  if(typeof s!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z$/.test(s)||!Number.isFinite(Date.parse(s))) throw Error('Timestamp UTC non valido');
  return Date.parse(s);
}
export function localDay(iso,zone=POLICY.zone) {
  utc(iso); const p=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));
  const get=k=>p.find(x=>x.type===k).value;return `${get('year')}-${get('month')}-${get('day')}`;
}
export function due(now,marker,manual=false) {
  if(marker===localDay(now))return false;
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:POLICY.zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now));
  const h=+parts.find(x=>x.type==='hour').value,m=+parts.find(x=>x.type==='minute').value;
  // Catch-up window tolerates delayed Actions scheduling. Daily marker is authoritative.
  return manual || h>POLICY.hour || (h===POLICY.hour&&m>=POLICY.minute);
}
export function validMatch(p) {
  return p && p.data instanceof Date && finite(+p.data) && p.casa && p.ospite && p.casa!==p.ospite &&
    [p.xgCasa,p.xgOspite].every(x=>finite(x)&&x>=0) && [p.golCasa,p.golOspite].every(x=>Number.isInteger(x)&&x>=0);
}
export function fit(rows,at) {
  const t=utc(at);
  if(rows.some(x=>!validMatch(x)))throw Error('Storico invalido');
  // At midnight the previous day is already complete; never ingest simultaneous results.
  const past=rows.filter(x=>+x.data<t).sort((a,b)=>a.data-b.data);
  if(past.length<POLICY.minHistory)return null;
  const forces=stimaForze(past,{oggi:new Date(at),emivita:180,iterazioni:200});
  return {forces,rho:stimaRho(past.slice(-300),forces),trainingMax:past.at(-1).data.toISOString(),n:past.length};
}
export function predict(model,home,away) {
  if(!model)return null;
  const {lh,la}=lambde(model.forces,home,away);
  if(![lh,la].every(x=>finite(x)&&x>0))return null;
  const m=matrice(lh,la,model.rho);
  // Invalid tau / extreme truncated tails produce abstention, never clipped probabilities.
  if(m.flat().some(x=>!finite(x)||x<0)||Math.max(lh,la)>5)return null;
  const p=[0,0,0];m.forEach((r,i)=>r.forEach((v,j)=>p[i>j?0:i===j?1:2]+=v));
  if(Math.abs(p.reduce((a,b)=>a+b,0)-1)>1e-9)throw Error('Massa probabilistica invalida');
  return {p,lh,la,rho:model.rho};
}
export function noVig(books,names,now) {
  if(!Array.isArray(books)||names.length!==3||new Set(names).size!==3)return null;
  const seen=new Set(),valid=[];
  for(const b of books){
    if(!b.key||seen.has(b.key))continue;
    const market=b.markets?.find(m=>m.key==='h2h');
    if(!market||market.outcomes?.length!==3)continue;
    const q=names.map(n=>market.outcomes.filter(o=>o.name===n));
    if(q.some(a=>a.length!==1||!finite(a[0].price)||a[0].price<=1))continue;
    let age;try{age=(utc(now)-utc(market.last_update||b.last_update))/36e5;}catch{continue;}
    if(age<0||age>POLICY.maxOddsAge)continue;
    const odds=q.map(a=>a[0].price),sum=odds.reduce((s,x)=>s+1/x,0);
    seen.add(b.key);valid.push({key:b.key,title:b.title||b.key,odds,p:odds.map(x=>1/x/sum),age});
  }
  if(valid.length<POLICY.consensusBooks)return null;
  return names.map((_,i)=>{
    const best=valid.reduce((a,b)=>b.odds[i]>a.odds[i]?b:a);
    const p=valid.reduce((s,b)=>s+b.p[i],0)/valid.length;
    return {p,odds:best.odds[i],book:best.title,n:valid.length,age:Math.max(...valid.map(b=>b.age)),
      dispersion:Math.max(...valid.map(b=>b.p[i]))-Math.min(...valid.map(b=>b.p[i])),
      prices:valid.map(b=>({key:b.key,title:b.title,odds:b.odds[i]}))};
  });
}
export function assess(p,market,context,policy=POLICY){
  if(!finite(p)||p<=0||p>=1||!market||!finite(market.p)||market.p<=0||market.p>=1||!finite(market.odds)||market.odds<=1)return null;
  const {teamN,seasonN,historyAgeDays}=context;
  if(![teamN,seasonN,historyAgeDays,market.age,market.n].every(x=>finite(x)&&x>=0))return null;
  const gap=Math.abs(p-market.p),edge=p-market.p,ev=p*market.odds-1;
  const quality=100*(0.55*clamp(teamN/40)+0.25*clamp(seasonN/10)+0.20*clamp(1-historyAgeDays/90));
  const confidence=100*(0.45*quality/100+0.20*clamp(1-market.age/policy.maxOddsAge)+0.35*clamp(1-gap/policy.maxGap));
  const eligible=teamN>=policy.minTeam&&seasonN>=policy.minSeason&&market.n>=policy.consensusBooks&&quality>=policy.minQuality&&confidence>=policy.minConfidence&&gap<policy.maxGap&&market.age<=policy.maxOddsAge;
  const category=!(ev>0&&edge>0)?'NO BET':!eligible||ev<policy.minEV||edge<policy.minEdge?'DA OSSERVARE':
    ev>=policy.strongEV&&edge>=policy.strongEdge&&confidence>=policy.strongConfidence&&quality>=policy.strongQuality?'VALORE FORTE':'VALORE';
  const rank=0.45*confidence/100+0.30*quality/100+0.25*clamp(ev/policy.evCap);
  return {fair:1/p,edge,ev,gap,quality,confidence,category,rank,eligible};
}
export function explain(p){
  const pct=x=>(100*x).toFixed(1)+'%';
  if(p.model===null)return `Nessun modello indipendente. Consenso no-vig ${pct(p.market.p)} da ${p.market.n} bookmaker; quota disponibile ${p.market.odds.toFixed(2)} (${p.market.book}).`;
  return `Modello ${pct(p.model)}, mercato no-vig ${pct(p.market.p)}. Quota equa ${p.analysis.fair.toFixed(2)}, disponibile ${p.market.odds.toFixed(2)} (${p.market.book}). Scarto ${ (p.analysis.gap*100).toFixed(1)} punti percentuali: ${p.analysis.gap<0.03?'accordo alto':p.analysis.gap<0.08?'disaccordo moderato':'disaccordo forte, penalizzato'}.`;
}
export function selections(rows,now,zone=POLICY.zone,policy=POLICY){
  const pool=rows.filter(p=>localDay(p.kickoff,zone)===localDay(now,zone)&&utc(p.kickoff)>utc(now)&&p.model!==null&&p.analysis?.eligible&&['VALORE','VALORE FORTE'].includes(p.analysis.category));
  const single=pool.filter(p=>p.market.odds>=policy.single[0]&&p.market.odds<=policy.single[1]).sort((a,b)=>b.model*a.analysis.quality-a.model*b.analysis.quality);
  single.sort((a,b)=>(b.model*b.analysis.quality)-(a.model*a.analysis.quality));
  const high=pool.filter(p=>p.market.odds>=policy.high[0]&&p.market.odds<=policy.high[1]).sort((a,b)=>b.analysis.rank-a.analysis.rank);
  let combo=null;
  // Enumerate distinct fixtures and a COMMON bookmaker: this is an actually quoted accumulator.
  function search(start,legs){
    if(legs.length>=2){
      const common=legs[0].market.prices.filter(b=>legs.every(p=>p.market.prices.some(q=>q.key===b.key)));
      for(const book of common){
        const odds=legs.reduce((s,p)=>s*p.market.prices.find(q=>q.key===book.key).odds,1);
        if(odds<policy.combo[0]||odds>policy.combo[1])continue;
        const probability=legs.reduce((s,p)=>s*p.model,1),quality=legs.reduce((s,p)=>s+p.analysis.quality,0)/legs.length;
        const score=probability*(quality/100);
        if(!combo||score>combo.score)combo={legs:legs.map(p=>p.id),odds,probability,quality,score,book:book.title,assumption:'Prodotto delle probabilità: indipendenza approssimata fra partite, non garantita.'};
      }
    }
    if(legs.length===3)return;
    for(let i=start;i<pool.length;i++)if(!legs.some(x=>x.eventId===pool[i].eventId))search(i+1,[...legs,pool[i]]);
  }
  search(0,[]);return {single:single[0]?.id||null,combo,high:high[0]?.id||null};
}
export function scores(p,outcome){
  if(p.length!==3||p.some(x=>!finite(x)||x<0||x>1)||Math.abs(p.reduce((a,b)=>a+b,0)-1)>1e-6||![0,1,2].includes(outcome))throw Error('Score input invalido');
  const y=p.map((_,i)=>+(i===outcome));
  return {brier:p.reduce((s,x,i)=>s+(x-y[i])**2,0),logLoss:-Math.log(Math.max(p[outcome],1e-15)),rps:((p[0]-y[0])**2+(p[0]+p[1]-y[0]-y[1])**2)/2};
}
export function settle(p,result){
  if(p.status==='closed')return p;
  if(!result||!result.completed||result.eventId!==p.eventId||result.home!==p.home||result.away!==p.away||result.kickoff!==p.kickoff)return p;
  if(![result.homeGoals,result.awayGoals].every(x=>Number.isInteger(x)&&x>=0))return p;
  const winner=result.homeGoals>result.awayGoals?'1':result.homeGoals<result.awayGoals?'2':'X';
  const won=p.outcome===winner;
  return {...p,status:'closed',result:`${result.homeGoals}-${result.awayGoals}`,won,pnl:won?p.market.odds-1:-1,fairPnl:p.model!==null?(won?1/p.model-1:-1):null};
}
export function performance(rows){
  const out={};for(const p of rows.filter(p=>p.status==='closed')){
    const cat=p.analysis?.category||'CONSENSO';const x=out[cat]??={n:0,wins:0,pnl:0,fairPnl:0};
    x.n++;x.wins+=+p.won;x.pnl+=p.pnl;x.fairPnl+=p.fairPnl??0;
  }return out;
}
