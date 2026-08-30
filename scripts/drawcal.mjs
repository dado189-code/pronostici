// scripts/drawcal.mjs
// DC-DRAW-CAL come layer SPERIMENTALE separato dal Pure Model: isotonic
// regression 1D (pool-adjacent-violators) applicata solo a P_DRAW, mai a
// P1/P2 direttamente. Implementazione identica a quella validata in
// scripts/dataset/18-draw-calibration.mjs (Fase 7/8), spostata qui perche'
// build.mjs deve poterla richiamare in produzione.
//
// Nessuna funzione qui tocca stimaForze/lambde/mercati: il Pure Model resta
// esattamente quello di model.mjs.

import { readFileSync, existsSync } from 'node:fs';
import { DRAWCAL } from './config.mjs';

function isotonicFit(punti) {
  const ordinati = [...punti].sort((a, b) => a.x - b.x);
  const blocchi = ordinati.map(p => ({ sommaY: p.y, n: 1, xMin: p.x, xMax: p.x }));
  let i = 0;
  while (i < blocchi.length - 1) {
    const medioA = blocchi[i].sommaY / blocchi[i].n, medioB = blocchi[i + 1].sommaY / blocchi[i + 1].n;
    if (medioA > medioB) {
      blocchi[i] = { sommaY: blocchi[i].sommaY + blocchi[i + 1].sommaY, n: blocchi[i].n + blocchi[i + 1].n, xMin: blocchi[i].xMin, xMax: blocchi[i + 1].xMax };
      blocchi.splice(i + 1, 1);
      if (i > 0) i--;
    } else i++;
  }
  return blocchi.map(b => ({ xMin: b.xMin, xMax: b.xMax, y: b.sommaY / b.n }));
}

// Funzione A GRADINI, non interpolata: e' cosi' che si verifica una vera
// isotonic regression (vedi 18-draw-calibration.mjs per la nota completa sul
// bug di interpolazione lineare gia' trovato e corretto in Fase 7).
function isotonicPredict(blocchi, x) {
  for (const b of blocchi) if (x <= b.xMax) return b.y;
  return blocchi.at(-1).y;
}

// Fitta il calibratore su TUTTO lo storico disponibile con esito noto
// (data/dataset/previsioni-walkforward.json, usa modelA.PX = P_DRAW di
// Dixon-Coles baseline). Nessuna chiamata di rete: file locale gia' costruito
// dalla Fase 4/8. Ritorna null se il file manca o il campione e' sotto la
// soglia minima identificata in Fase 8 (~2 stagioni, vedi DRAWCAL.minCampione
// in config.mjs) — in quel caso il chiamante deve fare fallback alla baseline.
export function costruisciCalibratore(percorso = 'data/dataset/previsioni-walkforward.json') {
  if (!existsSync(percorso)) return { attivo: false, motivo: `File storico non trovato: ${percorso}` };
  const wf = JSON.parse(readFileSync(percorso, 'utf8'));
  const righe = (wf.previsioni || []).filter(p => p.modelA && typeof p.modelA.PX === 'number' && ['H', 'D', 'A'].includes(p.esito));
  if (righe.length < DRAWCAL.minCampione) {
    return { attivo: false, motivo: `Campione insufficiente per calibrare: ${righe.length} righe, minimo richiesto ${DRAWCAL.minCampione} (Fase 8: ~2 stagioni)` };
  }
  const punti = righe.map(p => ({ x: p.modelA.PX, y: p.esito === 'D' ? 1 : 0 }));
  const blocchi = isotonicFit(punti);
  return { attivo: true, blocchi, nCampione: righe.length };
}

// Applica il calibratore a una tripla (P1, PX, P2) gia' calcolata dal Pure
// Model. Se il calibratore non e' attivo, ritorna la tripla originale
// invariata con un flag esplicito — mai un fallback silenzioso.
export function applicaDrawCal(p1, px, p2, calibratore) {
  if (!calibratore || !calibratore.attivo) {
    return { P1: p1, PX: px, P2: p2, attivo: false, motivo: calibratore?.motivo || 'Calibratore non disponibile' };
  }
  const pxCal = isotonicPredict(calibratore.blocchi, px);
  const restoOriginale = p1 + p2;
  const restoNuovo = 1 - pxCal;
  const scala = restoOriginale > 0 ? restoNuovo / restoOriginale : 0.5;
  return { P1: p1 * scala, PX: pxCal, P2: p2 * scala, attivo: true };
}

export { isotonicFit, isotonicPredict };
