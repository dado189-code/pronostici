// scripts/test.mjs
// Test automatici del motore. Nessuna rete: tutto sintetico e riproducibile,
// cosi' gira anche senza Understat raggiungibile e senza consumare crediti.
// Uso: node scripts/test.mjs — exit code 0 se tutto passa, 1 altrimenti.
//
// Vanno eseguiti PRIMA di ogni cambio al modello che possa spostare le
// probabilita': se un test qui rompe, il cambio non si pubblica.

import { poisson, tau, matrice, mercati, stimaForze, lambde, consenso } from './model.mjs';
import { shrink, pesoDecadimento, aggiornaElo, calcolaEloStorico, npxGDFinestre,
  formaCasaTrasferta, xPointsDelta } from './features.mjs';
import { FUSO_ORARIO } from './config.mjs';

let ok = 0, ko = 0;
const fail = [];

function assertVicino(nome, valore, atteso, tolleranza = 1e-6) {
  const passa = Math.abs(valore - atteso) <= tolleranza;
  if (passa) ok++; else { ko++; fail.push(`${nome}: atteso ${atteso}, trovato ${valore}`); }
}
function assertVero(nome, condizione, dettaglio = '') {
  if (condizione) ok++; else { ko++; fail.push(`${nome}: falso ${dettaglio}`); }
}

// ---------------------------------------------------------------- Poisson e Dixon-Coles

{
  // la somma su tutti i k di poisson(k, lam) deve tendere a 1
  let somma = 0;
  for (let k = 0; k < 40; k++) somma += poisson(k, 2.3);
  assertVicino('Poisson: somma su k=0..39 con lambda=2.3', somma, 1, 1e-6);
}

{
  const lh = 1.6, la = 1.1, rho = -0.08;
  const m = matrice(lh, la, rho);
  let somma = 0;
  for (let i = 0; i < m.length; i++) for (let j = 0; j < m.length; j++) somma += m[i][j];
  assertVicino('Matrice punteggi: somma = 1', somma, 1, 1e-9);

  const mk = mercati(lh, la, rho);
  assertVicino('Mercati: P1+PX+P2 = 1', mk['1'] + mk['X'] + mk['2'], 1, 1e-9);
  assertVicino('Mercati: Over2.5+Under2.5 = 1', mk['Over 2.5'] + mk['Under 2.5'], 1, 1e-9);
  assertVicino('Mercati: Gol+NoGol = 1', mk['Gol'] + mk['NoGol'], 1, 1e-9);
  assertVicino('Mercati: 1X = P1+PX', mk['1X'], mk['1'] + mk['X'], 1e-9);
  assertVicino('Mercati: X2 = PX+P2', mk['X2'], mk['X'] + mk['2'], 1e-9);
  assertVicino('Mercati: 12 = P1+P2', mk['12'], mk['1'] + mk['2'], 1e-9);
  for (const [k, v] of Object.entries(mk)) {
    assertVero(`Mercati: ${k} in [0,1]`, v >= -1e-9 && v <= 1 + 1e-9, `= ${v}`);
  }
}

{
  // tau deve restare positivo per rho piccoli e lambda ragionevoli: se non lo
  // fosse, la matrice avrebbe massa negativa su quei punteggi
  const casiRho = [-0.2, -0.1, -0.05, 0, 0.03];
  for (const rho of casiRho) {
    for (const [i, j] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      assertVero(`tau(${i},${j},rho=${rho}) > 0`, tau(i, j, 1.4, 1.1, rho) > 0);
    }
  }
}

// ---------------------------------------------------------------- time decay

{
  assertVicino('Decadimento: peso a eta=0', pesoDecadimento(0, 180), 1, 1e-9);
  assertVicino('Decadimento: peso a eta=emivita e 0.5', pesoDecadimento(180, 180), 0.5, 1e-9);
  const p1 = pesoDecadimento(30, 180), p2 = pesoDecadimento(300, 180);
  assertVero('Decadimento: partita piu vecchia pesa meno', p2 < p1, `${p2} vs ${p1}`);
}

