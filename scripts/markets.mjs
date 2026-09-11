import {utc,settle} from './engine.mjs';
// Operator families avoid counting regional copies as independent bookmakers.
const operator=k=>/^unibet(?:_|$)/.test(k)?'unibet':/^betfair(?:_|$)/.test(k)?'betfair':k;
export function consensus(books,{key='h2h',names,point=null},now){
  if(!Array.isArray(books)||![2,3].includes(names?.length)||new Set(names).size!==names.length)return null;
  const valid=[],seen=new Set();
  for(const b of books){
    if(!b.key||seen.has(operator(b.key)))continue;
    const markets=(b.markets||[]).filter(m=>m.key===key);
    for(const m of markets){
      const outcomes=m.outcomes?.filter(o=>point===null||o.point===point)||[];
      if(outcomes.length!==names.length)continue;
      const matched=names.map(n=>outcomes.filter(o=>o.name===n));
      if(matched.some(x=>x.length!==1||!Number.isFinite(x[0].price)||x[0].price<=1))continue;
      let age;try{age=(utc(now)-utc(m.last_update||b.last_update))/36e5;}catch{continue;}
      if(age<0||age>6)continue;
      const odds=matched.map(x=>x[0].price),sum=odds.reduce((s,q)=>s+1/q,0);
      valid.push({key:b.key,title:b.title||b.key,odds,p:odds.map(q=>1/q/sum),age});seen.add(operator(b.key));break;
    }
  }
  if(valid.length<3)return null;
  return names.map((_,i)=>{const best=valid.reduce((a,b)=>a.odds[i]>b.odds[i]?a:b);return {p:valid.reduce((s,b)=>s+b.p[i],0)/valid.length,n:valid.length,odds:best.odds[i],book:best.title,age:Math.max(...valid.map(b=>b.age)),dispersion:Math.max(...valid.map(b=>b.p[i]))-Math.min(...valid.map(b=>b.p[i])),prices:valid.map(b=>({key:b.key,title:b.title,odds:b.odds[i]}))};});
}
export function movement(p,previous){
  if(!previous||previous.eventId!==p.eventId||previous.kickoff!==p.kickoff||previous.outcome!==p.outcome||(previous.marketKey||'h2h')!==(p.marketKey||'h2h')||previous.point!==p.point&&!(previous.point==null&&p.point==null)||Date.parse(previous.generatedAt)>=Date.parse(p.generatedAt))return null;
  const changes=p.market.prices.flatMap(b=>{const old=previous.market.prices.find(x=>x.key===b.key);return old?[{book:b.title,key:b.key,from:old.odds,to:b.odds,change:b.odds/old.odds-1}]:[];});
  return changes.length?{from:previous.generatedAt,to:p.generatedAt,books:changes,note:'Confronto fra due rilevazioni dello stesso bookmaker; non quota di apertura o closing certificata.'}:null;
}
export function settleMarket(p,r){
  if(p.sport.startsWith('tennis_'))return p;
  return settle(p,r);
}
