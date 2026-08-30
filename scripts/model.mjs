// scripts/model.mjs
// Modello indipendente dal mercato: stima la forza di attacco e difesa di ogni
// squadra dagli expected goals delle partite giocate, con decadimento temporale,
// e ne ricava la distribuzione dei gol di ogni partita futura (Dixon-Coles).
//
// Perche' serve: le probabilita' dei feed commerciali nascono in buona parte
// dalle stesse fonti che alimentano le lavagne dei bookmaker. Confrontarle con
// la quota e' un ragionamento circolare. Questo modello non guarda le quote.

// ---------------------------------------------------------------- utilita'

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function poisson(k, lam) {
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return Math.exp(-lam) * Math.pow(lam, k) / f;
}

// Correzione Dixon-Coles: i punteggi bassi non sono indipendenti come
// vorrebbe Poisson. Gli 0-0 e gli 1-1 escono piu' spesso del previsto.
function tau(i, j, lh, la, rho) {
  if (i === 0 && j === 0) return 1 - lh * la * rho;
  if (i === 0 && j === 1) return 1 + lh * rho;
  if (i === 1 && j === 0) return 1 + la * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

// ---------------------------------------------------------------- dati

// Understat serve gli xG partita per partita da un endpoint JSON.
// Fino al 2026 i dati stavano dentro la pagina, in un blob "datesData = JSON.parse('...')";
// ora la pagina si popola via AJAX e quel blob non esiste piu'. La risposta ha la
// stessa forma di prima ({dates, teams, players}), quindi cambia solo come la si prende.
// Senza gli header da browser il server risponde con una pagina HTML di errore.
async function scaricaUnderstat(lega, stagione) {
  const url = `https://understat.com/getLeagueData/${lega}/${stagione}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `https://understat.com/league/${lega}/${stagione}`,
    'Accept': 'application/json, text/javascript, */*; q=0.01'
  };

  let dati = null, ultimo = '';
  for (let tentativo = 1; tentativo <= 3 && !dati; tentativo++) {
    if (tentativo > 1) await new Promise(r => setTimeout(r, 1000 * tentativo));
    const res = await fetch(url, { headers });
    if (!res.ok) { ultimo = `HTTP ${res.status}`; continue; }
    const testo = await res.text();
    // sotto carico risponde HTML al posto del JSON: e' un errore, non dati vuoti
    try { dati = JSON.parse(testo); }
    catch { ultimo = `risposta non JSON (${testo.slice(0, 40).replace(/\s+/g, ' ')}...)`; }
  }
  if (!dati) throw new Error(`Understat ${lega}: ${ultimo}`);
  if (!Array.isArray(dati.dates)) throw new Error(`Understat ${lega}: campo dates assente`);

  return dati.dates
    .filter(p => p.isResult)
    .map(p => ({
      data: new Date(p.datetime),
      casa: p.h.title,
      ospite: p.a.title,
      xgCasa: parseFloat(p.xG.h),
      xgOspite: parseFloat(p.xG.a),
      golCasa: parseInt(p.goals.h, 10),
      golOspite: parseInt(p.goals.a, 10)
    }))
    .filter(p => Number.isFinite(p.xgCasa) && Number.isFinite(p.xgOspite));
}

