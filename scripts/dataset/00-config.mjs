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
  { understat: '2024', footballData: '2425', etichetta: '2024/25' }
];

// Split cronologico (STEP 11), deciso PRIMA di guardare qualunque metrica:
// TRAIN sono le prime due stagioni intere. La stagione piu' recente (2024/25,
// 15 agosto 2024 - 25 maggio 2025, mediana attorno al 12 gennaio 2025) si
// divide a meta': la prima meta' e' VALIDATION (dove si tara tutto: rho,
// soglie EV, eventuali pesi), la seconda meta' e' TEST e non si tocca per
// nessun tuning, solo per la misura finale.
export const SPLIT = {
  trainFino: '2024-08-14',       // fine 2023/24
  validationFino: '2025-01-12',  // meta' di 2024/25
  // dopo validationFino: TEST
};

export const RAW_UNDERSTAT_DIR = 'data/raw/understat';
export const RAW_FOOTBALLDATA_DIR = 'data/raw/football-data';
export const NORMALIZED_DIR = 'data/normalized';
export const DATASET_DIR = 'data/dataset';
