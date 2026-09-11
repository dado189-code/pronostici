import {footballFromRates,predictTennis,predictBasketball,evaluateValue} from './scripts/quant/index.mjs';
export function validateSnapshot(d) {
  if(d?.schema!==2||!Number.isFinite(Date.parse(d.generatedAt))||!Array.isArray(d.picks)||!d.report?.marketComparison?.bootstrap||!Array.isArray(d.coverage)||!d.selections)throw new Error('Snapshot incompleto');
  const ids=new Set();
  for(const p of d.picks){
    if(typeof p.id!=='string'||ids.has(p.id)||!Number.isFinite(Date.parse(p.kickoff))||!Number.isFinite(Date.parse(p.generatedAt)))throw new Error('Evento invalido');ids.add(p.id);
    if(!p.market||!Number.isFinite(p.market.odds)||p.market.odds<=1||!Number.isFinite(p.market.p)||p.market.p<=0||p.market.p>=1||!Array.isArray(p.market.prices)||!Number.isFinite(p.market.age)||p.market.age<0)throw new Error('Quote incomplete');
    if(p.model!==null&&(!Number.isFinite(p.model)||p.model<=0||p.model>=1))throw new Error('Probabilità modello invalida');
  }
  return d;
}
export function enrichSnapshot(snapshot) {
  const d=structuredClone(validateSnapshot(snapshot));
  for(const p of d.picks){
    const input=d.quantInputs?.[p.eventId];
    p.quantStatus=p.model===null?'Metriche reali insufficienti per il modello':'Modello xG pubblicato';
    if(!input)continue;
    try {
      let prediction,prob;
      if(input.kind==='football'){
        prediction=footballFromRates(input.rates);prob=prediction.markets[p.outcome];
        // Preserve audited 1X2 in published picks; extended markets use the adaptive matrix.
        if(p.model===null) p.model=prob??null;
      }else if(input.kind==='tennis'){
        prediction=predictTennis(input.playerA,input.playerB,input.format);
        if(Date.parse(prediction.asOf)>=Date.parse(p.kickoff))throw new Error('Cutoff tennis invalido');
        prob=p.outcome==='1'?prediction.pA:p.outcome==='2'?prediction.pB:null;p.model=prob;
      }else if(input.kind==='basketball'){
        prediction=predictBasketball(input.model,input.match,input.residualModel);
        if(Date.parse(input.match.at)>=Date.parse(p.kickoff))throw new Error('Cutoff basket invalido');
        p.model=p.outcome==='1'?prediction.pHome:p.outcome==='2'?prediction.pAway:null;
      }else throw new Error('Modello non supportato');
      p.quant=prediction;p.quantStatus=p.model===null?'Mancano residui fuori campione per la probabilità':'Motore quantitativo · '+input.kind;
    }catch(error){p.quantStatus='Input modello non utilizzabile: '+error.message;p.model=null;}
  }
  return d;
}
export async function loadData(fetcher=fetch) {
  const read=async url=>{const r=await fetcher(url,{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('HTTP '+r.status);return enrichSnapshot(await r.json());};
  try{return {...await read('release.json?check='+Date.now()),sourceMode:'live'};}
  catch{return {...await read('data/fixtures.json'),sourceMode:'fallback'};}
}
export function staking(p,bankroll,{now=Date.now(),fallback=false}={}) {
  if(!Number.isFinite(bankroll)||bankroll<0)throw new Error('Bankroll non valido');
  if(p.model===null||!Number.isFinite(p.model))return null;
  const v=evaluateValue({modelProbability:p.model,marketProbability:p.market.p,odds:p.market.odds,bankroll});
  const age=p.market.age+(now-Date.parse(p.generatedAt))/36e5;
  const actionable=!fallback&&Date.parse(p.kickoff)>now&&age>=0&&age<=6;
  return {...v,actionable,suggestedFraction:actionable?v.suggestedFraction:0,suggestedStake:actionable?v.suggestedStake:0};
}
