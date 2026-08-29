// scripts/backtest.mjs
// Riesegue la strategia su partite gia' giocate, con le quote di chiusura reali.
// Serve a rispondere a una sola domanda: questo metodo avrebbe fatto soldi?
//
// Dati: football-data.co.uk, CSV gratuiti con risultati e quote di chiusura
// di piu' bookmaker. Il campo B365CH e' la quota Bet365 di chiusura sul segno 1,
// PSCH quella di Pinnacle, e cosi' via.
//
// Uso: node scripts/backtest.mjs [stagioni] [lega]
//   node scripts/backtest.mjs 2223,2324,2425 I1

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { stimaForze, stimaRho, lambde, mercati } from './model.mjs';

const STAGIONI = (process.argv[2] || '2223,2324,2425').split(',');
const LEGHE = (process.argv[3] || 'I1,E0,SP1,F1,D1').split(',');
const NOMI = { I1: 'Serie A', E0: 'Premier League', SP1: 'Liga', F1: 'Ligue 1', D1: 'Bundesliga' };

// ---------- lettura CSV

function csv(testo) {
  const righe = testo.trim().split(/\r?\n/);
  const intest = righe[0].split(',');
  return righe.slice(1).map(r => {
    // niente virgole dentro i campi in questi file, split semplice
    const c = r.split(',');
    return Object.fromEntries(intest.map((h, i) => [h.trim(), c[i]]));
  });
}

function dataIt(s) {
  const [g, m, a] = (s || '').split('/');
  if (!g) return null;
  const anno = a.length === 2 ? 2000 + Number(a) : Number(a);
  return new Date(anno, Number(m) - 1, Number(g));
}

