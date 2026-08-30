// scripts/baseline-provenance.mjs
// Arricchisce data/baseline-v1.json con i metadati di provenance mancanti:
// git_commit_sha, formula Dixon-Coles, provider dati, training window.
// NON tocca un solo numero gia' scritto (lambda, P1/PX/P2, mercati, rho per
// partita): legge la baseline esistente e la riscrive identica nei valori,
// aggiungendo solo l'inviluppo che manca. E' una correzione di tracciabilita',
// non una rigenerazione: se cambiasse anche un solo valore numerico rispetto
// all'originale, questo script deve fallire, non scrivere.
//
// Limite dichiarato: il training window esatto (data minima/massima delle
// partite storiche usate per stimare le forze) non fu registrato quando la
// baseline venne creata, e Understat potrebbe nel frattempo aver aggiunto
// partite piu' recenti alla stessa stagione: non si puo' ricostruirlo a
// posteriori senza rischiare di descrivere uno storico diverso da quello
// realmente usato. Si dichiara "non disponibile retroattivamente" invece di
// stimarlo. Da questa versione in poi (baseline.mjs) il training window
// viene salvato al momento della generazione, non ricostruito dopo.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { BASELINE_VERSION, MODELLO } from './config.mjs';

const PATH = 'data/baseline-v1.json';
const originale = JSON.parse(readFileSync(PATH, 'utf8'));

// il commit che ha introdotto il file, non l'HEAD corrente: e' quello il
// punto nel tempo a cui la baseline si riferisce davvero
const commitCreazione = execSync(
  `git log --diff-filter=A --format=%H -- ${PATH}`, { encoding: 'utf8' }
).trim().split('\n').pop();

if (!commitCreazione) throw new Error('Impossibile trovare il commit che ha creato la baseline');

const arricchita = {
  ...originale,
  provenance: {
    git_commit_sha: commitCreazione,
    provider_dati: 'Understat (endpoint understat.com/getLeagueData/{lega}/{stagione})',
    formula_dixon_coles: {
      descrizione: 'Correzione ai quattro punteggi piu bassi rispetto a Poisson indipendente',
      tau_0_0: '1 - lambda_home * lambda_away * rho',
      tau_0_1: '1 + lambda_home * rho',
      tau_1_0: '1 + lambda_away * rho',
      tau_1_1: '1 - rho',
      altri_punteggi: '1 (nessuna correzione)'
    },
    decay: { tipo: 'esponenziale', formula: 'peso = 0.5 ^ (eta_giorni / emivitaGiorni)', emivitaGiorni: MODELLO.emivitaGiorni },
    rho: { metodo: 'massima verosimiglianza a griglia sui gol veri (non sugli xG)',
      rhoMin: MODELLO.rhoMin, rhoMax: MODELLO.rhoMax, rhoPasso: MODELLO.rhoPasso,
      nota: 'per-lega, valore in partite[].rho' },
    training_window: {
      disponibile: false,
      motivo: 'non registrato al momento della generazione; ricostruirlo oggi rischierebbe di '
        + 'descrivere uno storico diverso da quello realmente usato, perche Understat puo aver '
        + 'aggiunto partite alla stessa stagione nel frattempo. Riportato solo n_storico (conteggio) '
        + 'per ogni lega in partite[].n_storico. Corretto per le baseline generate da questa versione in poi.'
    },
    corretto_il: new Date().toISOString(),
    nota_immutabilita: 'Questo arricchimento aggiunge solo metadati di tracciabilita. '
      + 'Nessun valore numerico gia presente (lambda, P1/PX/P2, mercati, rho) e stato ricalcolato.'
  }
};

// guardia: verifica bit per bit che i valori numerici non siano cambiati
for (let i = 0; i < originale.partite.length; i++) {
  const a = originale.partite[i], b = arricchita.partite[i];
  for (const campo of ['lambda_home', 'lambda_away', 'P1', 'PX', 'P2', 'rho', 'n_storico', 'match_id'])
    if (a[campo] !== b[campo])
      throw new Error(`Guardia fallita: ${campo} di ${a.match_id} e cambiato. Interrotto senza scrivere.`);
}

writeFileSync(PATH, JSON.stringify(arricchita, null, 1));
console.log(`Provenance aggiunta a ${PATH}. Commit di creazione: ${commitCreazione}.`);
console.log('Verificato: nessun valore numerico delle partite e cambiato.');