// ---------------------------------------------------------------- fuso orario

{
  // 30 agosto, ora legale in Italia (UTC+2): le 15:30 UTC sono le 17:30 locali
  const d = new Date('2026-08-30T15:30:00.000Z');
  const locale = d.toLocaleString('it-IT', { timeZone: FUSO_ORARIO, hour: '2-digit', minute: '2-digit', hour12: false });
  assertVero('Fuso orario: 15:30 UTC in agosto = 17:30 Europe/Rome', locale.includes('17:30'), `trovato ${locale}`);

  // 30 dicembre, ora solare (UTC+1): le 15:30 UTC sono le 16:30 locali
  const d2 = new Date('2026-12-30T15:30:00.000Z');
  const locale2 = d2.toLocaleString('it-IT', { timeZone: FUSO_ORARIO, hour: '2-digit', minute: '2-digit', hour12: false });
  assertVero('Fuso orario: 15:30 UTC in dicembre = 16:30 Europe/Rome', locale2.includes('16:30'), `trovato ${locale2}`);
}

// ---------------------------------------------------------------- no-vig e mercato

{
  const bookmakers = [
    { title: 'A', markets: [{ key: 'h2h', outcomes: [{ name: 'Casa', price: 2.0 }, { name: 'X', price: 3.4 }, { name: 'Osp', price: 4.0 }] }] },
    { title: 'B', markets: [{ key: 'h2h', outcomes: [{ name: 'Casa', price: 1.95 }, { name: 'X', price: 3.5 }, { name: 'Osp', price: 4.2 }] }] },
    { title: 'C', markets: [{ key: 'h2h', outcomes: [{ name: 'Casa', price: 2.05 }, { name: 'X', price: 3.3 }, { name: 'Osp', price: 3.9 }] }] }
  ];
  const c = consenso(bookmakers);
  assertVero('Consenso: nessuno con meno di 3 book', c !== null);
  const somma = c['Casa'].prob + c['X'].prob + c['Osp'].prob;
  assertVicino('No-vig: probabilita consenso sommano a 1', somma, 1, 1e-6);
  for (const k of Object.keys(c)) assertVero(`No-vig: prob(${k}) in [0,1]`, c[k].prob > 0 && c[k].prob < 1);

  // fair odds = 1/prob, EV = prob*prezzo-1 — formule dirette, si verifica solo l'aritmetica
  const prob = 0.55, fairOdds = 1 / prob;
  assertVicino('Fair odds: 1/0.55', fairOdds, 1.818181818, 1e-6);
  const ev = prob * 2.0 - 1;
  assertVicino('EV: 0.55 * 2.00 - 1', ev, 0.10, 1e-9);

  // sotto 3 book, il consenso deve rifiutarsi di rispondere
  const soloUno = consenso([bookmakers[0]]);
  assertVero('Consenso: null con meno di 3 book', soloUno === null);
}

// ---------------------------------------------------------------- shrinkage

{
  assertVicino('Shrink: n=0 ritorna il riferimento puro', shrink(5, 2, 0, 8), 2, 1e-9);
  assertVicino('Shrink: n=k e a meta tra i due', shrink(10, 0, 8, 8), 5, 1e-9);
  const conPocoCampione = shrink(10, 1, 1, 8);
  const conTantoCampione = shrink(10, 1, 200, 8);
  assertVero('Shrink: piu campione avvicina all osservato', conTantoCampione > conPocoCampione,
    `${conTantoCampione} vs ${conPocoCampione}`);
}

// ---------------------------------------------------------------- Elo