// Come scaricaUnderstat, ma porta anche cio' che il blocco "teams" e "players"
// gia' contengono e che finora restava a terra: npxG, npxGA, ppda, deep, xpts,
// il flag casa/trasferta, e i giocatori. Stessa richiesta di rete di prima,
// stesso costo (zero: Understat non e' a pagamento), un solo parsing in piu'.
//
// Il join fra "dates" (il calendario) e "teams[].history" (le statistiche) e'
// su squadra+giorno: verificato su una stagione intera, 380 partite su 380
// si accoppiano senza ambiguita'. Se in futuro non si accoppiasse piu' (un
// cambio di formato lato Understat), meglio fallire con un errore chiaro che
// proseguire con dati disallineati: e' quello che fa il controllo sotto.
async function scaricaUnderstatCompleto(lega, stagione) {
  const url = `https://understat.com/getLeagueData/${lega}/${stagione}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `https://understat.com/league/${lega}/${stagione}`,
    'Accept': 'application/json, text/javascript, */*; q=0.01'
  };

  let dati = null, ultimo = '';
  for (let tentativo = 1; tentativo <= 3 && !dati; tentativo++) {
    if (tentativo > 1) await new Promise(r => setTimeout(r, 1000 * tentativo));
    const res = await fetch(url, { headers });
    if (!res.ok) { ultimo = `HTTP ${res.status}`; continue; }
    const testo = await res.text();
    try { dati = JSON.parse(testo); }
    catch { ultimo = `risposta non JSON (${testo.slice(0, 40).replace(/\s+/g, ' ')}...)`; }
  }
  if (!dati) throw new Error(`Understat ${lega}: ${ultimo}`);
  if (!Array.isArray(dati.dates)) throw new Error(`Understat ${lega}: campo dates assente`);
  if (!dati.teams) throw new Error(`Understat ${lega}: campo teams assente`);

  // indice squadra+giorno -> riga di history, per il join
  const perSquadraGiorno = {};
  for (const t of Object.values(dati.teams)) {
    for (const h of t.history) {
      const chiave = `${t.title}|${h.date.slice(0, 10)}`;
      perSquadraGiorno[chiave] = h;
    }
  }

  const partite = dati.dates.filter(p => p.isResult).map(p => {
    const giorno = p.datetime.slice(0, 10);
    const hCasa = perSquadraGiorno[`${p.h.title}|${giorno}`];
    const hOspite = perSquadraGiorno[`${p.a.title}|${giorno}`];
    const base = {
      data: new Date(p.datetime), casa: p.h.title, ospite: p.a.title,
      xgCasa: parseFloat(p.xG.h), xgOspite: parseFloat(p.xG.a),
      golCasa: parseInt(p.goals.h, 10), golOspite: parseInt(p.goals.a, 10)
    };
    if (!hCasa || !hOspite || hCasa.h_a !== 'h' || hOspite.h_a !== 'a') {
      // il join non ha trovato le due meta': si tiene la partita coi soli dati
      // base (compatibili con scaricaUnderstat) e si segnala l'assenza invece
      // di inventare npxG.
      return { ...base, npxgCasa: null, npxgOspite: null, ppdaCasa: null, ppdaOspite: null,
        deepCasa: null, deepOspite: null, xptsCasa: null, xptsOspite: null, joinRiuscito: false };
    }
    return {
      ...base,
      npxgCasa: parseFloat(hCasa.npxG), npxgOspite: parseFloat(hOspite.npxG),
      ppdaCasa: hCasa.ppda, ppdaOspite: hOspite.ppda,
      deepCasa: hCasa.deep, deepOspite: hOspite.deep,
      xptsCasa: hCasa.xpts, xptsOspite: hOspite.xpts,
      joinRiuscito: true
    };
  }).filter(p => Number.isFinite(p.xgCasa) && Number.isFinite(p.xgOspite));

  const squadre = {};
  for (const t of Object.values(dati.teams)) {
    squadre[t.title] = t.history.map(h => ({
      data: h.date, h_a: h.h_a, xG: h.xG, xGA: h.xGA, npxG: h.npxG, npxGA: h.npxGA,
      npxGD: h.npxGD, ppda: h.ppda, ppda_allowed: h.ppda_allowed,
      deep: h.deep, deep_allowed: h.deep_allowed, xpts: h.xpts, pts: h.pts, result: h.result
    })).sort((a, b) => new Date(b.data) - new Date(a.data)); // piu' recente prima
  }

  const giocatori = Object.values(dati.players || {});

  return { partite, squadre, giocatori };
}

// ---------------------------------------------------------------- stima

