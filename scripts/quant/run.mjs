import {readFileSync} from 'node:fs';
import * as engine from './index.mjs';
const file=process.argv[2];
if(!file){process.stderr.write('Uso: node scripts/quant/run.mjs richiesta.json\n');process.exitCode=1;}
else {
 try {
  const request=JSON.parse(readFileSync(file,'utf8'));
  const operations={
   football:()=>engine.predictFootball(engine.fitFootball(request.history,request.asOf,{halfLifeDays:request.halfLifeDays}),request.home,request.away),
   tennis:()=>engine.predictTennis(engine.tennisSurfaceStats(request.playerA,{surface:request.surface,asOf:request.asOf,halfLifeDays:request.halfLifeDays}),engine.tennisSurfaceStats(request.playerB,{surface:request.surface,asOf:request.asOf}),request.format),
   basketball:()=>engine.predictBasketball(engine.fitBasketball(request.history,{asOf:request.asOf,ridge:request.ridge,halfLifeDays:request.halfLifeDays}),request.match,request.residuals?engine.fitBasketballResiduals(request.residuals,{asOf:request.asOf}):null),
   value:()=>engine.evaluateValue(request.input)
  };
  if(!Object.hasOwn(operations,request.operation))throw new Error('Operazione non supportata');
  process.stdout.write(JSON.stringify({ok:true,result:operations[request.operation]()},null,2)+'\n');
 }catch(error){process.stderr.write(JSON.stringify({ok:false,error:error.message})+'\n');process.exitCode=1;}
}
