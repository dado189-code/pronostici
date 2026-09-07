// scripts/risultati.mjs
// Disambiguazione fra piu' partite Understat con la stessa coppia
// "Casa - Ospite" (stagioni diverse). BUG TROVATO IL 07/09/2026: indicizzare
// i risultati solo per nomi squadra, senza data, fa sovrascrivere in
// silenzio la partita giusta con una di una stagione precedente quando le
// stesse due squadre si incontrano piu' di una volta (caso frequente: stesso
// campionato l'anno prima, playoff, Coppa). 176/239 pronostici chiusi in
// archivio avevano il risultato sbagliato per questo motivo prima della
// correzione. Funzione pura, isolata qui apposta per poterla testare senza
// eseguire chiudi.mjs (che ha effetti collaterali: rete, scrittura file).

// Fra piu' partite Understat con la stessa coppia "Casa - Ospite", sceglie
// quella con la data piu' vicina al kickoff del pronostico da liquidare.
// Oltre 3 giorni di distanza non e' la stessa partita: meglio restare
// pendenti (o segnalare un caso irrisolvibile) che liquidare con quella sbagliata.
export function partitaPiuVicina(candidati, inizioIso, tolleranzaMs = 3 * 864e5) {
  if (!candidati || !candidati.length) return null;
  const riferimento = typeof inizioIso === 'number' ? inizioIso : Date.parse(inizioIso);
  if (!Number.isFinite(riferimento)) return null;
  let scelta = null, migliorDiff = Infinity;
  for (const c of candidati) {
    const dataCandidato = c.data instanceof Date ? c.data.getTime() : Date.parse(c.data);
    if (!Number.isFinite(dataCandidato)) continue;
    const diff = Math.abs(dataCandidato - riferimento);
    if (diff < migliorDiff) { migliorDiff = diff; scelta = c; }
  }
  return migliorDiff <= tolleranzaMs ? scelta : null;
}

// Raggruppa un elenco di partite Understat per "Casa - Ospite", MAI
// sovrascrivendo (a differenza della vecchia indicizzazione a oggetto piatto):
// ogni coppia porta con se' TUTTE le partite trovate, la scelta fra loro
// spetta a partitaPiuVicina.
export function raggruppaPerSquadre(partite) {
  const gruppi = {};
  for (const p of partite) {
    if (!Number.isFinite(p.golCasa) || !Number.isFinite(p.golOspite)) continue;
    const k = `${p.casa} - ${p.ospite}`;
    (gruppi[k] ??= []).push(p);
  }
  return gruppi;
}
