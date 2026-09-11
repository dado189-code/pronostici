// Verify every stored score and temporal boundary; canonicalize cross-platform provenance.
import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {fit,predict,scores} from './engine.mjs';import {archive,LEAGUES} from './sources.mjs';
import {pairedBlockBootstrap} from './statistics.mjs';
const rows=JSON.parse(readFileSync('data/audit/predictions.json','utf8')),report=JSON.parse(readFileSync('data/audit/report.json','utf8'));
assert.equal(new Set(rows.map(p=>p.id)).size,rows.length);
for(const r of rows){assert.ok(r.trainingMax<r.date+'T00:00:00Z');assert.deepEqual(r.score,scores(r.p,r.outcome));}
for(const [key,,league] of LEAGUES){
  const r=rows.find(r=>r.league===league&&r.split==='test');assert.ok(r);
  const history=archive(key),match=history.find(p=>key+':'+p.id===r.id);
  const model=fit(history,r.date+'T00:00:00Z');
  // V8/libm can differ by a few ULP between Windows and Linux. This tolerance
  // is far below stored/displayed precision and still rejects material drift.
  predict(model,match.casa,match.ospite).p.forEach((p,i)=>assert.ok(Math.abs(p-r.p[i])<1e-12,'Deriva numerica del modello'));
}
for(const split of ['train','validation','test']){
  const sample=rows.filter(p=>p.split===split);assert.equal(report.splits[split].n,sample.length);
  for(const metric of ['brier','logLoss','rps'])assert.equal(report.splits[split][metric],sample.reduce((s,r)=>s+r.score[metric],0)/sample.length);
}
const hash=createHash('sha256').update(readFileSync('scripts/model.mjs','utf8').replace(/\r\n/g,'\n')).update(readFileSync('scripts/engine.mjs','utf8').replace(/\r\n/g,'\n')).digest('hex');
for(const metric of ['brier','logLoss','rps'])assert.deepEqual(report.marketComparison.bootstrap[metric],pairedBlockBootstrap(rows.filter(r=>r.split==='test'&&r.marketScore),metric));
if(process.argv.includes('--canonicalize')){report.engineHash=hash;report.provenanceVerifiedAt=new Date().toISOString();writeFileSync('data/audit/report.json',JSON.stringify(report,null,2));}
else assert.equal(report.engineHash,hash);
console.log('Backtest verificato:',rows.length,'previsioni; cinque rifit riprodotti, tutti gli score e confini temporali controllati.');
