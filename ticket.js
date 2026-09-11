// Pure shared browser/Node logic. No invented prices and no mixed-book accumulators.
export const sportGroup=p=>p.sport?.startsWith('tennis_')?'tennis':p.sport?.startsWith('basketball_')?'basket':'calcio';
const day=(s,z)=>new Intl.DateTimeFormat('en-CA',{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(s));
export function eligibleTickets(rows,{now=new Date().toISOString(),zone='Europe/Rome',sport='all',mode='market'}={}){
  return rows.filter(p=>{
    const age=p.market?.age+(Date.parse(now)-Date.parse(p.generatedAt))/36e5;
    return day(p.kickoff,zone)===day(now,zone)&&Date.parse(p.kickoff)>Date.parse(now)&&Number.isFinite(age)&&age>=0&&age<=6&&
      (sport==='all'||sportGroup(p)===sport)&&p.market.n>=3&&p.market.dispersion<=.08&&p.market.p>0&&p.market.p<1&&
      (mode!=='value'||(p.analysis?.eligible&&p.analysis.ev>=.03-1e-12&&['VALORE','VALORE FORTE'].includes(p.analysis.category)));
  });
}
export function ticketFor(legs,{book='',mode='market',stake=0}={}){
  if(!Array.isArray(legs)||!legs.length||new Set(legs.map(p=>p.eventId)).size!==legs.length)return null;
  if(!Number.isFinite(stake)||stake<0)throw Error('Importo non valido');
  const books=legs[0].market.prices.filter(b=>(!book||b.key===book)&&legs.every(p=>p.market.prices.some(x=>x.key===b.key&&Number.isFinite(x.odds)&&x.odds>1)));
  const tickets=books.map(b=>{
    const quoted=legs.map(p=>({...p,ticketOdds:p.market.prices.find(x=>x.key===b.key).odds}));
    const odds=quoted.reduce((s,p)=>s*p.ticketOdds,1),marketP=legs.reduce((s,p)=>s*p.market.p,1);
    const modelP=legs.every(p=>Number.isFinite(p.model)&&p.model>0&&p.model<1)?legs.reduce((s,p)=>s*p.model,1):null;
    const quality=legs.reduce((s,p)=>s+(mode==='value'?p.analysis.quality:100*(.5*Math.min(1,p.market.n/8)+.5*Math.max(0,1-p.market.dispersion/.08))),0)/legs.length;
    return {legs:quoted,book:b.key,bookTitle:b.title,odds,marketP,modelP,quality,score:(mode==='value'?modelP:marketP)*quality/100,gross:stake*odds,net:stake*(odds-1),stake};
  });
  return tickets.sort((a,b)=>b.odds-a.odds)[0]||null;
}
export function generateTicket(rows,options={}){
  const {target=2,tolerance=.05,maxLegs=3,minLegs=2,book='',mode='market',stake=0,visitLimit=250000}=options;
  if(!Number.isFinite(target)||target<=1||target>100||![2,3,4].includes(maxLegs)||![1,2].includes(minLegs)||!Number.isFinite(tolerance)||tolerance<0||tolerance>.2||!Number.isFinite(stake)||stake<0)throw Error('Parametri non validi');
  const pool=eligibleTickets(rows,options),low=target*(1-tolerance),high=target*(1+tolerance);
  const allBooks=[...new Set(pool.flatMap(p=>p.market.prices.map(b=>b.key)))].filter(k=>!book||k===book);
  let best=null,nearest=null,visited=0,truncated=false;
  for(const key of allBooks){
    const candidates=pool.filter(p=>p.market.prices.some(b=>b.key===key)).sort((a,b)=>b.market.p-a.market.p);
    function walk(start,legs,odds){
      if(++visited>visitLimit){truncated=true;return;}
      if(legs.length>=minLegs){
        const t=ticketFor(legs,{book:key,mode,stake});
        if(t&&(!nearest||Math.abs(t.odds-target)<Math.abs(nearest.odds-target)))nearest=t;
        if(t&&t.odds>=low&&t.odds<=high&&(!best||t.score>best.score+1e-12||(Math.abs(t.score-best.score)<1e-12&&Math.abs(t.odds-target)<Math.abs(best.odds-target))))best=t;
      }
      if(legs.length===maxLegs||odds>high||truncated)return;
      for(let i=start;i<candidates.length;i++){
        const p=candidates[i],price=p.market.prices.find(b=>b.key===key).odds;
        if(!Number.isFinite(price)||price<=1||legs.some(q=>q.eventId===p.eventId))continue;
        walk(i+1,[...legs,p],odds*price);if(truncated)return;
      }
    }
    walk(0,[],1);if(truncated)break;
  }
  return {ticket:best,nearest:best?null:nearest,low,high,target,eligible:pool.length,visited,truncated,mode};
}
