import {PUBLIC_ASSETS} from './assets.mjs';
import {readFileSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {due,localDay} from './engine.mjs';
const mode=process.argv[2],read=p=>JSON.parse(readFileSync(p,'utf8'));
const publicURL='https://dado189-code.github.io/pronostici/';
if(mode==='gate'){
  const marker=existsSync('data/published.json')?read('data/published.json'):null;
  const now=new Date();const morningUTC=now.getUTCHours()*60+now.getUTCMinutes()>=6*60+17;
  const proceed=['push','workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)||(morningUTC&&marker?.day!==localDay(now.toISOString()));
  appendFileSync(process.env.GITHUB_OUTPUT,`proceed=${proceed}\n`);console.log('Esecuzione richiesta:',proceed);
}else if(mode==='verify'){
  const expected=read('data/release.json');let verified=false;
  const digest=s=>createHash('sha256').update(s).digest('hex');
  for(let i=0;i<18;i++){
    try{
      const r=await fetch(publicURL+'release.json?generation='+expected.generation,{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!r.ok)throw Error('HTTP '+r.status);const text=await r.text();
      if(digest(text)!==digest(readFileSync('data/release.json')))throw Error('Snapshot non corrispondente');
      for(const name of PUBLIC_ASSETS){
        const asset=await fetch(publicURL+(name==='index.html'?'':name)+'?generation='+expected.generation,{cache:'no-store',signal:AbortSignal.timeout(15000)});
        if(!asset.ok||digest(await asset.text())!==digest(readFileSync(name)))throw Error('Asset non corrispondente');
      }
      verified=true;break;
    }catch{console.log('Pubblicazione non ancora verificata, tentativo',i+1);await new Promise(r=>setTimeout(r,10000));}
  }
  if(!verified)throw Error('Deploy non verificato: nessuna notifica di successo');
  writeFileSync('data/published.json',JSON.stringify({day:expected.day,generation:expected.generation,verifiedAt:new Date().toISOString(),url:publicURL},null,2));
  console.log('Verificati snapshot e tutti gli asset online:',expected.generation);
}else if(mode==='notify'||mode==='failure'){
  const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chat)throw Error('Telegram non configurato');
  let message;
  if(mode==='notify'){
    const d=read('data/release.json'),m=read('data/published.json');if(m.generation!==d.generation)throw Error('Generazione non verificata');
    const find=id=>d.picks.find(p=>p.id===id);
    const line=(label,id)=>{const p=find(id);return label+': '+(p?`${p.home} – ${p.away}, ${p.outcome} @ ${p.market.odds.toFixed(2)}`:'nessuna selezione idonea');};
    message=[`Prono · aggiornamento verificato ${d.day}`,line('Singola prudente',d.selections.single),
      'Combinata: '+(d.selections.combo?`${d.selections.combo.legs.length} eventi @ ${d.selections.combo.odds.toFixed(2)}`:'nessuna selezione idonea'),line('Alta quota',d.selections.high),
      `${d.picks.length} esiti analizzati. Nessun esito certo.`,publicURL].join('\n');
  }else message='Prono: aggiornamento o notifica non riusciti. Nessuna conferma di successo. Verifica il workflow: https://github.com/dado189-code/pronostici/actions';
  try{
    const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chat,text:message,disable_web_page_preview:true}),signal:AbortSignal.timeout(20000)});
    const d=await r.json();if(!r.ok||!d.ok)throw Error('Invio rifiutato');console.log('Telegram: consegna API confermata, message_id',d.result.message_id);
  }catch{throw Error('Invio Telegram fallito; controllare configurazione e rete.');}
}else throw Error('Modalità non valida');
