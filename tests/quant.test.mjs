import test from 'node:test';
import assert from 'node:assert/strict';
import * as q from '../scripts/quant/index.mjs';
const close=(a,b,tol=1e-10)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
test('Dixon-Coles mass, complementary markets and independent Poisson identities',()=>{
 const p=q.footballFromRates({homeXG:1.5,awayXG:1.1,rho:0});
 close(p.matrix.flat().reduce((a,b)=>a+b,0),1);close(p.markets['1']+p.markets.X+p.markets['2'],1);
 close(p.markets.over25+p.markets.under25,1);close(p.markets.goal+p.markets.noGoal,1);
 close(p.markets.goal,(1-Math.exp(-1.5))*(1-Math.exp(-1.1)));
 close(p.markets.under25,Math.exp(-2.6)*(1+2.6+2.6**2/2));assert.ok(p.omittedMass<=1e-12);
});
test('DC symmetry, high rates and invalid tau never silently clipped',()=>{
 const a=q.footballFromRates({homeXG:1.6,awayXG:1.2,rho:-.1}),b=q.footballFromRates({homeXG:1.2,awayXG:1.6,rho:-.1});close(a.markets['1'],b.markets['2']);
 assert.throws(()=>q.footballFromRates({homeXG:2,awayXG:2,rho:1}));assert.ok(q.footballFromRates({homeXG:20,awayXG:20}).omittedMass<=1e-12);
});
test('margin removal, EV 3% inclusive, quarter Kelly and nonpositive stakes',()=>{
 const r=q.removeMargin([1.9,1.9]);close(r.probabilities[0],.5);assert.ok(r.overround>0);
 close(q.quarterKelly(.55,2,1000).stake,25);assert.equal(q.quarterKelly(.4,2,1000).fraction,0);
 assert.equal(q.evaluateValue({modelProbability:.515,marketProbability:.5,odds:2}).qualifies,true);
 assert.equal(q.evaluateValue({modelProbability:.514,marketProbability:.5,odds:2,bankroll:1000}).suggestedStake,0);
 assert.throws(()=>q.expectedValue(null,2));assert.throws(()=>q.removeMargin([0,2]));
});
test('absorbing game agrees with independent closed formula for constant p',()=>{
 for(const p of [.01,.1,.3,.5,.65,.9,.99]){
 const expected=p**4*(1+4*(1-p)+10*(1-p)**2)+20*p**3*(1-p)**3*p*p/(p*p+(1-p)**2);
 close(q.gameWinProbability(p),expected);}
 assert.ok(q.gameWinProbability(.6,.7)>q.gameWinProbability(.6,.5));
});
test('tie-break agrees with independent forward enumeration including service rotation',()=>{
 for(const target of [7,10])for(const firstServer of [0,1]){
 let states=new Map([['0,0',1]]),win=0;
 for(let n=0;n<160;n++){
 const next=new Map(),s=n===0?firstServer:(Math.floor((n-1)/2)%2===0?1-firstServer:firstServer),p=s===0?.66:.42;
 for(const [key,mass]of states){const [a,b]=key.split(',').map(Number);for(const [x,y,w]of [[a+1,b,p],[a,b+1,1-p]]){
 if(Math.max(x,y)>=target&&Math.abs(x-y)>=2){if(x>y)win+=mass*w;}else{const k=`${x},${y}`;next.set(k,(next.get(k)||0)+mass*w);}}}states=next;}
 close(q.tieBreakProbability(.66,.58,{firstServer,target}),win);
 }
});
test('match symmetry, player swap, stronger service and best-of-five',()=>{
 for(const bestOf of [3,5]){
 close(q.tennisMatchFromProbabilities({serveA:.63,serveB:.63,bestOf}).pA,.5);
 const a=q.tennisMatchFromProbabilities({serveA:.68,serveB:.6,bestOf,firstServer:0});
 const b=q.tennisMatchFromProbabilities({serveA:.6,serveB:.68,bestOf,firstServer:1});close(a.pA+b.pA,1);assert.ok(a.pA>.5);}
 assert.throws(()=>q.tennisMatchFromProbabilities({serveA:1,serveB:0}));
});
const tennisRow={id:'1',surface:'clay',kickoff:'2025-01-01T12:00:00Z',observedAt:'2025-01-01T16:00:00Z',servePoints:100,firstIn:60,firstWon:45,secondWon:20,bpFaced:10,bpSaved:6,bpChances:8,bpConverted:3};
test('tennis JSON aggregates only known surface history and detects bad counts',()=>{
 const rows=[tennisRow,{...tennisRow,id:'2',surface:'hard'},{...tennisRow,id:'3',observedAt:'2027-01-01T00:00:00Z'}];
 const a=q.tennisSurfaceStats(rows,{surface:'clay',asOf:'2026-01-01T00:00:00Z'});assert.equal(a.matches,1);close(a.firstWinRate,.75);close(a.secondWinRate,.5);close(q.predictTennis(a,a).pA,.5);
 assert.throws(()=>q.tennisSurfaceStats([{...tennisRow,firstWon:90}],{surface:'clay',asOf:'2026-01-01T00:00:00Z'}));
});
const box={fgm:40,fga:80,threeMade:10,ftm:15,fta:20,tov:12,orb:10,drb:30};
test('Four Factors definitions and overtime pace normalization',()=>{
 const f=q.fourFactors(box,box);close(f.efg,45/80);close(f.tov,12/100.8);close(f.orb,.25);close(f.ftRate,15/80);close(f.pace,90.8);assert.equal(f.points,105);
 close(q.fourFactors(box,box,{minutes:53}).pace,90.8*48/53);assert.throws(()=>q.fourFactors({...box,ftm:30},box));
});
const factors={efg:.5,tov:.12,orb:.25,ftRate:.2};
const basketRows=Array.from({length:60},(_,i)=>({id:String(i),featuresAt:'2025-01-01T00:00:00Z',kickoff:'2025-01-02T00:00:00Z',observedAt:'2025-01-03T00:00:00Z',own:{...factors,efg:.4+.004*i},opponentAllowed:factors,isHome:i%2===0,possessions:100,points:80+40*(.4+.004*i)+(i%2===0?3:0)}));
const residualRows=Array.from({length:40},(_,i)=>({id:String(i),trainingEnd:'2025-01-01T00:00:00Z',forecastAt:'2025-02-01T00:00:00Z',kickoff:'2025-02-02T00:00:00Z',observedAt:'2025-02-03T00:00:00Z',predictedHome:100,predictedAway:100,actualHome:100+(i%5-2)*3,actualAway:100+(i%3-1)*2}));
test('Four Factors regression learns signal; scores scale with pace; probabilities require residuals',()=>{
 const model=q.fitBasketball(basketRows,{asOf:'2026-01-01T00:00:00Z',ridge:.01});
 const team={own:factors,allowed:factors,pace:100,regulationMinutes:48,featuresAt:'2026-01-01T01:00:00Z'};
 const input={home:team,away:team,leaguePace:100,at:'2026-01-02T00:00:00Z'};
 const p=q.predictBasketball(model,input);close(p.expectedHome,103,.001);close(p.expectedAway,100,.001);assert.equal(p.pHome,null);
 const fast=q.predictBasketball(model,{...input,home:{...team,pace:110}});close(fast.expectedHome/p.expectedHome,1.1);
 const residuals=q.fitBasketballResiduals(residualRows,{asOf:'2026-01-01T00:00:00Z'});
 const withP=q.predictBasketball(model,input,residuals);assert.ok(withP.pHome>.5);close(withP.pHome+withP.pAway,1);const totals=q.basketballTotals(withP,203.5);close(totals.over+totals.under,1);
});
test('basketball rejects leakage and absent validation dispersion',()=>{
 assert.throws(()=>q.fitBasketball([{...basketRows[0],featuresAt:basketRows[0].kickoff}],{asOf:'2026-01-01T00:00:00Z'}));
 assert.throws(()=>q.fitBasketballResiduals(residualRows.map(r=>({...r,trainingEnd:r.kickoff})),{asOf:'2026-01-01T00:00:00Z'}));
 assert.throws(()=>q.basketballTotals({},200));
});
test('football JSON rejects duplicate identities and cannot train on future observations',()=>{
 const row={id:'1',kickoff:'2025-01-01T00:00:00Z',observedAt:'2025-01-02T00:00:00Z',home:'A',away:'B',homeXG:1.4,awayXG:1.1,homeGoals:1,awayGoals:1};
 assert.throws(()=>q.fitFootball([row,row],'2026-01-01T00:00:00Z'));
 const rows=Array.from({length:100},(_,i)=>({...row,id:String(i),observedAt:'2027-01-01T00:00:00Z'}));assert.throws(()=>q.fitFootball(rows,'2026-01-01T00:00:00Z'));
 const model=q.fitFootball(rows.map(r=>({...r,observedAt:row.observedAt})),'2026-01-01T00:00:00Z');assert.ok(q.predictFootball(model,'A','B').markets['1']>0);
});
test('unsupported tennis formats cannot silently use standard rules',()=>{
 assert.throws(()=>q.tennisMatchFromProbabilities({serveA:.6,serveB:.6,noAd:true}));
});
