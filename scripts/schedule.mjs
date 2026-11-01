// Ore locali (Europe/Rome) in cui lo scheduler automatico puo' consumare crediti API. Su richiesta: 10 e 18.
// Tenuto fuori da engine.mjs: engine.mjs e' coperto dall'hash di audit del backtest (data/audit/report.json).
export const SCHEDULE_HOURS=[10,18];
export function scheduledSlot(now,zone='Europe/Rome',hours=SCHEDULE_HOURS) {
const h=+new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).find(x=>x.type==='hour').value;
return hours.includes(h);
}
