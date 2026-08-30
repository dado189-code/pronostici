// scripts/player-layer-esempio.mjs
// Dimostra che il layer giocatori esiste e produce dati reali (non e' uno
// script di produzione, non gira nel workflow). Salva un estratto in
// data/player-layer-esempio.json usando normalizzaGiocatore() su dati veri
// di Understat. Le probabilita' del modello NON leggono questo file: e' qui
// solo come prova che la struttura dati e' pronta per quando servira'.

import { writeFileSync } from 'node:fs';
import { scaricaUnderstatCompleto } from './model.mjs';
import { normalizzaGiocatore } from './features.mjs';

const lega = process.argv[2] || 'Serie_A';
const stagione = process.argv[3] || String(new Date().getFullYear() - (new Date().getMonth() < 6 ? 1 : 0));

const { giocatori } = await scaricaUnderstatCompleto(lega, stagione);
const normalizzati = giocatori.map(normalizzaGiocatore)
  .sort((a, b) => b.npxG - a.npxG)
  .slice(0, 20);

writeFileSync('data/player-layer-esempio.json', JSON.stringify({
  nota: 'Esempio del player layer (FASE 2 punto 14): dati reali da Understat, '
    + 'normalizzati e salvati. NON usato dal modello principale in questa fase.',
  lega, stagione, generato_il: new Date().toISOString(),
  top20PerNpxG: normalizzati
}, null, 1));

console.log(`Salvati ${normalizzati.length} giocatori (top per npxG) su ${giocatori.length} totali.`);
