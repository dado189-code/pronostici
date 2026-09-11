import {readFileSync} from 'node:fs';
import {validMatch} from './engine.mjs';
export const LEAGUES=[['Serie_A','soccer_italy_serie_a','Serie A'],['EPL','soccer_epl','Premier League'],['La_liga','soccer_spain_la_liga','Liga'],['Bundesliga','soccer_germany_bundesliga','Bundesliga'],['Ligue_1','soccer_france_ligue_one','Ligue 1']];
export function parseUnderstat(data){
  if(!Array.isArray(data?.dates))throw Error('Understat: dates assente');
  const rows=data.dates.filter(p=>p.isResult).map(p=>({id:String(p.id),data:new Date(p.datetime.replace(' ','T').replace(/Z$/,'')+'Z'),
    casa:p.h.title,ospite:p.a.title,xgCasa:p.xG.h===null?NaN:Number(p.xG.h),xgOspite:p.xG.a===null?NaN:Number(p.xG.a),golCasa:p.goals.h===null?NaN:Number(p.goals.h),golOspite:p.goals.a===null?NaN:Number(p.goals.a)}));
  if(rows.some(p=>!validMatch(p)))throw Error('Understat: partita completata con dati mancanti');
  if(new Set(rows.map(p=>p.id)).size!==rows.length)throw Error('Understat: ID duplicati');
  return rows;
}
export function archive(league){
  const map=new Map();for(const year of [2022,2023,2024,2025]){
    const d=JSON.parse(readFileSync(`data/raw/understat/${league}-${year}.json`,'utf8'));
    for(const p of parseUnderstat(d.data))map.set(p.id,p);
  }return [...map.values()].sort((a,b)=>a.data-b.data);
}
export async function json(url,headers={}){
  for(let i=0;i<3;i++){
    try{const r=await fetch(url,{headers,signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(`HTTP ${r.status}`);return await r.json();}
    catch(e){if(i===2)throw Error(`Fonte non disponibile: ${e instanceof SyntaxError?'JSON invalido':e.message.replace(/https?:\/\/\S+/g,'[URL]')}`);await new Promise(r=>setTimeout(r,1000*(i+1)));}
  }
}
export async function current(league,year){
  return parseUnderstat(await json(`https://understat.com/getLeagueData/${league}/${year}`,{'User-Agent':'Mozilla/5.0','X-Requested-With':'XMLHttpRequest','Referer':`https://understat.com/league/${league}/${year}`}));
}
// Explicit name equivalences only; no prefix/fuzzy matching.
const aliases={'internazionale':'inter','inter milan':'inter','ac milan':'milan','as roma':'roma','ssc napoli':'napoli','hellas verona':'verona','parma calcio 1913':'parma','manchester utd':'manchester united','wolverhampton wanderers':'wolves','tottenham hotspur':'tottenham','brighton and hove albion':'brighton','nottm forest':'nottingham forest','athletic club':'athletic bilbao','atletico de madrid':'atletico madrid','celta de vigo':'celta vigo','paris saint germain':'psg','olympique marseille':'marseille','olympique lyonnais':'lyon','olympique lyon':'lyon','bayern munich':'bayern munchen','borussia dortmund':'dortmund','bayer leverkusen':'leverkusen','eintracht frankfurt':'frankfurt','1 fc koln':'cologne','fc cologne':'cologne','tsg hoffenheim':'hoffenheim','rb leipzig':'rasenballsport leipzig','fsv mainz 05':'mainz 05'};
export function canonical(n){const s=n.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();return aliases[s]||s;}
