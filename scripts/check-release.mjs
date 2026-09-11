import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {localDay,utc,assess,selections,performance} from './engine.mjs';
const d=JSON.parse(readFileSync('data/release.json','utf8'));
assert.equal(d.schema,2);assert.equal(d.coverage.length,5);assert.ok(d.generation);assert.ok(d.report.splits.test.n>=1000);
assert.equal(new Set(d.picks.map(p=>p.id)).size,d.picks.length);
for(const p of d.picks){
  assert.equal(localDay(p.kickoff),d.day);assert.ok(utc(p.kickoff)>utc(d.generatedAt));assert.ok(p.market.n>=3);
  assert.ok(Number.isFinite(p.market.p)&&p.market.p>0&&p.market.p<1);assert.ok(p.market.odds>1);assert.ok(p.market.age<=d.policy.maxOddsAge);
  if(p.model!==null){assert.ok(p.trainingMax<d.day+'T00:00:00Z');assert.deepEqual(p.analysis,assess(p.model,p.market,p.context));}
  else {assert.equal(p.analysis,null);assert.equal(p.version,'market-only');}
}
assert.deepEqual(d.selections,selections(d.picks,d.generatedAt));
const ledger=JSON.parse(readFileSync('data/ledger.json','utf8'));assert.deepEqual(d.performance,performance(ledger));
assert.equal(new Set(ledger.map(p=>p.id)).size,ledger.length);
console.log('Snapshot verificato:',d.generation);
