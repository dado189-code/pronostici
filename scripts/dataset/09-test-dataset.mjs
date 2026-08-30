// scripts/dataset/09-test-dataset.mjs
// STEP 22: test sul dataset e sul backtest della FASE 4. Diverso da
// scripts/test.mjs (quello gira in CI a ogni esecuzione della pipeline,
// senza rete, e riguarda il motore in produzione). Questo legge i file
// generati dagli script 01-08: si esegue offline, a mano, dopo aver
// rigenerato il dataset, non fa parte del workflow giornaliero.

import { readFileSync } from 'node:fs';

let ok = 0, ko = 0;
const fail = [];
const assertVero = (nome, cond, dettaglio = '') => { if (cond) ok++; else { ko++; fail.push(`${nome}: ${dettaglio}`); } };

// ---------------------------------------------------------------- team mapping

{
  const aliasFile = JSON.parse(readFileSync('data/team-aliases.json', 'utf8'));
  assertVero('Team mapping: Man United -> Manchester United', aliasFile.mappa['Man United'] === 'Manchester United');
  assertVero('Team mapping: nessun alias e la stringa vuota', Object.values(aliasFile.mappa).every(v => v.length > 0));
  assertVero('Team mapping: nessun alias mappa una squadra su se stessa (sarebbe inutile)',
    Object.entries(aliasFile.mappa).every(([k, v]) => k !== v));
}

// ---------------------------------------------------------------- join e completezza

{
  const report = JSON.parse(readFileSync('data/normalized/report-qualita-join.json', 'utf8'));
  assertVero('Dataset completeness: almeno il 95% delle partite unito globalmente',
    report.globale.pct_matched >= 95, `trovato ${report.globale.pct_matched}%`);
  for (const r of report.perLegaStagione)
    assertVero(`Join quality: ${r.league} ${r.season} sopra il 60%`, r.pct_matched >= 60, `trovato ${r.pct_matched}%`);
  assertVero('Join: zero ambiguita in tutte le lega/stagione (il join esatto non ne deve produrre)',
    report.perLegaStagione.every(r => r.ambiguous === 0));
}

// ---------------------------------------------------------------- duplicati e coerenza

{
  const ds = JSON.parse(readFileSync('data/normalized/dataset-matched.json', 'utf8')).partite;
  const idSet = new Set(ds.map(r => r.match_id));
  assertVero('Duplicate match detection: nessun match_id duplicato', idSet.size === ds.length,
    `${ds.length} righe, ${idSet.size} id unici`);
  assertVero('Join date/team: ogni riga matched ha data valida', ds.every(r => !isNaN(Date.parse(r.date))));
  assertVero('Join date/team: ogni riga matched ha squadre non vuote', ds.every(r => r.home_team && r.away_team));
  assertVero('Schema: goals sempre numerici', ds.every(r => Number.isFinite(r.goals_home) && Number.isFinite(r.goals_away)));
}

// ---------------------------------------------------------------- walk-forward e leakage

{
  const dati = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
  const perLega = {};
  for (const p of dati.previsioni) (perLega[p.league] ||= []).push(p);

  for (const [lega, righe] of Object.entries(perLega)) {
    const date = righe.map(r => new Date(r.date).getTime());
    let ordinato = true;
    for (let i = 1; i < date.length; i++) if (date[i] < date[i - 1]) ordinato = false;
    assertVero(`Chronological sorting: ${lega} in ordine non decrescente`, ordinato);
  }

  assertVero('Walk-forward: ogni previsione ha almeno lo storico minimo dichiarato',
    dati.previsioni.every(p => p.n_storico >= dati.minimoStorico));
  assertVero('Feature leakage: probabilita sempre in [0,1] per entrambi i modelli',
    dati.previsioni.every(p =>
      [p.modelA.P1, p.modelA.PX, p.modelA.P2, p.modelB.P1, p.modelB.PX, p.modelB.P2].every(v => v >= 0 && v <= 1)));
  assertVero('Feature leakage: P1+PX+P2 = 1 per entrambi i modelli su ogni previsione',
    dati.previsioni.every(p => Math.abs(p.modelA.P1 + p.modelA.PX + p.modelA.P2 - 1) < 1e-3
      && Math.abs(p.modelB.P1 + p.modelB.PX + p.modelB.P2 - 1) < 1e-3));
}

// ---------------------------------------------------------------- no-vig e mercato

{
  const dati = JSON.parse(readFileSync('data/dataset/previsioni-walkforward.json', 'utf8'));
  const conMercato = dati.previsioni.filter(p => p.market);
  assertVero('No-vig: ci sono previsioni con mercato disponibile', conMercato.length > 0);
  assertVero('No-vig: P1+PX+P2 del mercato sommano a 1',
    conMercato.every(p => Math.abs(p.market.P1 + p.market.PX + p.market.P2 - 1) < 1e-3));
}

// ---------------------------------------------------------------- Elo persistente

{
  const elo = JSON.parse(readFileSync('data/elo/elo-storico.json', 'utf8'));
  assertVero('Elo sequencing: la storia e in ordine cronologico non decrescente',
    elo.storia.every((h, i) => i === 0 || new Date(h.data) >= new Date(elo.storia[i - 1].data)));
// Continuita' attesa SOLO dentro la stessa stagione: fra una stagione e la
// successiva la regressione parziale sposta l'Elo di proposito (correzione 3),
// quindi una discontinuita' li' e' il comportamento corretto, non leakage.
{
  const perSquadra = {};
  let rotture_fuori_stagione = 0;
  for (const h of elo.storia) {
    for (const [sq, stag, prima, dopo] of [[h.casa, h.stagione, h.eloCasaPrima, h.eloCasaDopo], [h.ospite, h.stagione, h.eloOspitePrima, h.eloOspiteDopo]]) {
      const prec = perSquadra[sq];
      if (prec && prec.stagione === stag && Math.abs(prec.dopo - prima) > 0.5) rotture_fuori_stagione++;
      perSquadra[sq] = { dopo, stagione: stag };
    }
  }
  assertVero('Elo sequencing: continuita perfetta ALL INTERNO della stessa stagione (nessun leakage)',
    rotture_fuori_stagione === 0, `${rotture_fuori_stagione} rotture trovate dentro la stessa stagione`);
}
  assertVero('Season transition: nessuna squadra con Elo finale a valori assurdi (fuori [1000,2200])',
    Object.values(elo.perLega).every(l => Object.values(l.eloFinale).every(e => e > 1000 && e < 2200)));
}

console.log(`\n${ok} test superati, ${ko} falliti.`);
if (fail.length) { console.log('Falliti:\n- ' + fail.join('\n- ')); process.exit(1); }
