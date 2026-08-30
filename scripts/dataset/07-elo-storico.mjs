// scripts/dataset/07-elo-storico.mjs
// Correzione 3: Elo sequenziale, multi-stagione, persistente su file. Gira
// UNA VOLTA sull'intero dataset (tutte le leghe insieme, ordinate per data
// assolute: e' cosi' che un Elo reale funziona, non lega per lega isolata,
// anche se qui le leghe non si incontrano mai fra loro quindi l'unica cosa
// che cambia rispetto a farlo per lega e' l'ordine di elaborazione, non i
// numeri). Il risultato si scrive su data/elo/elo-storico.json: quello e' il
// file persistente, non una variabile che sparisce a fine esecuzione.
//
// NON e' collegato a build.mjs: come richiesto, l'Elo resta un dato
// calcolato e salvato per il backtest, non una feature che cambia le
// probabilita' in produzione finche' non e' stato misurato.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { calcolaEloStorico } from '../features.mjs';
import { ELO } from '../config.mjs';
import { LEGHE } from './00-config.mjs';

mkdirSync('data/elo', { recursive: true });

const dataset = JSON.parse(readFileSync('data/normalized/dataset-matched.json', 'utf8')).partite;

// Una passata PER LEGA, non su tutto il dataset insieme: la "media di lega"
// verso cui regredire a fine stagione e il prior delle neopromosse hanno
// senso solo dentro lo stesso campionato. Milan e Manchester United non
// condividono un pool di riferimento solo perche' hanno giocato nella stessa
// settimana di calendario. Le squadre di leghe diverse non si incontrano mai,
// quindi processarle separatamente non perde nessuna informazione reale.
const perLega = {};
let storiaCompleta = [];

for (const lega of LEGHE) {
  const partite = dataset.filter(r => r.league === lega.nome)
    .map(r => ({ data: new Date(r.date), stagione: r.season, lega: r.league,
      casa: r.home_team, ospite: r.away_team, golCasa: r.goals_home, golOspite: r.goals_away }))
    .sort((a, b) => a.data - b.data);

  const risultato = calcolaEloStorico(partite, ELO);
  perLega[lega.nome] = { eloFinale: risultato.eloAttuale, trend: risultato.trend, confidenzaBassa: risultato.confidenzaBassa };
  storiaCompleta = storiaCompleta.concat(risultato.storia);
}

writeFileSync('data/elo/elo-storico.json', JSON.stringify({
  generato_il: new Date().toISOString(),
  config: ELO,
  nota: 'Sequenziale PER LEGA (le squadre di leghe diverse non si incontrano mai, quindi non '
    + 'condividono un pool Elo): elo_before di ogni partita dipende solo da partite precedenti nella '
    + 'stessa lega. Regressione stagionale e prior neopromosse applicati al cambio di stagione. '
    + 'NON usato da build.mjs: e un artefatto del backtest, non una feature produttiva.',
  nPartite: storiaCompleta.length,
  perLega,
  storia: storiaCompleta.sort((a, b) => new Date(a.data) - new Date(b.data))
}, null, 1));

console.log(`Elo storico: ${storiaCompleta.length} partite processate su ${LEGHE.length} leghe.`);
for (const [lega, dati] of Object.entries(perLega)) {
  const top3 = Object.entries(dati.eloFinale).sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`  ${lega}: ${top3.map(([s, e]) => `${s} ${e.toFixed(0)}`).join(', ')}`);
}