async function scarica(stagione, lega) {
  const url = `https://www.football-data.co.uk/mmz4281/${stagione}/${lega}.csv`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${lega} ${stagione}: HTTP ${r.status}`);
  return csv(await r.text())
    .map(p => ({
      data: dataIt(p.Date),
      casa: p.HomeTeam, ospite: p.AwayTeam,
      golCasa: Number(p.FTHG), golOspite: Number(p.FTAG),
      // niente xG in questi file: uso i gol come proxy. Meno preciso,
      // ma e' l'unico storico con le quote di chiusura allegate.
      xgCasa: Number(p.FTHG), xgOspite: Number(p.FTAG),
      // quote di chiusura: preferisco Pinnacle, ripiego su Bet365 e sulla media
      q1: Number(p.PSCH || p.B365CH || p.AvgCH || p.PSH || p.B365H || p.AvgH),
      qX: Number(p.PSCD || p.B365CD || p.AvgCD || p.PSD || p.B365D || p.AvgD),
      q2: Number(p.PSCA || p.B365CA || p.AvgCA || p.PSA || p.B365A || p.AvgA),
      qOver: Number(p['B365C>2.5'] || p['B365>2.5'] || p['Avg>2.5']),
      qUnder: Number(p['B365C<2.5'] || p['B365<2.5'] || p['Avg<2.5'])
    }))
    .filter(p => p.data && p.casa && Number.isFinite(p.golCasa));
}

// ---------- esito dei mercati

// Esportata: e' la regola di liquidazione unica, usata sia qui sia da chiudi.mjs.
// Se cambia una regola deve cambiare in un posto solo.
export function vinta(mercato, gc, ga) {
  const t = gc + ga;
  switch (mercato) {
    case '1': return gc > ga;
    case 'X': return gc === ga;
    case '2': return gc < ga;
    case '1X': return gc >= ga;
    case 'X2': return gc <= ga;
    case '12': return gc !== ga;
    case 'Over 1.5': return t >= 2;
    case 'Over 2.5': return t >= 3;
    case 'Under 2.5': return t <= 2;
    case 'Under 3.5': return t <= 3;
    case 'Under 4.5': return t <= 4;
    case 'Multigol 1-3': return t >= 1 && t <= 3;
    case 'Multigol 1-4': return t >= 1 && t <= 4;
    case 'Multigol 1-5': return t >= 1 && t <= 5;
    case 'Multigol 2-4': return t >= 2 && t <= 4;
    case 'Multigol 2-5': return t >= 2 && t <= 5;
    case 'Multigol 3-5': return t >= 3 && t <= 5;
    case 'Multigol casa 1-2': return gc >= 1 && gc <= 2;
    case 'Multigol casa 1-3': return gc >= 1 && gc <= 3;
    case 'Multigol trasferta 1-2': return ga >= 1 && ga <= 2;
    case 'Multigol trasferta 1-3': return ga >= 1 && ga <= 3;
    case 'Casa segna': return gc >= 1;
    case 'Trasferta segna': return ga >= 1;
    case 'Gol': return gc >= 1 && ga >= 1;
    case 'NoGol': return !(gc >= 1 && ga >= 1);
    default: return null;
  }
}

// La quota reale la conosco solo per 1X2 e over/under 2.5. Per gli altri
// mercati stimo il prezzo applicando il margine medio osservato sull'1X2
// della stessa partita: senza questo il backtest sarebbe ottimista e falso.
function prezzoStimato(prob, margine) {
  return 1 / (prob * (1 + margine));
}

function margineOsservato(p) {
  if (!(p.q1 > 1 && p.qX > 1 && p.q2 > 1)) return 0.06;
  return (1 / p.q1 + 1 / p.qX + 1 / p.q2) - 1;
}

function scegli(mk, lo, hi, obiettivo, usati) {
  const c = Object.entries(mk).filter(([, v]) => v >= lo && v <= hi);
  if (!c.length) return null;
  c.sort((a, b) => (Math.abs(a[1] - obiettivo) + 0.06 * (usati[a[0]] || 0))
                 - (Math.abs(b[1] - obiettivo) + 0.06 * (usati[b[0]] || 0)));
  return c[0];
}

// ---------- esecuzione

// Sta dentro una funzione, non al livello del modulo, perche' chiudi.mjs importa
// vinta() da qui: senza questo, ogni import farebbe ripartire tutto il backtest.
async function main() {
  const risultati = [];
  const perLega = {};

  for (const lega of LEGHE) {
    let tutte = [];
    for (const st of STAGIONI) {
      try { tutte.push(...await scarica(st, lega)); }
      catch (e) { console.warn(e.message); }
    }
    if (tutte.length < 200) { console.warn(`${lega}: solo ${tutte.length} partite, salto`); continue; }
    tutte.sort((a, b) => a.data - b.data);

    // walk-forward: per ogni partita stimo il modello SOLO sulle precedenti.
    // Usare anche le successive sarebbe barare, ed e' l'errore piu' comune
    // nei backtest che sembrano funzionare.
    const MINIMO = 150;
    const usati = {};
    let saldo = 0, giocate = 0, vinte = 0, probTot = 0;

    for (let i = MINIMO; i < tutte.length; i++) {
      const p = tutte[i];
      const passate = tutte.slice(Math.max(0, i - 600), i);
      if (i % 10 !== 0) continue;             // una partita su dieci: tiene i tempi ragionevoli
      const forze = stimaForze(passate, { emivita: 180, iterazioni: 60, oggi: p.data });
      if (!forze.att[p.casa] || !forze.att[p.ospite]) continue;
      const rho = -0.03;
      const { lh, la } = lambde(forze, p.casa, p.ospite);
      if (!lh || !la) continue;
      const mk = mercati(lh, la, rho);

      const scelta = scegli(mk, 0.56, 0.78, 0.66, usati);
      if (!scelta) continue;
      const [mercato, prob] = scelta;
      usati[mercato] = (usati[mercato] || 0) + 1;

      const esito = vinta(mercato, p.golCasa, p.golOspite);
      if (esito === null) continue;

      const marg = margineOsservato(p);
      // se ho la quota vera la uso, altrimenti la stimo col margine di quella partita
      let quota = null;
      if (mercato === '1' && p.q1 > 1) quota = p.q1;
      else if (mercato === 'X' && p.qX > 1) quota = p.qX;
      else if (mercato === '2' && p.q2 > 1) quota = p.q2;
      else if (mercato === 'Over 2.5' && p.qOver > 1) quota = p.qOver;
      else if (mercato === 'Under 2.5' && p.qUnder > 1) quota = p.qUnder;
      else quota = prezzoStimato(prob, marg);

      saldo += esito ? quota - 1 : -1;
      giocate++; if (esito) vinte++; probTot += prob;
      risultati.push({ lega, data: p.data.toISOString().slice(0, 10), partita: `${p.casa}-${p.ospite}`,
        mercato, prob: +prob.toFixed(3), quota: +quota.toFixed(2), esito: esito ? 'ok' : 'ko' });
    }

    perLega[NOMI[lega] || lega] = {
      giocate, vinte, attese: +probTot.toFixed(1),
      percentuale: giocate ? +(vinte / giocate * 100).toFixed(1) : 0,
      saldo: +saldo.toFixed(2),
      rendimento: giocate ? +(saldo / giocate * 100).toFixed(2) : 0
    };
    console.log(`${(NOMI[lega] || lega).padEnd(16)} ${giocate} giocate, ${vinte} vinte `
      + `(attese ${probTot.toFixed(1)}), saldo ${saldo.toFixed(2)}, rendimento ${(saldo / giocate * 100).toFixed(2)}%`);
  }

  const tot = Object.values(perLega).reduce((a, x) => ({
    giocate: a.giocate + x.giocate, vinte: a.vinte + x.vinte,
    attese: a.attese + x.attese, saldo: a.saldo + x.saldo
  }), { giocate: 0, vinte: 0, attese: 0, saldo: 0 });

  console.log('\n== TOTALE');
  console.log(`giocate ${tot.giocate}, vinte ${tot.vinte}, attese dal modello ${tot.attese.toFixed(1)}`);
  console.log(`saldo ${tot.saldo.toFixed(2)} unita, rendimento ${(tot.saldo / tot.giocate * 100).toFixed(2)}% per giocata`);
  const sd = Math.sqrt(tot.giocate) * 0.5;
  console.log(`errore statistico indicativo su ${tot.giocate} giocate: circa ${sd.toFixed(1)} unita.`);
  console.log(tot.saldo > 2 * sd ? 'Il vantaggio supera il rumore.'
    : tot.saldo < -2 * sd ? 'La strategia perde in modo sistematico.'
    : 'Risultato dentro il rumore: non si puo concludere nulla.');

  writeFileSync('data/backtest.json', JSON.stringify({
    eseguito: new Date().toISOString(), stagioni: STAGIONI, perLega, totale: tot,
    nota: 'Le quote di 1X2 e over/under 2.5 sono reali e di chiusura. Per gli altri mercati il prezzo e stimato applicando il margine osservato sull 1X2 della stessa partita.',
    giocate: risultati.slice(-500)
  }, null, 1));
}

// solo se lanciato direttamente: `node scripts/backtest.mjs`.
// argv[1] non esiste quando node gira con -e, da qui il controllo prima.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
