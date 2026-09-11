import {finite, probability, timestamp, solve} from './math.mjs';
const SURFACES = ['clay','hard','grass'];
const COUNTS = ['servePoints','firstIn','firstWon','secondWon','bpFaced','bpSaved','bpChances','bpConverted'];
export function tennisSurfaceStats(rows, {surface, asOf}) {
  if (!SURFACES.includes(surface) || !Array.isArray(rows)) throw new Error('Superficie o storico invalido');
  const cutoff = timestamp(asOf), ids = new Set(), sum = Object.fromEntries(COUNTS.map(k=>[k,0]));
  let n = 0;
  for (const r of rows) {
    if (typeof r.id !== 'string' || !r.id || ids.has(r.id)) throw new Error('ID tennis mancante o duplicato');
    ids.add(r.id); timestamp(r.kickoff); timestamp(r.observedAt);
    if (timestamp(r.observedAt) < timestamp(r.kickoff)) throw new Error('Osservazione prematura');
    if (!SURFACES.includes(r.surface)) throw new Error('Superficie non riconosciuta');
    for (const key of COUNTS) {finite(r[key],key,0); if (!Number.isInteger(r[key])) throw new Error('Conteggi interi richiesti');}
    if (r.firstIn>r.servePoints || r.firstWon>r.firstIn || r.secondWon>r.servePoints-r.firstIn || r.bpSaved>r.bpFaced || r.bpConverted>r.bpChances || r.bpFaced>r.servePoints) throw new Error('Conteggi tennis incoerenti');
    if (r.surface!==surface || timestamp(r.observedAt)>=cutoff) continue;
    COUNTS.forEach(k=>sum[k]+=r[k]); n++;
  }
  if (!n || !sum.firstIn || sum.servePoints===sum.firstIn) throw new Error('Campione servizio per superficie insufficiente');
  return {...sum, surface, asOf, matches:n, firstInRate:sum.firstIn/sum.servePoints,
    firstWinRate:sum.firstWon/sum.firstIn, secondWinRate:sum.secondWon/(sum.servePoints-sum.firstIn),
    breakSavedRate:sum.bpFaced?sum.bpSaved/sum.bpFaced:null,
    breakConvertedRate:sum.bpChances?sum.bpConverted/sum.bpChances:null};
}
export function serviceProfile(server, receiver, {pressurePriorPoints=20}={}) {
  if (!SURFACES.includes(server.surface) || server.surface!==receiver.surface || server.asOf!==receiver.asOf) throw new Error('Superficie e cutoff dei giocatori devono coincidere');
  timestamp(server.asOf); timestamp(receiver.asOf);
  finite(pressurePriorPoints,'forza prior',0.000001);
  probability(server.firstInRate); probability(server.firstWinRate); probability(server.secondWinRate);
  const regular = server.firstInRate*server.firstWinRate+(1-server.firstInRate)*server.secondWinRate;
  probability(regular,'probabilità servizio',true);
  for (const [v,k] of [[server.bpFaced,'bpFaced'],[server.bpSaved,'bpSaved'],[receiver.bpChances,'bpChances'],[receiver.bpConverted,'bpConverted']]) finite(v,k,0);
  if (server.bpSaved>server.bpFaced || receiver.bpConverted>receiver.bpChances) throw new Error('Break point incoerenti');
  const breakPoint = (server.bpSaved+receiver.bpChances-receiver.bpConverted+pressurePriorPoints*regular)/(server.bpFaced+receiver.bpChances+pressurePriorPoints);
  probability(breakPoint,'break point',true);
  return {regular,breakPoint,pressurePriorPoints};
}
// Absorbing chain over the 18 nonterminal game states; deuce loops solved exactly.
export function gameWinProbability(regular, breakPoint=regular) {
  probability(regular,'servizio',true); probability(breakPoint,'break point',true);
  const states=[];
  for(let a=0;a<=3;a++) for(let b=0;b<=3;b++) if(a!==3||b!==3) states.push([a,b]);
  states.push([3,3],[4,3],[3,4]);
  const index=new Map(states.map((s,i)=>[s.join(','),i]));
  const transition=(a,b)=>{
    if(a>=4&&a-b>=2)return 'win';
    if(b>=4&&b-a>=2)return 'lose';
    if(a>=3&&b>=3) {if(a===b)return index.get('3,3');return index.get(a>b?'4,3':'3,4');}
    return index.get(`${a},${b}`);
  };
  const matrix=states.map((_,i)=>states.map((__,j)=>i===j?1:0)), rhs=states.map(()=>0);
  states.forEach(([a,b],i)=>{
    const p=(b===3&&a<3)||(b===4&&a===3)?breakPoint:regular;
    for(const [dest,weight] of [[transition(a+1,b),p],[transition(a,b+1),1-p]]) {
      if(dest==='win')rhs[i]+=weight;else if(dest!=='lose')matrix[i][dest]-=weight;
    }
  });
  return solve(matrix,rhs)[0];
}
export function tieBreakProbability(pServeA,pServeB,{firstServer=0,target=7}={}) {
  probability(pServeA,'servizio A',true);probability(pServeB,'servizio B',true);
  if(![0,1].includes(firstServer)||![7,10].includes(target))throw new Error('Formato tie-break non supportato');
  const memo=new Map();
  const point=n=>{const server=n===0?firstServer:(Math.floor((n-1)/2)%2===0?1-firstServer:firstServer);return server===0?pServeA:1-pServeB;};
  const winPair=pServeA*(1-pServeB),losePair=(1-pServeA)*pServeB;
  const visit=(a,b)=>{
    if(a>=target&&a-b>=2)return 1;
    if(b>=target&&b-a>=2)return 0;
    if(a===b&&a>=target-1)return winPair/(winPair+losePair);
    const key=`${a},${b}`;if(memo.has(key))return memo.get(key);
    const p=point(a+b),v=p*visit(a+1,b)+(1-p)*visit(a,b+1);memo.set(key,v);return v;
  };
  return visit(0,0);
}
export function tennisMatchFromProbabilities(config) {
  const allowed=['serveA','serveB','breakA','breakB','bestOf','firstServer','tieBreakTarget','finalSetTieBreakTarget'];
  if(Object.keys(config).some(k=>!allowed.includes(k)))throw new Error('Opzione match non supportata');
  const {serveA,serveB,breakA=serveA,breakB=serveB,bestOf=3,firstServer=0,tieBreakTarget=7,finalSetTieBreakTarget=10}=config;
  if(![3,5].includes(bestOf)||![0,1].includes(firstServer)||![7,10].includes(tieBreakTarget)||![7,10].includes(finalSetTieBreakTarget))throw new Error('Formato match non supportato');
  const holdA=gameWinProbability(serveA,breakA),holdB=gameWinProbability(serveB,breakB),need=(bestOf+1)/2;
  const setCache=new Map(),matchCache=new Map();
  // Joint distribution winner x next server, preserving service order between sets.
  function setDistribution(server,target) {
    const cacheKey=`${server},${target}`;if(setCache.has(cacheKey))return setCache.get(cacheKey);
    const memo=new Map();
    const visit=(a,b,s)=>{
      const key=`${a},${b},${s}`;if(memo.has(key))return memo.get(key);
      const out=[0,0,0,0];
      if(Math.max(a,b)>=6&&Math.abs(a-b)>=2){out[(a>b?0:2)+s]=1;return out;}
      if(a===6&&b===6){const p=tieBreakProbability(serveA,serveB,{firstServer:s,target});out[1-s]=p;out[2+1-s]=1-p;return out;}
      const p=s===0?holdA:1-holdB,left=visit(a+1,b,1-s),right=visit(a,b+1,1-s);
      for(let k=0;k<4;k++)out[k]=p*left[k]+(1-p)*right[k];memo.set(key,out);return out;
    };
    const result=visit(0,0,server);setCache.set(cacheKey,result);return result;
  }
  const match=(a,b,s)=>{
    if(a===need)return 1;if(b===need)return 0;
    const key=`${a},${b},${s}`;if(matchCache.has(key))return matchCache.get(key);
    const dist=setDistribution(s,a===need-1&&b===need-1?finalSetTieBreakTarget:tieBreakTarget);
    const p=dist[0]*match(a+1,b,0)+dist[1]*match(a+1,b,1)+dist[2]*match(a,b+1,0)+dist[3]*match(a,b+1,1);
    matchCache.set(key,p);return p;
  };
  const pA=match(0,0,firstServer);
  return {version:'tennis-markov-1',pA,pB:1-pA,holdA,holdB,bestOf,firstServer,tieBreakTarget,finalSetTieBreakTarget};
}
export function predictTennis(a,b,format={}) {
  const {pressurePriorPoints=20,...rules}=format;
  const sa=serviceProfile(a,b,{pressurePriorPoints}),sb=serviceProfile(b,a,{pressurePriorPoints});
  return {...tennisMatchFromProbabilities({...rules,serveA:sa.regular,serveB:sb.regular,breakA:sa.breakPoint,breakB:sb.breakPoint}),surface:a.surface,asOf:a.asOf,serviceA:sa,serviceB:sb,
    validation:'Modello candidato: pooling dei break point da validare, servizio ordinario non aggiustato per forza degli avversari. Nessuna gestione ritiri.'};
}
