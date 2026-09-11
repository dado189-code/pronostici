import {readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {POLICY,VERSION,localDay,utc,fit,predict,noVig,assess,explain,selections,settle,performance} from './engine.mjs';
import {consensus,movement,settleMarket} from './markets.mjs';
import {LEAGUES,archive,current,canonical,json} from './sources.mjs';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const now=new Date().toISOString(),day=localDay(now),season=+day.slice(0,4)-(+day.slice(5,7)<7?1:0);
const report=read('data/audit/report.json');
const hash=createHash('sha256').update(readFileSync('scripts/model.mjs','utf8').replace(/\r\n/g,'\n')).update(readFileSync('scripts/engine.mjs','utf8').replace(/\r\n/g,'\n')).digest('hex');
if(report.engineHash!==hash)throw Error('Il backtest non corrisponde al motore corrente');
const key=process.env.ODDS_API_KEY;if(!key)throw Error('Manca ODDS_API_KEY');
const old=existsSync('data/release.json')?read('data/release.json'):null;
const ledger=existsSync('data/ledger.json')?read('data/ledger.json'):[];
const marker=existsSync('data/published.json')?read('data/published.json'):null;
if(old?.schema===2&&old?.day===day&&marker?.day!==day){console.log('Riprendo lo stesso snapshot non ancora confermato:',old.generation);stage();process.exit(0);}
if(old?.schema===2&&marker?.day===day){console.log('Giornata già pubblicata: nessuna nuova esecuzione.');stage();process.exit(0);}
const diagnostics=[],coverage=[],picks=[],live=new Map();
const persistentHistory=existsSync('data/xg-history.json')?read('data/xg-history.json'):{};
for(const [under,sport,name] of LEAGUES){
  const rows=new Map(archive(under).map(p=>[p.id,p]));
  for(const p of persistentHistory[under]||[])rows.set(p.id,{...p,data:new Date(p.data)});
  for(const yr of [...new Set([season-1,season])])for(const p of await current(under,yr))rows.set(p.id,p);
  const history=[...rows.values()].filter(p=>+p.data<utc(now)).sort((a,b)=>a.data-b.data);
  if(history.length<100)throw Error(`${name}: storico insufficiente`);
  live.set(sport,{history,model:fit(history,day+'T00:00:00Z'),name});
  persistentHistory[under]=history;
  coverage.push({league:name,matches:history.length,lastMatch:history.at(-1).data.toISOString(),downloadedAt:new Date().toISOString()});
}
const sports=[...LEAGUES.map(x=>({key:x[1],name:x[2]})),{key:'soccer_uefa_champs_league',name:'Champions League'}];
const catalog=await json('https://api.the-odds-api.com/v4/sports/?apiKey='+encodeURIComponent(key));
if(!Array.isArray(catalog))throw Error('Catalogo sport non valido');
for(const s of catalog)if(s.active&&(s.key.startsWith('tennis_')||['basketball_nba','basketball_wnba','basketball_euroleague'].includes(s.key)))sports.push({key:s.key,name:s.title});
// Closure requires provider ID AND kickoff AND home/away identities.
const results=new Map();
for(const sport of sports){
  if(sport.key.startsWith('tennis_'))continue;
  if(!ledger.some(p=>p.sport===sport.key&&p.status==='pending'&&utc(p.kickoff)<utc(now)))continue;
  const data=await json(`https://api.the-odds-api.com/v4/sports/${sport.key}/scores/?apiKey=${encodeURIComponent(key)}&daysFrom=3&dateFormat=iso`);
  if(!Array.isArray(data))throw Error('Risultati: schema invalido');
  for(const r of data){
    const home=r.scores?.find(x=>x.name===r.home_team),away=r.scores?.find(x=>x.name===r.away_team);
    if(!home||!away)continue;
    results.set(r.id,{eventId:r.id,home:r.home_team,away:r.away_team,kickoff:new Date(r.commence_time).toISOString(),completed:r.completed,homeGoals:Number(home.score),awayGoals:Number(away.score)});
  }
}
const settled=ledger.map(p=>settleMarket(p,results.get(p.eventId)));
for(const sport of sports){
  // Events discovery is free; avoid spending odds credits for empty days.
  const upcoming=await json(`https://api.the-odds-api.com/v4/sports/${sport.key}/events?apiKey=${encodeURIComponent(key)}`);
  if(!Array.isArray(upcoming))throw Error(`${sport.name}: schema eventi invalido`);
  if(!upcoming.some(e=>localDay(e.commence_time)===day&&utc(e.commence_time)>utc(now))){diagnostics.push(`${sport.name}: nessun evento ancora da iniziare oggi.`);continue;}
  const events=await json(`https://api.the-odds-api.com/v4/sports/${sport.key}/odds/?apiKey=${encodeURIComponent(key)}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`);
  if(!Array.isArray(events))throw Error(`${sport.name}: schema quote invalido`);
  for(const e of events){
    if(typeof e.id!=='string'||!e.id||typeof e.home_team!=='string'||typeof e.away_team!=='string'||e.home_team===e.away_team)throw Error('Identità evento incompleta');
    if(localDay(e.commence_time)!==day||utc(e.commence_time)<=utc(now))continue;
    const outcomes=sport.key.startsWith('soccer_')?['1','X','2']:['1','2'];
    const names=outcomes.length===3?[e.home_team,'Draw',e.away_team]:[e.home_team,e.away_team];
    const market=consensus(e.bookmakers,{names},now);
    if(!market){diagnostics.push(`${e.home_team} – ${e.away_team}: meno di 3 bookmaker completi e freschi.`);continue;}
    const data=live.get(sport.key);let pred=null,context=null;
    if(data){
      const teams=data.model?.forces.squadre||[];
      const homes=teams.filter(n=>canonical(n)===canonical(e.home_team)),aways=teams.filter(n=>canonical(n)===canonical(e.away_team));
      if(homes.length!==1||aways.length!==1){diagnostics.push(`${e.home_team} – ${e.away_team}: identità squadra non verificata; nessuna stima.`);continue;}
      pred=predict(data.model,homes[0],aways[0]);
      if(!pred){diagnostics.push(`${e.home_team} – ${e.away_team}: modello non stimabile, astensione.`);continue;}
      const teamRows=[homes[0],aways[0]].map(n=>data.history.filter(p=>(p.casa===n||p.ospite===n)&&+p.data<Date.parse(day+'T00:00:00Z')));
      context={teamN:Math.min(...teamRows.map(r=>r.length)),seasonN:Math.min(...teamRows.map(r=>r.filter(p=>+p.data>=Date.parse(`${season}-07-01T00:00:00Z`)).length)),historyAgeDays:Math.max(...teamRows.map(r=>(utc(now)-+r.at(-1).data)/864e5))};
    }
    for(let i=0;i<outcomes.length;i++){
      const outcome=outcomes[i];const analysis=pred?assess(pred.p[i],market[i],context):null;
      if(pred&&!analysis)throw Error('Analisi incompleta');
      const p={id:`${e.id}:${outcome}`,eventId:e.id,sport:sport.key,league:sport.name,home:e.home_team,away:e.away_team,
        kickoff:new Date(e.commence_time).toISOString(),outcome,model:pred?.p[i]??null,market:market[i],analysis,context,
        status:'pending',generatedAt:now,version:pred?VERSION:'market-only',trainingMax:data?.model?.trainingMax??null,
        marketQuality:pred?null:(market[i].dispersion<=0.08?'CONSENSO COERENTE':'BOOKMAKER DISCORDI')};
      p.movement=movement(p,old?.picks?.find(q=>q.id===p.id));p.why=explain(p);picks.push(p);
    }
  }
}
const ids=new Set(settled.map(p=>p.id));for(const p of picks)if(!ids.has(p.id)){settled.push(p);ids.add(p.id);}
const selected=selections(picks,now);
const bundle={schema:2,generation:randomUUID(),generatedAt:now,day,zone:POLICY.zone,version:VERSION,policy:POLICY,
  picks,selections:selected,coverage,diagnostics,report,performance:performance(settled),
  pendingOld:settled.filter(p=>p.status==='pending'&&utc(now)-utc(p.kickoff)>3*864e5).length,
  history:settled.filter(p=>p.status==='closed').slice(-300),
  limits:['Nessun esito è certo. Confidence misura la qualità della stima, non la probabilità di vincita.',
    'Rendimento simulato a puntata fissa: migliori quote osservate, esecuzione non garantita, nessun guadagno reale. Quote e disponibilità possono cambiare.',
    'Saldo a quote eque: riferimento teorico ottimistico, non un limite matematico garantito. Le quote reali possono essere inferiori o superiori.',
    'Calcio: modello esclusivamente xG. Meteo, infortuni, forma fisica, formazioni e aspetti psicologici non sono inclusi. La revisione retrospettiva degli xG limita il backtest.',
    'Tennis e basket: consenso dei bookmaker, senza modello indipendente né vantaggio stimato. I risultati del tennis restano in attesa di una fonte che distingua ritiri e regole di liquidazione.',
    'Movimenti delle quote: solo confronti fra due osservazioni dello stesso evento e bookmaker, quando disponibili. Non entrano nel modello e non rappresentano un monitoraggio continuo.',
    'Le categorie VALORE non dimostrano che il modello batta il mercato. Nessun miglioramento promosso.',
    'Storico precedente conservato in data/storico.json; escluso dal nuovo rendimento perché non ha identità verificabile per tutte le righe.']};
// No public writes until all providers and calculations have completed.
writeFileSync('data/ledger.json',JSON.stringify(settled));writeFileSync('data/xg-history.json',JSON.stringify(persistentHistory));writeFileSync('data/release.json',JSON.stringify(bundle,null,2));stage();
console.log(JSON.stringify({generation:bundle.generation,day,picks:picks.length,selected,diagnostics},null,2));
function stage(){mkdirSync('dist',{recursive:true});for(const name of ['index.html','app.js','style.css','ticket.js'])copyFileSync(name,`dist/${name}`);copyFileSync('data/release.json','dist/release.json');writeFileSync('dist/.nojekyll','');}
