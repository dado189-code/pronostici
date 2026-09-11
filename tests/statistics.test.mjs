import test from 'node:test';import assert from 'node:assert/strict';import {pairedBlockBootstrap} from '../scripts/statistics.mjs';
test('bootstrap rejects empty and missing scores',()=>{assert.throws(()=>pairedBlockBootstrap([],'brier'));assert.throws(()=>pairedBlockBootstrap([{date:'2025-01-01'}],'brier'));});
test('identical paired forecasts produce zero difference and zero interval',()=>{
  const rows=['2025-01-03','2025-01-04','2025-01-10'].map(date=>({date,score:{brier:.5},marketScore:{brier:.5}}));
  const r=pairedBlockBootstrap(rows,'brier');assert.equal(r.difference,0);assert.deepEqual(r.ci95,[0,0]);assert.equal(r.blocks,2);
});
test('constant degradation is measured and resampling is deterministic',()=>{
  const rows=['2025-01-01','2025-01-10','2025-01-17'].map(date=>({date,score:{logLoss:2},marketScore:{logLoss:1}}));
  const r=pairedBlockBootstrap(rows,'logLoss');assert.equal(r.difference,1);assert.deepEqual(r.ci95,[1,1]);assert.deepEqual(r,pairedBlockBootstrap(rows,'logLoss'));
});
