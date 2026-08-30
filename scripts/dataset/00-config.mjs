// scripts/dataset/00-config.mjs
// Ambito dichiarato della FASE 4, deciso qui e non altrove: chi legge questo
// file sa esattamente quali leghe e stagioni coprono dataset e backtest.
//
// Scelta delle stagioni: le tre piu' recenti CONCLUSE (non quella in corso,
// che e' la stessa che la pipeline di produzione sta usando oggi: mescolarla
// nel backtest sarebbe leakage rispetto a "adesso"). Football-data e Understat
// coprono entrambi queste tre in tutte e cinque le leghe: verificato nello
// script 01, non assunto qui.

export const LEGHE = [
  { nome: 'Premier League', understat: 'EPL',        footballData: 'E0'  },
  { nome: 'Liga',           understat: 'La_liga',     footballData: 'SP1' },
  { nome: 'Serie A',        understat: 'Serie_A',     footballData: 'I1'  },
  { nome: 'Bundesliga',     understat: 'Bundesliga',  footballData: 'D1'  },
  { nome: 'Ligue 1',        understat: 'Ligue_1',     footballData: 'F1'  }
];

// stagioneUnderstat: anno di inizio, es. 2022 = stagione 2022/23
// stagioneFootballData: stesso periodo, formato football-data.co.uk
export const STAGIONI = [
  { understat: '2022', footballData: '2223', etichetta: '2022/23' },
  { understat: '2023', footballData: '2324', etichetta: '2023/24' },
  { understat: '2024', footballData: '2425', etichetta: '2024/25' },
  { understat: '2025', footballData: '2526', etichetta: '2025/26' }
];

// Split cronologico (STEP 11), rivisto per usare la stagione 2025/26 come
// vero test finale fuori campione, quella su cui si gioca la produzione
// 2026/27: TRAIN sono le prime due stagioni intere, VALIDATION e' 2024/25
// per intero (dove si tara tutto: rho, decay, Elo, soglie EV, scelta fra le
// varianti), TEST e' 2025/26 per intero e non si tocca per nessun tuning,
// solo per la misura finale.
export const SPLIT = {
  trainFino: '2024-08-01',       // fine 2023/24, inizio 2024/25
  validationFino: '2025-08-01',  // fine 2024/25, inizio 2025/26
  // dopo validationFino: TEST (2025/26)
};

export const RAW_UNDERSTAT_DIR = 'data/raw/understat';
export const RAW_FOOTBALLDATA_DIR = 'data/raw/football-data';
export const NORMALIZED_DIR = 'data/normalized';
export const DATASET_DIR = 'data/dataset';