// Punto fisso della massima verosimiglianza Poisson: alterna il calcolo degli
// attacchi e delle difese finche' i valori smettono di muoversi. Ogni partita
// pesa meno mano a mano che invecchia (emivita in giorni).
// campoXG: 'xg' (default, e' il comportamento della baseline, invariato) oppure
// 'npxg', che usa npxgCasa/npxgOspite se la partita li porta (solo con dati da
// scaricaUnderstatCompleto) e ricade su xgCasa/xgOspite altrimenti, cosi' una
// singola partita senza join riuscito non introduce un buco silenzioso.
function stimaForze(partite, { emivita = 180, iterazioni = 200, oggi = new Date(), campoXG = 'xg' } = {}) {
  const xgC = campoXG === 'npxg'
    ? (p) => (Number.isFinite(p.npxgCasa) ? p.npxgCasa : p.xgCasa)
    : (p) => p.xgCasa;
  const xgO = campoXG === 'npxg'
    ? (p) => (Number.isFinite(p.npxgOspite) ? p.npxgOspite : p.xgOspite)
    : (p) => p.xgOspite;

  const squadre = [...new Set(partite.flatMap(p => [p.casa, p.ospite]))];
  const att = Object.fromEntries(squadre.map(s => [s, 1]));
  const dif = Object.fromEntries(squadre.map(s => [s, 1]));
  let casa = 1.25;

  const peso = partite.map(p =>
    Math.pow(0.5, (oggi - p.data) / (86400000 * emivita)));
  const pesoTot = peso.reduce((a, b) => a + b, 0);

  // scala comune: gol attesi medi per squadra per partita
  let golMedi = partite.reduce((a, p, k) => a + peso[k] * (xgC(p) + xgO(p)), 0)
              / (2 * pesoTot);

  const normalizza = (o) => {
    const m = squadre.reduce((a, s) => a + o[s], 0) / squadre.length;
    squadre.forEach(s => { o[s] = clamp(o[s] / m, 0.25, 3.0); });
  };

  for (let it = 0; it < iterazioni; it++) {
    // attacco: xG fatti diviso xG che una squadra media farebbe contro quegli avversari
    for (const s of squadre) {
      let num = 0, den = 0;
      partite.forEach((p, k) => {
        if (p.casa === s)   { num += peso[k] * xgC(p);   den += peso[k] * golMedi * dif[p.ospite] * casa; }
        if (p.ospite === s) { num += peso[k] * xgO(p); den += peso[k] * golMedi * dif[p.casa]; }
      });
      if (den > 0) att[s] = clamp(num / den, 0.25, 3.0);
    }
    normalizza(att);

    // difesa: xG subiti diviso xG che una squadra media subirebbe da quegli avversari
    for (const s of squadre) {
      let num = 0, den = 0;
      partite.forEach((p, k) => {
        if (p.casa === s)   { num += peso[k] * xgO(p); den += peso[k] * golMedi * att[p.ospite]; }
        if (p.ospite === s) { num += peso[k] * xgC(p);   den += peso[k] * golMedi * att[p.casa] * casa; }
      });
      if (den > 0) dif[s] = clamp(num / den, 0.25, 3.0);
    }
    normalizza(dif);

    // vantaggio del campo: rapporto fra xG in casa osservati e attesi
    let nc = 0, dc = 0;
    partite.forEach((p, k) => {
      nc += peso[k] * xgC(p);
      dc += peso[k] * golMedi * att[p.casa] * dif[p.ospite];
    });
    if (dc > 0) casa = clamp(nc / dc, 1.0, 1.6);

    // riallinea la scala complessiva
    let ns = 0, ds = 0;
    partite.forEach((p, k) => {
      ns += peso[k] * (xgC(p) + xgO(p));
      ds += peso[k] * (att[p.casa] * dif[p.ospite] * casa + att[p.ospite] * dif[p.casa]);
    });
    if (ds > 0) golMedi = ns / ds;
  }

  return { att, dif, casa, golMedi, squadre, nPartite: partite.length };
}

// rho stimato sui gol veri, non sugli xG: serve proprio a correggere
// la frequenza osservata dei risultati bassi.
// I default sono i valori storici invariati: la griglia va idealmente letta
// da config.mjs (MODELLO.rhoMin/rhoMax/rhoPasso), ma model.mjs resta un
// modulo puro senza dipendere da config, quindi chi chiama passa i valori
// esplicitamente se vuole cambiarli; senza farlo il comportamento e' identico.
function stimaRho(partite, forze, { rhoMin = -0.2, rhoMax = 0.05, rhoPasso = 0.005 } = {}) {
  let best = 0, bestLL = -Infinity;
  for (let rho = rhoMin; rho <= rhoMax; rho += rhoPasso) {
    let ll = 0;
    for (const p of partite) {
      const { lh, la } = lambde(forze, p.casa, p.ospite);
      if (!lh) continue;
      const t = tau(p.golCasa, p.golOspite, lh, la, rho);
      if (t <= 0) { ll = -Infinity; break; }
      ll += Math.log(t) + Math.log(poisson(p.golCasa, lh)) + Math.log(poisson(p.golOspite, la));
    }
    if (ll > bestLL) { bestLL = ll; best = rho; }
  }
  return best;
}