{
  const r = aggiornaElo(1500, 1500, 2, 0, { partenza: 1500, kFactor: 20, vantaggioCasa: 0, pesoMarginale: false });
  assertVicino('Elo: zero-sum, casa vince', r.eloCasaDopo - 1500, -(r.eloOspiteDopo - 1500), 1e-9);
  assertVero('Elo: chi vince sale', r.eloCasaDopo > 1500);
  assertVero('Elo: chi perde scende', r.eloOspiteDopo < 1500);

  const pareggio = aggiornaElo(1500, 1500, 1, 1, { partenza: 1500, kFactor: 20, vantaggioCasa: 0, pesoMarginale: false });
  assertVicino('Elo: pareggio fra pari non muove nulla', pareggio.eloCasaDopo, 1500, 1e-9);

  // storico sequenziale: la squadra che vince sempre deve salire, mai scendere sotto la partenza
  const partite = [
    { data: new Date('2026-01-01'), casa: 'A', ospite: 'B', golCasa: 2, golOspite: 0 },
    { data: new Date('2026-01-08'), casa: 'B', ospite: 'A', golCasa: 0, golOspite: 3 },
    { data: new Date('2026-01-15'), casa: 'A', ospite: 'B', golCasa: 1, golOspite: 0 }
  ];
  const st = calcolaEloStorico(partite, { partenza: 1500, kFactor: 20, vantaggioCasa: 0, pesoMarginale: true });
  assertVero('Elo storico: A vince sempre, Elo sale sopra la partenza', st.eloAttuale['A'] > 1500);
  assertVero('Elo storico: B perde sempre, Elo scende sotto la partenza', st.eloAttuale['B'] < 1500);
  assertVero('Elo storico: storia ha 3 righe, una per partita', st.storia.length === 3);
  // niente leakage: l'eloCasaPrima della partita 3 deve essere l'eloCasaDopo/eloOspiteDopo della 2, non un valore ricalcolato a posteriori
  assertVicino('Elo storico: nessun leakage, elo prima = elo dopo la partita precedente',
    st.storia[2].eloCasaPrima, st.storia[1].eloOspiteDopo, 1e-9);
}

// ---------------------------------------------------------------- npxGD a finestre e xPoints

{
  const oggi = new Date('2026-09-01');
  const storia = [
    { date: '2026-08-25', npxG: 2.0, npxGA: 0.5, pts: 3, xpts: 2.1 },
    { date: '2026-08-18', npxG: 1.0, npxGA: 1.5, pts: 1, xpts: 1.3 },
    { date: '2026-08-11', npxG: 0.8, npxGA: 2.0, pts: 0, xpts: 0.6 }
  ];
  const f = npxGDFinestre(storia, oggi, [3], 180);
  assertVicino('npxGD: last3 npxG e la media pesata delle 3', f.last3.npxG,
    (2.0 * pesoDecadimento(7, 180) + 1.0 * pesoDecadimento(14, 180) + 0.8 * pesoDecadimento(21, 180))
    / (pesoDecadimento(7, 180) + pesoDecadimento(14, 180) + pesoDecadimento(21, 180)), 1e-6);
  assertVero('npxGD: season copre tutte le partite disponibili', f.season.nDisponibili === 3);

  const xp = xPointsDelta(storia);
  assertVicino('xPoints: punti veri sommati', xp.puntiVeri, 4);
  assertVicino('xPoints: delta = punti veri - punti attesi', xp.delta, +(4 - (2.1 + 1.3 + 0.6)).toFixed(2), 1e-6);
}

{
  // home/away split: con solo partite in casa, il lato trasferta deve ricadere
  // sul complessivo (shrink con n=0)
  const storia = [
    { h_a: 'h', xG: 2.0, xGA: 0.5, npxG: 1.8, npxGA: 0.5, date: '2026-08-25' },
    { h_a: 'h', xG: 1.5, xGA: 0.8, npxG: 1.4, npxGA: 0.8, date: '2026-08-18' }
  ];
  const f = formaCasaTrasferta(storia, new Date('2026-09-01'), 180);
  assertVero('Home/away: 0 partite in trasferta rilevate', f.trasferta.n === 0);
  assertVicino('Home/away: trasferta senza campione ricade sul complessivo',
    f.trasferta.xG, f.complessivo.xG, 1e-9);
  assertVero('Home/away: 2 partite in casa rilevate', f.casa.n === 2);
}

