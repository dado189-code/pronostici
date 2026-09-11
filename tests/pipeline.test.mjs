// Full pipeline integration in an isolated temporary directory; fixtures never reach production.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=resolve('.');
function cleanup(dir){assert.ok(resolve(dir).startsWith(join(resolve(tmpdir()),'prono-test-')));rmSync(dir,{recursive:true,force:true});}
function setup(){
  const dir=mkdtempSync(join(tmpdir(),'prono-test-'));
  mkdirSync(join(dir,'data/raw/understat'),{recursive:true});mkdirSync(join(dir,'data/audit'),{recursive:true});
  cpSync(join(root,'scripts'),join(dir,'scripts'),{recursive:true});for(const f of ['index.html','app.js','style.css','ticket.js','data-layer.js','data/fixtures.json'])cpSync(join(root,f),join(dir,f));
  const dates=Array.from({length:110},(_,i)=>({id:String(i),isResult:true,datetime:new Date(Date.UTC(2026,4,i+1)).toISOString().slice(0,19).replace('T',' '),h:{title:i%2?'A':'B'},a:{title:i%2?'B':'A'},xG:{h:'1.4',a:'1.1'},goals:{h:'1',a:'1'}}));
  for(const key of ['Serie_A','EPL','La_liga','Bundesliga','Ligue_1'])for(const year of [2022,2023,2024,2025])writeFileSync(join(dir,`data/raw/understat/${key}-${year}.json`),JSON.stringify({data:{dates}}));
  const engineHash=createHash('sha256').update(readFileSync(join(root,'scripts/model.mjs'),'utf8').replace(/\r\n/g,'\n')).update(readFileSync(join(root,'scripts/engine.mjs'),'utf8').replace(/\r\n/g,'\n')).digest('hex');
  writeFileSync(join(dir,'data/audit/report.json'),JSON.stringify({engineHash,splits:{test:{n:1000}},fixture:true}));
  writeFileSync(join(dir,'mock.mjs'),`
const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2026-09-11T12:07:00.000Z']));}static now(){return +new OriginalDate('2026-09-11T12:07:00.000Z');}};
globalThis.fetch=async (url)=>{
 const u=new URL(url);if(process.env.FAIL_SOURCE==='yes'&&u.hostname==='understat.com')return {ok:false,status:503};
 if(u.pathname==='/v4/sports/')return {ok:true,json:async()=>[{key:'tennis_atp_test',title:'ATP test',active:true},{key:'basketball_wnba',title:'WNBA',active:true}]};
 const sport=u.pathname.split('/')[3];
 const event={id:sport,home_team:'A',away_team:'B',commence_time:'2026-09-11T18:00:00Z'};
 const books=['a','b','c'].map(key=>({key,title:key,last_update:'2026-09-11T12:00:00Z',markets:[{key:'h2h',outcomes:[{name:'A',price:2.6},...(sport.startsWith('soccer_')?[{name:'Draw',price:3.4}]:[]),{name:'B',price:2.8}]}]}));
 return {ok:true,json:async()=>u.hostname==='understat.com'?{dates:[]}:u.pathname.endsWith('/events')?[event]:[{...event,bookmakers:books}]};
};`);
  return dir;
}
function run(dir,script,extra={}){return spawnSync(process.execPath,['--import',pathToFileURL(join(dir,'mock.mjs')).href,join(dir,script)],{cwd:dir,encoding:'utf8',env:{...process.env,ODDS_API_KEY:'test-only',...extra},timeout:30000});}
test('pipeline builds complete valid snapshot and resumes without duplicate ledger entries',()=>{
  const dir=setup();try{
    const first=run(dir,'scripts/release.mjs');assert.equal(first.status,0,first.stderr);
    const result=JSON.parse(readFileSync(join(dir,'data/release.json')));assert.equal(result.coverage.length,5);assert.equal(result.picks.length,22);
    const check=run(dir,'scripts/check-release.mjs');assert.equal(check.status,0,check.stderr);
    const before=readFileSync(join(dir,'data/ledger.json'),'utf8');const second=run(dir,'scripts/release.mjs');assert.equal(second.status,0,second.stderr);assert.equal(readFileSync(join(dir,'data/ledger.json'),'utf8'),before);
    assert.equal(JSON.parse(readFileSync(join(dir,'data/release.json'))).generation,result.generation);
  }finally{cleanup(dir);}
});
test('provider failure cannot publish a partial snapshot or erase existing ledger',()=>{
  const dir=setup();try{
    writeFileSync(join(dir,'data/ledger.json'),'[]');const r=run(dir,'scripts/release.mjs',{FAIL_SOURCE:'yes'});
    assert.notEqual(r.status,0);assert.match(r.stderr,/Fonte non disponibile/);assert.equal(existsSync(join(dir,'data/release.json')),false);assert.equal(existsSync(join(dir,'dist')),false);assert.equal(readFileSync(join(dir,'data/ledger.json'),'utf8'),'[]');
  }finally{cleanup(dir);}
});