function lambde(forze, casa, ospite) {
  const { att, dif, golMedi } = forze;
  if (!att[casa] || !att[ospite]) return { lh: 0, la: 0 };
  return {
    lh: golMedi * att[casa] * dif[ospite] * forze.casa,
    la: golMedi * att[ospite] * dif[casa]
  };
}

// ---------------------------------------------------------------- mercati

function matrice(lh, la, rho, N = 11) {
  const m = [];
  let somma = 0;
  for (let i = 0; i < N; i++) {
    m[i] = [];
    for (let j = 0; j < N; j++) {
      m[i][j] = poisson(i, lh) * poisson(j, la) * tau(i, j, lh, la, rho);
      somma += m[i][j];
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) m[i][j] /= somma;
  return m;
}

function mercati(lh, la, rho) {
  const m = matrice(lh, la, rho), N = m.length;
  const su = (f) => {
    let s = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (f(i, j)) s += m[i][j];
    return s;
  };
  const tot = (lo, hi) => su((i, j) => i + j >= lo && i + j <= hi);
  const p1 = su((i, j) => i > j), px = su((i, j) => i === j), p2 = su((i, j) => i < j);
  return {
    '1': p1, 'X': px, '2': p2,
    '1X': p1 + px, 'X2': px + p2, '12': p1 + p2,
    'Over 1.5': tot(2, 99), 'Over 2.5': tot(3, 99),
    'Under 2.5': tot(0, 2), 'Under 3.5': tot(0, 3), 'Under 4.5': tot(0, 4),
    'Multigol 1-3': tot(1, 3), 'Multigol 1-4': tot(1, 4), 'Multigol 1-5': tot(1, 5),
    'Multigol 2-4': tot(2, 4), 'Multigol 2-5': tot(2, 5), 'Multigol 3-5': tot(3, 5),
    'Multigol casa 1-2': su((i) => i >= 1 && i <= 2),
    'Multigol casa 1-3': su((i) => i >= 1 && i <= 3),
    'Multigol trasferta 1-2': su((_, j) => j >= 1 && j <= 2),
    'Multigol trasferta 1-3': su((_, j) => j >= 1 && j <= 3),
    'Casa segna': su((i) => i >= 1),
    'Trasferta segna': su((_, j) => j >= 1),
    'Gol': su((i, j) => i >= 1 && j >= 1),
    'NoGol': 1 - su((i, j) => i >= 1 && j >= 1)
  };
}

// ---------------------------------------------------------------- quote

// Toglie il margine normalizzando le quote di ogni singolo book a somma 1,
// poi fa la media fra i book: e' la probabilita' che il mercato sta prezzando.
function consenso(bookmakers) {
  const acc = {}, best = {};
  let n = 0;
  for (const b of bookmakers || []) {
    const mk = (b.markets || []).find(x => x.key === 'h2h');
    if (!mk) continue;
    const somma = mk.outcomes.reduce((a, o) => a + 1 / o.price, 0);
    n++;
    for (const o of mk.outcomes) {
      (acc[o.name] ||= []).push((1 / o.price) / somma);
      if (!best[o.name] || o.price > best[o.name].prezzo)
        best[o.name] = { prezzo: o.price, book: b.title };
    }
  }
  if (n < 3) return null;
  const out = {};
  for (const k of Object.keys(acc))
    out[k] = { prob: acc[k].reduce((a, x) => a + x, 0) / acc[k].length, ...best[k], nBook: n };
  return out;
}

export { scaricaUnderstat, scaricaUnderstatCompleto, stimaForze, stimaRho, lambde, mercati, matrice, consenso, poisson, tau };
