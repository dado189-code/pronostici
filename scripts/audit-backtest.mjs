import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fit,predict,scores,VERSION} from './engine.mjs';
import {archive,LEAGUES} from './sources.mjs';
import {pairedBlockBootstrap as bootstrap} from './statistics.mjs';
const predictions=[],coverage=[];
const matched=JSON.parse(readFileSync('data/normalized/dataset-matched.json','utf8')).partite;
for(const [key,,league] of LEAGUES){
  const rows=archive(key);let day='',model=null,skipped=0;
  for(const p of rows){
    const date=p.data.toISOString().slice(0,10);if(date<'2023-08-01')continue;
    if(date!==day){day=date;model=fit(rows,date+'T00:00:00Z');}
    const pred=predict(model,p.casa,p.ospite);if(!pred){skipped++;continue;}
    if(model.trainingMax>=date+'T00:00:00Z')throw Error('LEAKAGE');
    const split=date<'2024-08-01'?'train':date<'2025-08-01'?'validation':'test';
    const outcome=p.golCasa>p.golOspite?0:p.golCasa<p.golOspite?2:1;
    const ref=matched.find(r=>r.league===league&&r.date===date&&r.home_team===p.casa&&r.away_team===p.ospite);
    const q=ref?[ref.closing_home,ref.closing_draw,ref.closing_away]:[];
    const sum=q.reduce((a,b)=>a+1/b,0);const market=q.length===3&&q.every(x=>Number.isFinite(x)&&x>1)?q.map(x=>1/x/sum):null;
    predictions.push({id:key+':'+p.id,league,date,split,trainingMax:model.trainingMax,n:model.n,p:pred.p,outcome,score:scores(pred.p,outcome),marketScore:market?scores(market,outcome):null});
  }
  coverage.push({league,n:predictions.filter(p=>p.league===league).length,skipped});
  console.log(league,coverage.at(-1));
}
function average(rows,key='score'){return Object.fromEntries(['brier','logLoss','rps'].map(m=>[m,rows.reduce((s,r)=>s+r[key][m],0)/rows.length]));}
// Paired bootstrap of calendar-week blocks preserves within-week dependence.
const test=predictions.filter(r=>r.split==='test'&&r.marketScore);
const report={version:VERSION,generatedAt:new Date().toISOString(),engineHash:createHash('sha256').update(readFileSync('scripts/model.mjs','utf8').replace(/\r\n/g,'\n')).update(readFileSync('scripts/engine.mjs','utf8').replace(/\r\n/g,'\n')).digest('hex'),
  method:'Dixon-Coles xG, emivita 180 giorni; rifit giornaliero a mezzanotte UTC, solo partite dei giorni precedenti. Warm-up 2022/23, train 2023/24, validation 2024/25, test 2025/26. Nessun tuning effettuato.',
  limitations:['Dati storici scaricati retrospettivamente: revisioni xG e orari originari di disponibilità non ricostruibili.', 'Il test 2025/26 era già stato esplorato nel repository precedente: non è un nuovo holdout incontaminato. Nessun miglioramento viene promosso.', 'Il confronto closing storico è Pinnacle, non un consenso di almeno tre bookmaker. Non dimostra profitti eseguibili.'],
  improvements:{promoted:[],decision:'Nessuna feature, calibrazione o ensemble promossi. Draw-cal disattivato: evidenza precedente non conforme a test finale isolato.'},
  coverage,splits:Object.fromEntries(['train','validation','test'].map(s=>{const r=predictions.filter(x=>x.split===s);return [s,{n:r.length,...average(r)}];})),
  marketComparison:{n:test.length,model:average(test),closing:average(test,'marketScore'),bootstrap:Object.fromEntries(['brier','logLoss','rps'].map(m=>[m,bootstrap(test,m)]))}};
if(coverage.some(x=>x.n<700)||report.splits.test.n<1000)throw Error('Copertura backtest insufficiente');
mkdirSync('data/audit',{recursive:true});writeFileSync('data/audit/predictions.json',JSON.stringify(predictions));writeFileSync('data/audit/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
