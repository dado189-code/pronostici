// scripts/confronto.mjs
// Confronto automatico BASELINE vs NUOVO MODELLO, richiesto esplicitamente
// prima di accettare qualunque cambio come miglioramento. Ricalcola le STESSE
// partite della baseline con MODEL_VERSION (oggi: solo npxG al posto di xG
// grezzo, tutto il resto della pipeline identico) e mostra i delta.
//
// Questo NON e' un giudizio di qualita': un delta grande non vuol dire che il
// nuovo modello sia migliore, vuol dire solo che e' diverso. Il giudizio vero
// (Brier, log loss, RPS) arriva con la FASE 4 e il dataset storico, quando
// esistono i risultati veri contro cui misurare entrambe le versioni.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { scaricaUnderstatCompleto, stimaForze, stimaRho, lambde, mercati } from './model.mjs';
import { MODEL_VERSION, MODELLO } from './config.mjs';

const OUT = 'data/confronto-baseline.json';

if (!existsSync('data/baseline-v1.json')) {
  console.error('Manca data/baseline-v1.json: lanciare prima node scripts/baseline.mjs');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync('data/baseline-v1.json', 'utf8'));

const LEGA_UNDERSTAT = {
  'Serie A': 'Serie_A', 'Premier League': 'EPL', 'Liga': 'La_liga',
  'Ligue 1': 'Ligue_1', 'Bundesliga': 'Bundesliga'
};

const stagione = String(new Date().getFullYear() - (new Date().getMonth() < 6 ? 1 : 0));
const cache = {};

async function contestoDiLega(comp) {
  if (cache[comp]) return cache[comp];
  const lega = LEGA_UNDERSTAT[comp];
  let { partite: storico } = await scaricaUnderstatCompleto(lega, stagione);
  if (storico.length < MODELLO.storicoMinimo) {
    const prec = await scaricaUnderstatCompleto(lega, String(Number(stagione) - 1));
    storico = [...prec.partite, ...storico];
  }
  const joinFalliti = storico.filter(p => p.joinRiuscito === false).length;
  // FASE 2 punto 5: npxG affiancato a xG, non lo sostituisce di nascosto.
  const forzeNpxg = stimaForze(storico, { emivita: MODELLO.emivitaGiorni, campoXG: 'npxg' });
  const rhoNpxg = stimaRho(storico.slice(-300), forzeNpxg, MODELLO);
  cache[comp] = { forzeNpxg, rhoNpxg, joinFalliti, nStorico: storico.length };
  return cache[comp];
}

const righe = [];
const generatoAlle = new Date().toISOString();

for (const base of baseline.partite) {
  let ctx;
  try { ctx = await contestoDiLega(base.competizione); }
  catch (e) { righe.push({ match_id: base.match_id, errore: e.message }); continue; }

  const { lh, la } = lambde(ctx.forzeNpxg, base.home_team, base.away_team);
  if (!lh || !la) { righe.push({ match_id: base.match_id, errore: 'squadra non trovata con npxG' }); continue; }

  const mk = mercati(lh, la, ctx.rhoNpxg);
  const nuovo = {
    model_version: MODEL_VERSION,
    lambda_home: +lh.toFixed(4), lambda_away: +la.toFixed(4),
    P1: +mk['1'].toFixed(4), PX: +mk['X'].toFixed(4), P2: +mk['2'].toFixed(4)
  };

  const fattori = [];
  if (ctx.joinFalliti > 0) fattori.push(`${ctx.joinFalliti} partite storiche senza npxG disponibile (fallback su xG per quelle)`);
  fattori.push(`fonte gol attesi: xG grezzo (baseline) -> npxG, gol da azione senza rigori (nuovo)`);
  const deltaLambdaHome = nuovo.lambda_home - base.lambda_home;
  if (Math.abs(deltaLambdaHome) > 0.05)
    fattori.push(`lambda_home cambia di ${deltaLambdaHome > 0 ? '+' : ''}${deltaLambdaHome.toFixed(3)}: `
      + `la differenza fra xG e npxG per ${base.home_team} o i suoi avversari recenti pesa nel fit`);

  righe.push({
    match_id: base.match_id, evento: `${base.home_team} - ${base.away_team}`, competizione: base.competizione,
    baseline: { model_version: base.model_version, lambda_home: base.lambda_home, lambda_away: base.lambda_away,
      P1: base.P1, PX: base.PX, P2: base.P2 },
    nuovo,
    delta: {
      lambda_home: +(nuovo.lambda_home - base.lambda_home).toFixed(4),
      lambda_away: +(nuovo.lambda_away - base.lambda_away).toFixed(4),
      P1: +(nuovo.P1 - base.P1).toFixed(4),
      PX: +(nuovo.PX - base.PX).toFixed(4),
      P2: +(nuovo.P2 - base.P2).toFixed(4)
    },
    fattori
  });
}

const validi = righe.filter(r => !r.errore);
const riepilogo = {
  nConfrontate: validi.length,
  nErrori: righe.length - validi.length,
  deltaP1MedioAssoluto: validi.length ? +(validi.reduce((a, r) => a + Math.abs(r.delta.P1), 0) / validi.length).toFixed(4) : null,
  deltaP1Massimo: validi.length ? validi.reduce((m, r) => Math.abs(r.delta.P1) > Math.abs(m.delta.P1) ? r : m) : null
};

writeFileSync(OUT, JSON.stringify({
  generato_il: generatoAlle,
  baseline_version: baseline.model_version,
  nuovo_version: MODEL_VERSION,
  nota: 'Confronto descrittivo, non un giudizio di qualita: dice quanto le probabilita si spostano, '
    + 'non se lo spostamento e un miglioramento. Il giudizio arriva dal backtest con risultati reali (FASE 4).',
  riepilogo: {
    nConfrontate: riepilogo.nConfrontate, nErrori: riepilogo.nErrori,
    deltaP1MedioAssoluto: riepilogo.deltaP1MedioAssoluto,
    partitaConMaggiorDelta: riepilogo.deltaP1Massimo ? riepilogo.deltaP1Massimo.evento : null,
    maggiorDeltaP1: riepilogo.deltaP1Massimo ? riepilogo.deltaP1Massimo.delta.P1 : null
  },
  partite: righe
}, null, 1));

console.log(`Confronto scritto: ${riepilogo.nConfrontate} partite, ${riepilogo.nErrori} errori.`);
console.log(`Delta P1 medio assoluto: ${riepilogo.deltaP1MedioAssoluto}`);
if (riepilogo.deltaP1Massimo)
  console.log(`Maggior delta P1: ${riepilogo.deltaP1Massimo.evento} (${riepilogo.deltaP1Massimo.delta.P1})`);
