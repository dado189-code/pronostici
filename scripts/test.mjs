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
import { isotonicFit, isotonicPredict, applicaDrawCal, costruisciCalibratore } from './drawcal.mjs';
import { fairOdds, ev, edge, agreement, dataQuality, confidence, classificaValore,
  marketGapInfo, classificaRischioQuota, idoneoBestPick, opportunityScore, evCappatoPerRanking } from './valore.mjs';
import { costruisciCassaforte, costruisciQuota2, costruisciSorpresa } from './selezioni.mjs';
import { dataLocale, oggiLocale, eDiOggi } from './tempo.mjs';

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

// ---------------------------------------------------------------- Elo: transizione di stagione e neopromosse

{
  const cfg = { partenza: 1500, kFactor: 20, vantaggioCasa: 0, pesoMarginale: false,
    regressioneStagionale: 0.5, handicapNeopromossa: 100 };

  // A domina la stagione 1: il suo Elo finisce ben sopra 1500
  const stagione1 = [
    { data: new Date('2023-01-01'), stagione: '2223', casa: 'A', ospite: 'B', golCasa: 3, golOspite: 0 },
    { data: new Date('2023-02-01'), stagione: '2223', casa: 'B', ospite: 'A', golCasa: 0, golOspite: 3 },
    { data: new Date('2023-03-01'), stagione: '2223', casa: 'A', ospite: 'B', golCasa: 2, golOspite: 0 }
  ];
  const st1 = calcolaEloStorico(stagione1, cfg);
  const eloAFineStagione1 = st1.eloAttuale['A'];
  assertVero('Elo stagionale: A domina, finisce sopra 1500', eloAFineStagione1 > 1500);

  // stessa serie + una partita neutra a inizio stagione 2 (2324): la
  // regressione stagionale deve aver mosso A verso la media lega, quindi il
  // suo eloCasaPrima nella prima partita della stagione 2 deve essere PIU'
  // VICINO alla media lega di quanto non fosse l'ultimo Elo della stagione 1
  const stagione2 = [...stagione1,
    { data: new Date('2023-08-01'), stagione: '2324', casa: 'A', ospite: 'B', golCasa: 1, golOspite: 1 }];
  const st2 = calcolaEloStorico(stagione2, cfg);
  const primaPartitaStagione2 = st2.storia.find(h => h.stagione === '2324');
  const mediaLegaFineStagione1 = (st1.eloAttuale['A'] + st1.eloAttuale['B']) / 2;
  const distanzaPrima = Math.abs(eloAFineStagione1 - mediaLegaFineStagione1);
  const distanzaDopo = Math.abs(primaPartitaStagione2.eloCasaPrima - mediaLegaFineStagione1);
  assertVero('Elo stagionale: la regressione avvicina A alla media di lega al cambio stagione',
    distanzaDopo < distanzaPrima, `prima ${distanzaPrima.toFixed(1)}, dopo ${distanzaDopo.toFixed(1)}`);

  // neopromossa C entra in stagione 2 con un prior sotto la media lega, non a 1500 secco
  const conNeopromossa = [...stagione2,
    { data: new Date('2023-08-08'), stagione: '2324', casa: 'C', ospite: 'A', golCasa: 0, golOspite: 0 }];
  const st3 = calcolaEloStorico(conNeopromossa, cfg);
  const primaDiC = st3.storia.find(h => h.casa === 'C');
  const mediaLegaAlMomento = (st2.storia.at(-1).eloCasaDopo + st2.storia.at(-1).eloOspiteDopo) / 2;
  assertVero('Elo neopromossa: prior sotto la media di lega, non a 1500 secco',
    primaDiC.eloCasaPrima < mediaLegaAlMomento, `prior ${primaDiC.eloCasaPrima} vs media ${mediaLegaAlMomento.toFixed(1)}`);
  assertVicino('Elo neopromossa: prior = media lega - handicap configurato',
    primaDiC.eloCasaPrima, mediaLegaAlMomento - cfg.handicapNeopromossa, 0.5);

  // nessun leakage attraverso il cambio di stagione: l'elo "prima" della prima
  // partita di stagione 2 deve dipendere solo da cio' che e' successo in
  // stagione 1, mai dal risultato della partita stessa o di partite future
  assertVero('Elo: nessun leakage al cambio stagione', primaPartitaStagione2.eloCasaPrima !== eloAFineStagione1
    || cfg.regressioneStagionale === 0, 'la regressione deve aver mosso il valore, non lasciarlo intatto per caso');
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

// ---------------------------------------------------------------- DC-DRAW-CAL (modalita' avanzata)

{
  // isotonic fit su un caso sintetico monotono: P_DRAW piu' alto -> frequenza
  // osservata di pareggio piu' alta. Il calibratore deve restare monotono e
  // restituire una funzione a gradini (mai fuori [0,1]).
  const punti = [];
  for (let i = 0; i < 200; i++) {
    const x = i / 200;
    const y = Math.random() < x ? 1 : 0;
    punti.push({ x, y });
  }
  const blocchi = isotonicFit(punti);
  let monotono = true;
  for (let i = 1; i < blocchi.length; i++) if (blocchi[i].y < blocchi[i - 1].y - 1e-9) monotono = false;
  assertVero('isotonicFit: la funzione risultante e monotona non decrescente', monotono);
  const pred = isotonicPredict(blocchi, 0.5);
  assertVero('isotonicPredict: valore in [0,1]', pred >= 0 && pred <= 1, String(pred));
}

{
  // applicaDrawCal con calibratore non attivo: fallback ESATTO alla tripla originale
  const r = applicaDrawCal(0.45, 0.28, 0.27, { attivo: false, motivo: 'test' });
  assertVicino('applicaDrawCal: fallback P1 invariato', r.P1, 0.45);
  assertVicino('applicaDrawCal: fallback PX invariato', r.PX, 0.28);
  assertVicino('applicaDrawCal: fallback P2 invariato', r.P2, 0.27);
  assertVero('applicaDrawCal: fallback segnalato con attivo=false', r.attivo === false);
}

{
  // calibratore attivo: la somma delle tre probabilita' deve restare 1 e
  // nessuna deve uscire da [0,1] o diventare NaN
  const blocchi = isotonicFit([{ x: 0.1, y: 0 }, { x: 0.2, y: 0 }, { x: 0.3, y: 1 }, { x: 0.4, y: 1 }]);
  const cal = { attivo: true, blocchi };
  const r = applicaDrawCal(0.5, 0.25, 0.25, cal);
  assertVicino('applicaDrawCal attivo: somma probabilita = 1', r.P1 + r.PX + r.P2, 1, 1e-9);
  assertVero('applicaDrawCal attivo: nessun NaN', [r.P1, r.PX, r.P2].every(Number.isFinite));
  assertVero('applicaDrawCal attivo: nessuna probabilita negativa', [r.P1, r.PX, r.P2].every(v => v >= 0));
}

{
  // il calibratore di produzione (letto dal dataset storico reale) deve
  // esistere in questo repository e superare la soglia minima di Fase 8,
  // altrimenti build.mjs deve fare fallback: qui verifichiamo solo che la
  // funzione non lanci e risponda con un oggetto coerente in ogni caso.
  const cal = costruisciCalibratore('data/dataset/previsioni-walkforward.json');
  assertVero('costruisciCalibratore: risposta ha il campo attivo booleano', typeof cal.attivo === 'boolean');
  if (!cal.attivo) assertVero('costruisciCalibratore: motivo dichiarato quando non attivo', typeof cal.motivo === 'string' && cal.motivo.length > 0);
  const calAssente = costruisciCalibratore('data/percorso/che/non/esiste.json');
  assertVero('costruisciCalibratore: file assente -> fallback dichiarato, non un\'eccezione', calAssente.attivo === false && typeof calAssente.motivo === 'string');
}

// ---------------------------------------------------------------- market layer / value / confidence

{
  assertVicino('fairOdds: 1/P', fairOdds(0.4), 2.5);
  assertVero('fairOdds: probabilita 0 -> null, mai Infinity o NaN', fairOdds(0) === null);
  assertVicino('ev: P*quota-1', ev(0.5, 2.2), 0.1, 1e-9);
  assertVicino('edge: P_model - P_mercato', edge(0.55, 0.5), 0.05, 1e-9);
  assertVero('edge: P_mercato non disponibile -> null', edge(0.5, undefined) === null);
}

{
  const alto = agreement([0.57, 0.56, 0.55]);
  assertVero('agreement: scarto piccolo -> HIGH', alto.livello === 'HIGH', alto.livello);
  const basso = agreement([0.58, 0.55, 0.44]);
  assertVero('agreement: scarto grande -> LOW', basso.livello === 'LOW', basso.livello);
  const nd = agreement([0.5]);
  assertVero('agreement: un solo valore -> N/D, non un falso HIGH', nd.livello === 'N/D');
}

{
  const dq = dataQuality({ nStorico: 300, currentSeasonMatches: 10, contestoDisponibile: false });
  assertVero('dataQuality: in [0,100]', dq >= 0 && dq <= 100, String(dq));
  const dqConContesto = dataQuality({ nStorico: 300, currentSeasonMatches: 10, contestoDisponibile: true });
  assertVero('dataQuality: contesto disponibile alza il punteggio rispetto a non disponibile', dqConContesto > dq);

  const conf = confidence({ agreementLivello: 'HIGH', nStorico: 300, currentSeasonMatches: 10, freschezzaOre: 0, contestoDisponibile: false, scartoDalMercato: 0 });
  assertVero('confidence: in [0,100]', conf >= 0 && conf <= 100, String(conf));
  const confLow = confidence({ agreementLivello: 'LOW', nStorico: 10, currentSeasonMatches: 0, freschezzaOre: 47, contestoDisponibile: false, scartoDalMercato: 0.2 });
  assertVero('confidence: scenario debole produce un punteggio piu basso di uno forte', confLow < conf, `${confLow} vs ${conf}`);
}

{
  // mai VALUE/STRONG_VALUE con EV negativo, qualunque siano gli altri fattori
  const c1 = classificaValore({ evValue: -0.02, edgeValue: 0.05, confidenceScore: 90, dataQualityScore: 90, agreementLivello: 'HIGH' });
  assertVero('classificaValore: EV negativo -> mai VALUE/STRONG_VALUE', c1 === 'NO_BET', c1);

  // EV positivo ma qualita' bassa -> WATCH, non VALUE
  const c2 = classificaValore({ evValue: 0.15, edgeValue: 0.1, confidenceScore: 20, dataQualityScore: 20, agreementLivello: 'HIGH' });
  assertVero('classificaValore: EV positivo ma qualita bassa -> WATCH', c2 === 'WATCH', c2);

  // EV/edge/confidence/dataQuality tutti alti e agreement alto -> STRONG_VALUE
  const c3 = classificaValore({ evValue: 0.15, edgeValue: 0.1, confidenceScore: 80, dataQualityScore: 80, agreementLivello: 'HIGH' });
  assertVero('classificaValore: tutto alto -> STRONG_VALUE', c3 === 'STRONG_VALUE', c3);

  // nessuna etichetta deve mai essere una delle parole vietate
  const vietate = ['SICURA', 'CERTA', 'GARANTITA'];
  assertVero('classificaValore: nessuna etichetta e una parola vietata',
    ![c1, c2, c3].some(v => vietate.includes(v)));
}

// ---------------------------------------------------------------- value engine v2: market gap, quota, best picks (richiesta di irrobustimento)

{
  // punto 1: soglie del market gap
  assertVero('marketGapInfo: gap 2pp -> NONE, nessuna penalita', marketGapInfo(0.02).livello === 'NONE' && marketGapInfo(0.02).penalitaConfidence === 0);
  assertVero('marketGapInfo: gap 4pp -> LIEVE', marketGapInfo(0.04).livello === 'LIEVE');
  assertVero('marketGapInfo: gap 7pp -> SIGNIFICATIVA', marketGapInfo(0.07).livello === 'SIGNIFICATIVA');
  const estremo = marketGapInfo(0.15);
  assertVero('marketGapInfo: gap 15pp -> ESTREMA e bloccaValueClass', estremo.livello === 'ESTREMA' && estremo.bloccaValueClass === true);
  assertVero('marketGapInfo: etichetta HIGH MODEL/MARKET DISAGREEMENT su gap estremo', estremo.etichetta === 'HIGH MODEL/MARKET DISAGREEMENT');

  // caso reale segnalato: gap estremo con EV altissimo NON deve mai dare VALUE/STRONG_VALUE
  const cEstremo = classificaValore({ evValue: 1.09, edgeValue: 0.15, confidenceScore: 90, dataQualityScore: 90, agreementLivello: 'MEDIUM', marketGapLivello: 'ESTREMA' });
  assertVero('classificaValore: gap estremo -> mai VALUE/STRONG_VALUE anche con EV/confidence/dataQuality altissimi', cEstremo === 'WATCH', cEstremo);
}

{
  // punto 2: soglie di rischio sulla quota
  assertVero('classificaRischioQuota: 3.5 -> NORMALE', classificaRischioQuota(3.5) === 'NORMALE');
  assertVero('classificaRischioQuota: 6 -> CAUTION', classificaRischioQuota(6) === 'CAUTION');
  assertVero('classificaRischioQuota: 10 -> HIGH_VARIANCE', classificaRischioQuota(10) === 'HIGH_VARIANCE');
  assertVero('classificaRischioQuota: 22 -> ESCLUSA', classificaRischioQuota(22) === 'ESCLUSA');
}

{
  // punto 3: EV cap per il ranking, mai per l'EV mostrato
  assertVicino('evCappatoPerRanking: EV sotto soglia passa invariato', evCappatoPerRanking(0.08), 0.08, 1e-9);
  assertVicino('evCappatoPerRanking: EV 1.09 saturato a evCapRanking (0.25)', evCappatoPerRanking(1.09), 0.25, 1e-9);
}

{
  // punto 4: idoneoBestPick richiede TUTTE le condizioni insieme
  const buono = idoneoBestPick({ confidenceScore: 70, dataQualityScore: 60, agreementLivello: 'HIGH', marketGap: 0.02, quota: 2.1, evValue: 0.05 });
  assertVero('idoneoBestPick: scenario solido -> idoneo, nessun motivo di esclusione', buono.idoneo === true && buono.motiviEsclusione.length === 0);

  // caso reale segnalato 1: Barcelona-Rayo 2 @22, EV altissimo ma quota estrema e gap enorme
  const barcaRayo = idoneoBestPick({ confidenceScore: 68, dataQualityScore: 60, agreementLivello: 'MEDIUM', marketGap: 0.038, quota: 22, evValue: 1.09 });
  assertVero('idoneoBestPick: Barcelona-Rayo 2 @22 NON idoneo (quota estrema)', barcaRayo.idoneo === false);
  assertVero('idoneoBestPick: motivo include la quota', barcaRayo.motiviEsclusione.some(m => m.includes('quota')));

  // caso reale segnalato 2: Real Madrid-Malaga X @14, EV alto ma quota sopra soglia Best Picks
  const madridMalaga = idoneoBestPick({ confidenceScore: 67, dataQualityScore: 60, agreementLivello: 'MEDIUM', marketGap: 0.051, quota: 14, evValue: 0.89 });
  assertVero('idoneoBestPick: Real Madrid-Malaga X @14 NON idoneo (quota + gap sopra soglia)', madridMalaga.idoneo === false);

  // qualita bassa da sola basta a escludere, anche con EV/quota/gap perfetti
  const qualitaBassa = idoneoBestPick({ confidenceScore: 20, dataQualityScore: 20, agreementLivello: 'HIGH', marketGap: 0.01, quota: 1.8, evValue: 0.1 });
  assertVero('idoneoBestPick: qualita bassa da sola esclude', qualitaBassa.idoneo === false);
}

{
  // punto 7: OpportunityScore NON e' una funzione crescente dell'EV oltre il cap:
  // due EV molto diversi ma entrambi oltre la soglia (evCapRanking=0.25) devono
  // produrre lo STESSO contributo di EV al punteggio, quindi lo stesso punteggio
  // a parita' di confidence/dataQuality/agreement — un 109% teorico non deve
  // "battere" un 30% credibile solo perche' e' piu' alto.
  const ev30 = opportunityScore({ confidenceScore: 70, dataQualityScore: 60, evValue: 0.30, agreementLivello: 'HIGH' });
  const ev109 = opportunityScore({ confidenceScore: 70, dataQualityScore: 60, evValue: 1.09, agreementLivello: 'HIGH' });
  assertVicino('opportunityScore: EV oltre il cap non aumenta ulteriormente il punteggio', ev30, ev109, 1e-9);

  // fra due casi ENTRAMBI con EV oltre il cap (quindi stesso contributo EV),
  // deve vincere quello con confidence/dataQuality/agreement migliori: e'
  // esattamente il caso Barcelona-Rayo (EV 109%, qualita media) confrontato
  // con un ipotetico pick altrettanto sopra soglia ma piu solido.
  const capSaturatoQualitaAlta = opportunityScore({ confidenceScore: 80, dataQualityScore: 75, evValue: 1.09, agreementLivello: 'HIGH' });
  const capSaturatoQualitaBassa = opportunityScore({ confidenceScore: 68, dataQualityScore: 60, evValue: 1.09, agreementLivello: 'MEDIUM' });
  assertVero('opportunityScore: a parita di EV (sopra cap), la qualita migliore vince, non l\'EV',
    capSaturatoQualitaAlta > capSaturatoQualitaBassa, `${capSaturatoQualitaAlta} vs ${capSaturatoQualitaBassa}`);
}

// ---------------------------------------------------------------- invarianza baseline (punto 14)

{
  // Stesso identico input, stessa identica chiamata di model.mjs usata da
  // build.mjs per il Pure Model: deve restituire ESATTAMENTE la stessa tripla
  // prima e dopo l'introduzione del layer sperimentale. Non e' un test sulla
  // formula (invariata per costruzione, model.mjs non e' stato toccato): e'
  // una guardia contro un futuro cambiamento accidentale.
  const oggi = new Date('2026-01-01');
  const partite = [
    { data: new Date('2025-09-01'), casa: 'A', ospite: 'B', xgCasa: 1.8, xgOspite: 0.9 },
    { data: new Date('2025-09-15'), casa: 'B', ospite: 'A', xgCasa: 0.7, xgOspite: 2.1 },
    { data: new Date('2025-10-01'), casa: 'A', ospite: 'B', xgCasa: 2.0, xgOspite: 1.0 }
  ];
  const f = stimaForze(partite, { emivita: 180, oggi });
  const rhoBase = -0.05;
  const { lh, la } = lambde(f, 'A', 'B');
  const mkBase = mercati(lh, la, rhoBase);
  const somma = mkBase['1'] + mkBase['X'] + mkBase['2'];
  assertVicino('Baseline invariata: somma 1X2 = 1', somma, 1, 1e-9);
  assertVero('Baseline invariata: nessun NaN nelle probabilita 1X2', [mkBase['1'], mkBase['X'], mkBase['2']].every(Number.isFinite));
  assertVero('Baseline invariata: nessuna probabilita negativa', [mkBase['1'], mkBase['X'], mkBase['2']].every(v => v >= 0));
  // il layer sperimentale non deve alterare mkBase: applicaDrawCal prende in
  // input i valori e ne restituisce di nuovi, non muta l'oggetto originale
  const calibrato = applicaDrawCal(mkBase['1'], mkBase['X'], mkBase['2'], { attivo: false, motivo: 'x' });
  assertVicino('Baseline invariata: mkBase[1] non mutato dopo applicaDrawCal', mkBase['1'], mkBase['1']);
  assertVicino('Baseline invariata: fallback drawcal riproduce esattamente P1 baseline', calibrato.P1, mkBase['1'], 1e-12);
  assertVicino('Baseline invariata: fallback drawcal riproduce esattamente PX baseline', calibrato.PX, mkBase['X'], 1e-12);
  assertVicino('Baseline invariata: fallback drawcal riproduce esattamente P2 baseline', calibrato.P2, mkBase['2'], 1e-12);
}

// ---------------------------------------------------------------- Cassaforte / Quota 2 / Sorpresa

{
  const finta = ({ confidence = 70, dataQuality = 60, agreement = 'HIGH', gap = 'NONE', rischio = 'NORMALE',
    ev = 0.05, bookmakerOdds = null, noVig = null, esitoRif = '1' } = {}) => ({
    quality: { confidence, data_quality: dataQuality, agreement },
    market_gap: { valore: 0.01, livello: gap },
    rischio_quota: rischio,
    value: { ev, edge: ev != null ? ev - 0.02 : null, fair_odds: null },
    market: { esito_riferimento: esitoRif, bookmaker_odds: bookmakerOdds, no_vig_probability: noVig },
    calibrated: { attivo: false },
    pure_model: { P1: 0.5, PX: 0.28, P2: 0.22 },
    why: 'motivazione di test'
  });
  const candidato = (over) => ({ match: 'm', evento: 'Ev', comp: 'Serie A', quando: 'oggi', mercato: '1', prob: 0.6, quota_fair: +(1 / 0.6).toFixed(3), analisi: finta(), ...over });

  // CASSAFORTE: sceglie dentro la banda, scarta High Risk e qualita bassa
  {
    const pool = [
      candidato({ match: 'a', prob: 0.588, quota_fair: 1.70, analisi: finta({ confidence: 70 }) }),      // in banda, buona qualita
      candidato({ match: 'b', prob: 0.9, quota_fair: 1.11, analisi: finta({ confidence: 90 }) }),          // fuori banda (troppo bassa)
      candidato({ match: 'c', prob: 0.5, quota_fair: 2.00, analisi: finta({ confidence: 90 }) }),          // fuori banda (troppo alta)
      candidato({ match: 'd', prob: 0.6, quota_fair: 1.67, analisi: finta({ rischio: 'ESCLUSA' }) }),      // in banda ma High Risk -> scartato
      candidato({ match: 'e', prob: 0.6, quota_fair: 1.68, analisi: finta({ agreement: 'LOW' }) })         // in banda ma agreement non accettato -> scartato
    ];
    const r = costruisciCassaforte(pool);
    assertVero('costruisciCassaforte: sceglie il candidato in banda con qualita buona', r.selezione && r.selezione.match === 'a', JSON.stringify(r));
    assertVero('costruisciCassaforte: mai un candidato High Risk', r.selezione.match !== 'd');
    assertVero('costruisciCassaforte: mai un candidato con agreement LOW', r.selezione.match !== 'e');
  }
  // CASSAFORTE: nessun candidato -> null con motivo esplicito, mai forzata
  {
    const r = costruisciCassaforte([candidato({ match: 'x', prob: 0.9, quota_fair: 1.11 })]); // fuori banda
    assertVero('costruisciCassaforte: nessun candidato idoneo -> selezione null', r.selezione === null);
    assertVero('costruisciCassaforte: motivo dichiarato quando null', typeof r.motivo === 'string' && r.motivo.length > 0);
  }

  // QUOTA 2: trova una coppia in banda 1.85-2.20 su partite DIVERSE
  {
    const pool = [
      candidato({ match: 'a', prob: 0.68, quota_fair: 1.47 }),
      candidato({ match: 'b', prob: 0.68, quota_fair: 1.47 }),
      candidato({ match: 'a', mercato: 'X', prob: 0.05, quota_fair: 20 }) // stessa partita di 'a': mai scelta insieme ad 'a'
    ];
    const r = costruisciQuota2(pool);
    assertVero('costruisciQuota2: trova una combinazione in banda 1.85-2.20', r.selezioni && r.quotaTotale >= 1.85 && r.quotaTotale <= 2.20, JSON.stringify(r));
    assertVero('costruisciQuota2: le selezioni sono su partite diverse', new Set(r.selezioni.map(s => s.match)).size === r.selezioni.length);
    assertVero('costruisciQuota2: probabilita congiunta = prodotto delle probabilita', Math.abs(r.probCongiunta - r.selezioni.reduce((p, s) => p * s.prob, 1)) < 1e-9);
  }
  // QUOTA 2: nessuna combinazione valida -> null con motivo
  {
    const r = costruisciQuota2([candidato({ match: 'a', prob: 0.95, quota_fair: 1.05 }), candidato({ match: 'b', prob: 0.95, quota_fair: 1.05 })]);
    assertVero('costruisciQuota2: nessuna combinazione in banda -> selezioni null', r.selezioni === null);
    assertVero('costruisciQuota2: motivo dichiarato quando null', typeof r.motivo === 'string' && r.motivo.length > 0);
  }

  // SORPRESA: solo segni 1X2 con quota bookmaker reale, EV positivo, gap non estremo
  {
    const partite = [
      { match: 'a', evento: 'A - B', comp: 'Serie A', quando: 'oggi', analisi: finta({ bookmakerOdds: 3.5, noVig: 0.32, ev: 0.1, agreement: 'MEDIUM' }) },
      { match: 'b', evento: 'C - D', comp: 'Serie A', quando: 'oggi', analisi: finta({ bookmakerOdds: 12, noVig: 0.1, ev: 1.5, gap: 'ESTREMA' }) }, // quota fuori banda E gap estremo
      { match: 'c', evento: 'E - F', comp: 'Serie A', quando: 'oggi', analisi: finta({ bookmakerOdds: 3.2, noVig: 0.35, ev: -0.05 }) } // EV negativo
    ];
    const r = costruisciSorpresa(partite);
    assertVero('costruisciSorpresa: sceglie il candidato in banda 2.5-5 con EV positivo', r.selezione && r.selezione.match === 'a', JSON.stringify(r));
    assertVero('costruisciSorpresa: mai una quota fuori banda o gap estremo', r.selezione.match !== 'b');
    assertVero('costruisciSorpresa: mai EV negativo', r.selezione.match !== 'c');
  }
  // SORPRESA: nessun candidato -> null con motivo
  {
    const r = costruisciSorpresa([{ match: 'a', analisi: finta({ bookmakerOdds: 1.5, ev: 0.1 }) }]); // quota troppo bassa per essere sorpresa
    assertVero('costruisciSorpresa: nessun candidato in banda -> selezione null', r.selezione === null);
    assertVero('costruisciSorpresa: motivo dichiarato quando null', typeof r.motivo === 'string' && r.motivo.length > 0);
  }

  // ---------------- FILTRO "SOLO OGGI" (Europe/Rome) ----------------------
  // Replica esattamente il pattern usato in build.mjs: filtrare PRIMA con
  // eDiOggi/dataLocale, poi passare alle funzioni di selezione. Verifica che
  // nessun evento futuro possa mai comparire nel risultato, qualunque sia il
  // suo punteggio.
  const TZ = 'Europe/Rome';
  const OGGI = oggiLocale(TZ, new Date('2026-08-30T10:00:00Z')); // finge che "adesso" sia il 30/08 mattina UTC
  assertVero('oggiLocale: coerente con la data di riferimento passata', OGGI === '2026-08-30', OGGI);

  const isoOggiPomeriggio = '2026-08-30T18:00:00Z';       // 20:00 locale, 30/08
  const isoOggiSeraTardi = '2026-08-30T22:30:00Z';        // 00:30 locale del 31/08 (CEST, UTC+2): NON e' oggi
  const isoDomani = '2026-08-31T14:00:00Z';               // chiaramente domani
  const isoSettimanaProssima = '2026-09-06T14:00:00Z';    // chiaramente futuro

  assertVero('eDiOggi: partita pomeridiana di oggi -> true', eDiOggi(isoOggiPomeriggio, OGGI, TZ) === true);
  assertVero('eDiOggi: kickoff 22:30 UTC = 00:30 locale (CEST) -> gia domani, false',
    eDiOggi(isoOggiSeraTardi, OGGI, TZ) === false, dataLocale(isoOggiSeraTardi, TZ));
  assertVero('eDiOggi: partita di domani -> false', eDiOggi(isoDomani, OGGI, TZ) === false);
  assertVero('eDiOggi: partita della settimana prossima -> false', eDiOggi(isoSettimanaProssima, OGGI, TZ) === false);

  // candidato con inizio, per il pool di Cassaforte/Quota2/Sorpresa
  const candidatoConData = (match, inizio, over) => ({ match, evento: `Ev ${match}`, comp: 'Serie A', quando: 'x', inizio,
    mercato: '1', prob: 0.65, quota_fair: +(1 / 0.65).toFixed(3), analisi: finta({ confidence: 80, dataQuality: 70 }), ...over });

  {
    // CASSAFORTE: il candidato futuro ha probabilita/qualita MIGLIORI, ma va escluso a monte
    const poolGrezzo = [
      candidatoConData('oggi1', isoOggiPomeriggio, { prob: 0.6, quota_fair: 1.67 }),
      candidatoConData('domani1', isoDomani, { prob: 0.9, quota_fair: 1.67, analisi: finta({ confidence: 99, dataQuality: 99 }) })
    ];
    const poolOggi = poolGrezzo.filter(c => eDiOggi(c.inizio, OGGI, TZ));
    const r = costruisciCassaforte(poolOggi);
    assertVero('costruisciCassaforte: nessun evento futuro in Cassaforte anche se migliore', r.selezione && r.selezione.match === 'oggi1', JSON.stringify(r));
  }
  {
    // QUOTA 2: una delle due gambe migliori e' di domani -> va scartata dal pool, mai usata
    const poolGrezzo = [
      candidatoConData('oggiA', isoOggiPomeriggio, { prob: 0.68, quota_fair: 1.47 }),
      candidatoConData('oggiB', isoOggiPomeriggio, { prob: 0.68, quota_fair: 1.47 }),
      candidatoConData('domaniA', isoDomani, { prob: 0.99, quota_fair: 1.47, analisi: finta({ confidence: 99, dataQuality: 99 }) })
    ];
    const poolOggi = poolGrezzo.filter(c => eDiOggi(c.inizio, OGGI, TZ));
    const r = costruisciQuota2(poolOggi);
    assertVero('costruisciQuota2: nessuna gamba futura nella combinazione', r.selezioni && r.selezioni.every(s => s.match !== 'domaniA'), JSON.stringify(r));
    assertVero('costruisciQuota2: usa solo le due di oggi', r.selezioni && r.selezioni.length === 2 && r.selezioni.every(s => s.match.startsWith('oggi')));
  }
  {
    // SORPRESA: il candidato futuro ha EV molto piu alto, ma va escluso a monte
    const partiteGrezze = [
      { match: 'oggiX', evento: 'Oggi X', comp: 'Serie A', quando: 'x', inizio: isoOggiPomeriggio, analisi: finta({ bookmakerOdds: 3.5, noVig: 0.3, ev: 0.1, agreement: 'MEDIUM' }) },
      { match: 'domaniY', evento: 'Domani Y', comp: 'Serie A', quando: 'x', inizio: isoDomani, analisi: finta({ bookmakerOdds: 3.8, noVig: 0.2, ev: 2.0, agreement: 'HIGH' }) }
    ];
    const partiteOggiTest = partiteGrezze.filter(p => eDiOggi(p.inizio, OGGI, TZ));
    const r = costruisciSorpresa(partiteOggiTest);
    assertVero('costruisciSorpresa: mai un evento futuro anche con EV molto piu alto', r.selezione && r.selezione.match === 'oggiX', JSON.stringify(r));
  }
  {
    // BEST PICKS / HIGH RISK: stesso pattern, replicato sulla lista "tutteConAnalisi"
    const partiteGrezze = [
      { match: 'oggiZ', evento: 'Oggi Z', comp: 'Serie A', quando: 'x', inizio: isoOggiPomeriggio,
        analisi: { ...finta({ ev: 0.05 }), best_pick_idoneo: true, opportunity_score: 0.5 } },
      { match: 'settProssZ', evento: 'Sett Prossima Z', comp: 'Serie A', quando: 'x', inizio: isoSettimanaProssima,
        analisi: { ...finta({ ev: 0.05 }), best_pick_idoneo: true, opportunity_score: 0.99 } } // punteggio migliore ma futuro
    ];
    const partiteOggiTest = partiteGrezze.filter(p => eDiOggi(p.inizio, OGGI, TZ));
    const best = partiteOggiTest.filter(p => p.analisi.best_pick_idoneo).sort((a, b) => b.analisi.opportunity_score - a.analisi.opportunity_score);
    assertVero('best_picks_today: nessun evento futuro anche con opportunity_score migliore', best.every(p => p.match !== 'settProssZ') && best.length === 1 && best[0].match === 'oggiZ');
  }
}

// ---------------------------------------------------------------- riepilogo

console.log(`\n${ok} test superati, ${ko} falliti.`);
if (fail.length) {
  console.log('\nFalliti:');
  fail.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
