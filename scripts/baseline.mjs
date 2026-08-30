// scripts/baseline.mjs
// Congela la baseline immutabile del modello ATTUALMENTE in produzione, prima
// di qualsiasi cambio. Usa solo le funzioni originali di model.mjs (le stesse
// che build.mjs chiama oggi, senza il parametro campoXG): il risultato deve
// essere indistinguibile da cio' che la pipeline pubblica in questo momento.
//
// Non serve un solo credito API: le partite da valutare sono quelle gia' in
// data/picks.json (scritte dalla pipeline con le quote gia' pagate), e lo
// storico xG viene da Understat, che e' gratuito.
//
// Una volta scritta, data/baseline-v1.json non si tocca piu'. Rilanciare
// questo script non lo sovrascrive: e' il punto della baseline.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { scaricaUnderstat, stimaForze, stimaRho, lambde, mercati } from './model.mjs';
import { BASELINE_VERSION, MODELLO } from './config.mjs';

const OUT = 'data/baseline-v1.json';

if (existsSync(OUT) && !process.argv.includes('--force')) {
  console.log(`${OUT} esiste gia': la baseline e' immutabile, non la riscrivo.`);
  console.log('Per rigenerarla di proposito (sconsigliato): node scripts/baseline.mjs --force');
  process.exit(0);
}

const LEGA_UNDERSTAT = {
  'Serie A': 'Serie_A', 'Premier League': 'EPL', 'Liga': 'La_liga',
  'Ligue 1': 'Ligue_1', 'Bundesliga': 'Bundesliga'
};

const picks = JSON.parse(readFileSync('data/picks.json', 'utf8'));
const partiteCalcio = (picks.eventi || []).filter(e => e.sport === 'calcio' && e.fonte !== 'consenso');

// una riga per partita, non per pronostico: dedup su "match"
const perPartita = new Map();
for (const p of partiteCalcio) {
  if (!perPartita.has(p.match)) {
    const sep = p.evento.indexOf(' - ');
    perPartita.set(p.match, {
      match: p.match, comp: p.comp, evento: p.evento,
      casa: p.evento.slice(0, sep), ospite: p.evento.slice(sep + 3),
      inizio: p.inizio
    });
  }
}
console.log(`Partite di calcio distinte da valutare: ${perPartita.size}`);

const stagione = String(new Date().getFullYear() - (new Date().getMonth() < 6 ? 1 : 0));
const cacheForze = {};

async function forzeDiLega(comp) {
  if (cacheForze[comp]) return cacheForze[comp];
  const lega = LEGA_UNDERSTAT[comp];
  if (!lega) throw new Error(`Lega sconosciuta: ${comp}`);
  let storico = await scaricaUnderstat(lega, stagione);
  if (storico.length < MODELLO.storicoMinimo)
    storico = [...await scaricaUnderstat(lega, String(Number(stagione) - 1)), ...storico];
  // ESATTAMENTE la chiamata di build.mjs: emivita di default, nessun campoXG
  const forze = stimaForze(storico, { emivita: MODELLO.emivitaGiorni });
  const rho = stimaRho(storico.slice(-300), forze, MODELLO);
  cacheForze[comp] = { forze, rho, nStorico: storico.length };
  return cacheForze[comp];
}

const generatoAlle = new Date().toISOString();
const righe = [];
const saltate = [];

for (const p of perPartita.values()) {
  let ctx;
  try { ctx = await forzeDiLega(p.comp); }
  catch (e) { saltate.push(`${p.evento}: ${e.message}`); continue; }

  const { lh, la } = lambde(ctx.forze, p.casa, p.ospite);
  if (!lh || !la) { saltate.push(`${p.evento}: squadra non trovata nello storico Understat`); continue; }

  const mk = mercati(lh, la, ctx.rho);
  righe.push({
    match_id: p.match,
    data_ora: p.inizio,
    competizione: p.comp,
    home_team: p.casa,
    away_team: p.ospite,
    model_version: BASELINE_VERSION,
    lambda_home: +lh.toFixed(4),
    lambda_away: +la.toFixed(4),
    P1: +mk['1'].toFixed(4),
    PX: +mk['X'].toFixed(4),
    P2: +mk['2'].toFixed(4),
    mercati: Object.fromEntries(Object.entries(mk).map(([k, v]) => [k, +v.toFixed(4)])),
    rho: +ctx.rho.toFixed(4),
    n_storico: ctx.nStorico,
    timestamp_previsione: generatoAlle
  });
}

writeFileSync(OUT, JSON.stringify({
  model_version: BASELINE_VERSION,
  generato_il: generatoAlle,
  nota: 'Baseline immutabile: fotografia del modello in produzione al momento della congelazione. '
    + 'Non va mai rigenerata sovrascrivendo questo file: e la base di paragone per ogni versione successiva.',
  config_usata: { emivitaGiorni: MODELLO.emivitaGiorni, ratingMin: MODELLO.ratingMin, ratingMax: MODELLO.ratingMax,
    campoMin: MODELLO.campoMin, campoMax: MODELLO.campoMax, rhoMin: MODELLO.rhoMin, rhoMax: MODELLO.rhoMax },
  partite: righe,
  saltate
}, null, 1));

console.log(`Baseline scritta: ${righe.length} partite, ${saltate.length} saltate.`);
if (saltate.length) console.log('Saltate:\n- ' + saltate.join('\n- '));
