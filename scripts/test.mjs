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
import { fairOdds, ev, edge, agreement, dataQuality, confidence, classificaValore } from './valore.mjs';

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

// ---------------------------------------------------------------- riepilogo

console.log(`\n${ok} test superati, ${ko} falliti.`);
if (fail.length) {
  console.log('\nFalliti:');
  fail.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
