// scripts/snapshot.mjs
// Snapshot immutabile delle previsioni prima del calcio d'inizio. Una volta
// scritto un id, non viene mai piu' sovrascritto da questo file: e' quello
// che rende possibile verificare a posteriori cosa il modello diceva PRIMA
// di sapere il risultato, anche se nel frattempo il modello o i dati cambiano.
//
// L'id deve essere stabile fra un'esecuzione e l'altra e distinguere pronostici
// diversi sulla stessa partita: stessa logica di idDi() in chiudi.mjs, cosi'
// i due file restano confrontabili sullo stesso identificativo.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const idSnapshot = (p) =>
  [p.match, p.inizio || p.quando, p.tipo || 'standard', p.mercato, p.model_version].join('|');

// upsert-immutabile: aggiunge solo i record il cui id non esiste gia'.
// Ritorna quanti ne ha aggiunti e quanti ne ha lasciati stare perche' gia' presenti.
export function salvaSnapshot(percorso, nuoviRecord) {
  const esistenti = existsSync(percorso) ? JSON.parse(readFileSync(percorso, 'utf8')) : { snapshot: [] };
  const lista = Array.isArray(esistenti.snapshot) ? esistenti.snapshot : [];
  const gia = new Set(lista.map(r => r.snapshot_id));

  let aggiunti = 0, ignorati = 0;
  for (const r of nuoviRecord) {
    const id = idSnapshot(r);
    if (gia.has(id)) { ignorati++; continue; }
    lista.push({ snapshot_id: id, ...r });
    gia.add(id);
    aggiunti++;
  }

  writeFileSync(percorso, JSON.stringify({
    nota: 'Ogni riga e immutabile una volta scritta: non viene mai aggiornata da esecuzioni successive, '
      + 'nemmeno se il modello o i dati di input cambiano. Serve a verificare a posteriori cosa il '
      + 'modello prevedeva PRIMA del kickoff, senza il rischio che lo storico si riscriva da solo.',
    aggiornato: new Date().toISOString(),
    snapshot: lista
  }, null, 1));

  return { aggiunti, ignorati, totale: lista.length };
}