// ---------------------------------------------------------------- retrocompatibilita' stimaForze

{
  // stesse partite, stessa chiamata di sempre (senza campoXG): il risultato
  // non deve cambiare rispetto a prima dell'introduzione del parametro.
  const partite = [
    { data: new Date('2026-01-01'), casa: 'A', ospite: 'B', xgCasa: 1.8, xgOspite: 0.6, golCasa: 2, golOspite: 0 },
    { data: new Date('2026-01-08'), casa: 'B', ospite: 'A', xgCasa: 0.9, xgOspite: 1.4, golCasa: 1, golOspite: 1 },
    { data: new Date('2026-01-15'), casa: 'A', ospite: 'B', xgCasa: 2.1, xgOspite: 0.4, golCasa: 3, golOspite: 0 }
  ];
  const oggi = new Date('2026-01-20');
  const f1 = stimaForze(partite, { emivita: 180, iterazioni: 50, oggi });
  const f2 = stimaForze(partite, { emivita: 180, iterazioni: 50, oggi, campoXG: 'xg' });
  assertVicino('stimaForze: campoXG=xg esplicito da lo stesso risultato del default',
    f1.att['A'], f2.att['A'], 1e-12);

  // con npxg ma nessuna partita che porta npxgCasa/npxgOspite, deve ricadere su xg
  // (fallback), quindi il risultato deve restare identico
  const f3 = stimaForze(partite, { emivita: 180, iterazioni: 50, oggi, campoXG: 'npxg' });
  assertVicino('stimaForze: campoXG=npxg senza dati npxG ricade su xg (nessuna differenza)',
    f1.att['A'], f3.att['A'], 1e-12);

  // con npxg e un RAPPORTO npxG/xG diverso da una partita all'altra (non un
  // fattore di scala uniforme, che la normalizzazione a media 1 annullerebbe),
  // il rating relativo deve cambiare: qui il 3-0 di A e' quasi tutto rigori,
  // quindi il suo attacco "vero" (non rigoristico) risulta piu' basso.
  const partiteConNpxg = partite.map((p, i) => ({ ...p,
    npxgCasa: i === 2 ? p.xgCasa * 0.3 : p.xgCasa,
    npxgOspite: p.xgOspite }));
  const f4 = stimaForze(partiteConNpxg, { emivita: 180, iterazioni: 50, oggi, campoXG: 'npxg' });
  assertVero('stimaForze: campoXG=npxg con rapporto npxG/xG non uniforme produce un rating diverso',
    Math.abs(f4.att['A'] - f1.att['A']) > 1e-6, `${f4.att['A']} vs ${f1.att['A']}`);

  // opponent adjustment: A batte sempre B nettamente, quindi il rating di
  // attacco di A deve risultare sopra la media (1.0) e quello di B sotto
  assertVero('Opponent adjustment: A (che segna piu della media contro B) ha attacco > 1', f1.att['A'] > 1);
  assertVero('Opponent adjustment: B (che subisce piu della media da A) ha difesa < 1', f1.dif['B'] < 1);

  // lambde deve restituire 0 per una squadra sconosciuta, non NaN o un valore a caso
  const l = lambde(f1, 'A', 'Squadra Mai Vista');
  assertVicino('lambde: squadra sconosciuta -> lh=0', l.lh, 0);
}

// ---------------------------------------------------------------- riepilogo

console.log(`\n${ok} test superati, ${ko} falliti.`);
if (fail.length) {
  console.log('\nFalliti:');
  fail.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
