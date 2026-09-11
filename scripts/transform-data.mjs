import {consensus} from './markets.mjs';
import {utc,localDay} from './engine.mjs';
import {validateSnapshot} from '../data-layer.js';
export function transformEvent(event,sport,now) {
  if(!event||typeof event.id!=='string'||!event.id||typeof event.home_team!=='string'||!event.home_team||typeof event.away_team!=='string'||!event.away_team||event.home_team===event.away_team)throw new Error('Identità evento incompleta');
  const kickoff=new Date(utc(event.commence_time)).toISOString();
  if(localDay(kickoff)!==localDay(now)||utc(kickoff)<=utc(now))return null;
  const outcomes=sport.startsWith('soccer_')?['1','X','2']:['1','2'];
  const names=outcomes.length===3?[event.home_team,'Draw',event.away_team]:[event.home_team,event.away_team];
  return {eventId:event.id,home:event.home_team,away:event.away_team,kickoff,outcomes,market:consensus(event.bookmakers,{names},now)};
}
export function transformFixtures(snapshot) {
  validateSnapshot(snapshot);
  return {...structuredClone(snapshot),fixtureInfo:{kind:'last-successful-snapshot',capturedAt:snapshot.generatedAt,generation:snapshot.generation,
    sources:['The Odds API v4: eventi e quote h2h','Understat: xG storici'],
    warning:'Ultimo snapshot completo; verificare data e orario. In modalità fallback gli stake sono sospesi.'}};
}
