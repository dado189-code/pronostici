export function pairedBlockBootstrap(rows,metric){
  if(!Array.isArray(rows)||!rows.length||!['brier','logLoss','rps'].includes(metric))throw Error('Campione bootstrap invalido');
  const groups=new Map();
  for(const r of rows){
    const week=Math.floor(Date.parse(r.date)/604800000),d=r.score?.[metric]-r.marketScore?.[metric];
    if(!Number.isFinite(week)||!Number.isFinite(d))throw Error('Riga bootstrap invalida');
    if(!groups.has(week))groups.set(week,[]);groups.get(week).push(d);
  }
  const blocks=[...groups.values()];let seed=71923;
  const rnd=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;};
  const samples=[];for(let i=0;i<3000;i++){let s=0,n=0;for(let k=0;k<blocks.length;k++){const b=blocks[Math.floor(rnd()*blocks.length)];s+=b.reduce((a,v)=>a+v,0);n+=b.length;}samples.push(s/n);}
  samples.sort((a,b)=>a-b);return {difference:rows.reduce((s,r)=>s+r.score[metric]-r.marketScore[metric],0)/rows.length,ci95:[samples[75],samples[2925]],blocks:blocks.length,replicates:3000,seed:71923};
}
