// scripts/dataset/23-drawcal-ev-impact.mjs
// FASE 8, punto 17: verifica che DC-DRAW-CAL non produca value bet
// artificialmente peggiori. Stessa strategia EV gia' usata nelle fasi
// precedenti (gioca il segno con EV piu alto, quota di chiusura), applicata
// a baseline vs draw-cal, sul TEST 2025/26 (fold 3, calibrato su
// 2022/23-2024/25, mai visto quella stagione).

import { readFileSync, writeFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));

function isotonicFit(punti) {
  const ordinati = [...punti].sort((a, b) => a.x - b.x);
  const blocchi = ordinati.map(p => ({ sommaY: p.y, n: 1, xMin: p.x, xMax: p.x }));
  let i = 0;
  while (i < blocchi.length - 1) {
    const mA = blocchi[i].sommaY / blocchi[i].n, mB = blocchi[i + 1].sommaY / blocchi[i + 1].n;
    if (mA > mB) { blocchi[i] = { sommaY: blocchi[i].sommaY + blocchi[i + 1].sommaY, n: blocchi[i].n + blocchi[i + 1].n, xMin: blocchi[i].xMin, xMax: blocchi[i + 1].xMax }; blocchi.splice(i + 1, 1); if (i > 0) i--; }
    else i++;
  }
  return blocchi.map(b => ({ xMin: b.xMin, xMax: b.xMax, y: b.sommaY / b.n }));
}
function isotonicPredict(blocchi, x) { for (const b of blocchi) if (x <= b.xMax) return b.y; return blocchi.at(-1).y; }
function rinormalizza(p1, p2, pxCal) { const ro = p1 + p2, rn = 1 - pxCal; const s = ro > 0 ? rn / ro : 0.5; return { P1: p1 * s, PX: pxCal, P2: p2 * s }; }

const righeCal = wf.previsioni.filter(p => ['2022/23', '2023/24', '2024/25'].includes(p.season));
const righeTest = wf.previsioni.filter(p => p.season === '2025/26');
const blocchi = isotonicFit(righeCal.map(p => ({ x: p.modelA.PX, y: p.esito === 'D' ? 1 : 0 })));

function probBase(r) { return [r.modelA.P1, r.modelA.PX, r.modelA.P2]; }
function probCal(r) { const c = rinormalizza(r.modelA.P1, r.modelA.P2, isotonicPredict(blocchi, r.modelA.PX)); return [c.P1, c.PX, c.P2]; }

function selezioni(rows, prob) {
  const out = [];
  for (const r of rows) {
    if (!r.market) continue;
    const p = prob(r); const quote = [r.market.closing_home, r.market.closing_draw, r.market.closing_away]; const lettere = ['H', 'D', 'A'];
    let migliore = null;
    for (let k = 0; k < 3; k++) { if (!(quote[k] > 1)) continue; const ev = p[k] * quote[k] - 1; if (!migliore || ev > migliore.ev) migliore = { esito: lettere[k], ev, prob: p[k], quota: quote[k] }; }
    if (migliore) out.push({ ...r, selezione: migliore });
  }
  return out;
}
function perf(sel, soglia) {
  const g = sel.filter(s => s.selezione.ev >= soglia);
  if (!g.length) return { bets: 0 };
  let vinte = 0, pl = 0, quoteSomma = 0; const serie = [];
  for (const s of g) { const vince = s.selezione.esito === s.esito; const r = vince ? s.selezione.quota - 1 : -1; pl += r; serie.push(r); quoteSomma += s.selezione.quota; if (vince) vinte++; }
  let picco = 0, cum = 0, maxDD = 0; for (const r of serie) { cum += r; picco = Math.max(picco, cum); maxDD = Math.max(maxDD, picco - cum); }
  return { bets: g.length, hit_rate_pct: +(vinte / g.length * 100).toFixed(1), average_odds: +(quoteSomma / g.length).toFixed(2), roi_pct: +(pl / g.length * 100).toFixed(2), max_drawdown: +maxDD.toFixed(2) };
}
function clv(sel) {
  const conAp = sel.filter(s => { const ap = s.selezione.esito === 'H' ? s.market.opening_home : s.selezione.esito === 'D' ? s.market.opening_draw : s.market.opening_away; return ap > 1; });
  if (!conAp.length) return { disponibile: false };
  let somma = 0, batte = 0;
  for (const s of conAp) { const ap = s.selezione.esito === 'H' ? s.market.opening_home : s.selezione.esito === 'D' ? s.market.opening_draw : s.market.opening_away; somma += ap / s.selezione.quota - 1; if (ap > s.selezione.quota) batte++; }
  return { n: conAp.length, clv_medio_pct: +(somma / conAp.length * 100).toFixed(2), pct_batte_chiusura: +(batte / conAp.length * 100).toFixed(1) };
}

const SOGLIE = [0, 0.02, 0.05, 0.075, 0.10];
const selBase = selezioni(righeTest, probBase), selCal = selezioni(righeTest, probCal);

const out = { baseline: { per_soglia: {}, clv: clv(selBase.filter(s => s.selezione.ev >= 0)) }, draw_cal: { per_soglia: {}, clv: clv(selCal.filter(s => s.selezione.ev >= 0)) } };
for (const s of SOGLIE) { out.baseline.per_soglia[`EV>=${(s * 100).toFixed(1)}%`] = perf(selBase, s); out.draw_cal.per_soglia[`EV>=${(s * 100).toFixed(1)}%`] = perf(selCal, s); }

// quante selezioni CAMBIANO segno (draw-cal seleziona un esito diverso da baseline)
let cambiSegno = 0, diventaDraw = 0, smetteDraw = 0;
for (let i = 0; i < selBase.length; i++) {
  const b = selBase[i], c = selCal.find(x => x.match_id === b.match_id);
  if (!c) continue;
  if (b.selezione.esito !== c.selezione.esito) { cambiSegno++; if (c.selezione.esito === 'D') diventaDraw++; if (b.selezione.esito === 'D') smetteDraw++; }
}

writeFileSync('data/backtests/drawcal-ev-impact.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  nota: 'Stessa strategia EV delle fasi precedenti, calibratore fold 3 (calibra su 2022/23-2024/25, valuta 2025/26).',
  ...out,
  cambi_selezione: { totale_confrontabili: selBase.length, cambi_segno: cambiSegno, diventa_draw: diventaDraw, smette_draw: smetteDraw }
}, null, 1));

console.log('EV baseline (TEST):'); console.table(out.baseline.per_soglia);
console.log('EV draw-cal (TEST):'); console.table(out.draw_cal.per_soglia);
console.log('CLV baseline:', JSON.stringify(out.baseline.clv));
console.log('CLV draw-cal:', JSON.stringify(out.draw_cal.clv));
console.log('Cambi di selezione:', JSON.stringify({ cambiSegno, diventaDraw, smetteDraw }, null, 1));
