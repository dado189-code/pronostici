// scripts/tempo.mjs
// Conversione data-locale per il filtro "solo oggi" di Cassaforte/Quota2/
// Sorpresa/Best Picks/High Risk. Usa SEMPRE il timestamp ISO (`inizio`,
// UTC), mai la stringa gia' localizzata `quando`: un kickoff serale puo'
// cadere gia' nel giorno dopo in Europe/Rome (es. 2026-08-30T22:30:00Z e'
// gia' 31/08 con l'ora legale, UTC+2).

// en-CA formatta come YYYY-MM-DD direttamente: nessun parsing manuale di
// MM/DD/YYYY (che sarebbe il formato di en-US) o rischio di ambiguita'.
export function dataLocale(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function oggiLocale(timeZone, riferimento = new Date()) {
  return dataLocale(riferimento.toISOString(), timeZone);
}

export function eDiOggi(iso, oggiLoc, timeZone) {
  return dataLocale(iso, timeZone) === oggiLoc;
}
