import {readFileSync,writeFileSync} from 'node:fs';
import {fit} from './engine.mjs';
import {lambde} from './model.mjs';
import {canonical,LEAGUES} from './sources.mjs';
const d=JSON.parse(readFileSync('data/release.json','utf8'));
const history=JSON.parse(readFileSync('data/xg-history.json','utf8'));
d.quantInputs={};
for(const [under,sport]of LEAGUES){
 const rows=history[under].map(p=>({...p,data:new Date(p.data)}));
 const model=fit(rows,d.day+'T00:00:00Z');
 for(const p of d.picks.filter(p=>p.sport===sport&&p.model!==null)){
 const home=model.forces.squadre.find(t=>canonical(t)===canonical(p.home)),away=model.forces.squadre.find(t=>canonical(t)===canonical(p.away));
 if(!home||!away)throw new Error('Identità non verificata');const {lh,la}=lambde(model.forces,home,away);
 d.quantInputs[p.eventId]={kind:'football',rates:{homeXG:lh,awayXG:la,rho:model.rho},metricsSource:'Understat xG; stima con lo stesso cutoff dello snapshot',asOf:d.day+'T00:00:00Z'};
 }
}
d.fixtureInfo={kind:'archived-real-snapshot',capturedAt:d.generatedAt,source:'Snapshot reale già pubblicato da The Odds API e Understat',warning:'Esempi storici consultabili, non quote live. Nessuna statistica tennis o basket inventata.'};
writeFileSync('data/fixtures.json',JSON.stringify(d,null,2));
console.log('Fallback reale:',d.generatedAt,d.picks.length,'esiti');
