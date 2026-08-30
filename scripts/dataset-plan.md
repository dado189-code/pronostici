# Piano: dataset storico per calibrazione e backtest

Non implementato in questa fase (FASE 1+2), come da istruzione: "prepara
l'architettura ma senza rallentare la FASE 1+2". Questo file e' la traccia da
seguire quando si apre la FASE 4.

## Il problema che risolve

Oggi nessun file del repository contiene, per una stessa partita passata,
sia gli xG/npxG sia le quote di chiusura reali. Senza quell'incrocio non e'
calcolabile Brier, log loss, RPS, ne' una calibrazione seria: si può solo
descrivere il modello, non misurarlo.

## Le due fonti, e cosa manca a ciascuna

| Fonte | Ha | Non ha |
|---|---|---|
| Understat (`scaricaUnderstatCompleto`, gia' in `model.mjs`) | xG, npxG, ppda, deep, xpts, risultato, per partita, dal 2014 | Quote |
| football-data.co.uk (CSV, gia' letto da `backtest.mjs`) | Quote di chiusura 1X2 e O/U 2.5, per partita, molte stagioni | xG |

Entrambe hanno **data**, **squadra casa**, **squadra ospite**: la chiave di
join esiste gia', va solo resa robusta (i nomi squadra non coincidono
lettera per lettera fra le due fonti, esattamente come gia' capita fra
Understat e i bookmaker in `build.mjs`).

## Passi

1. **`scripts/normalizza-nomi.mjs`** — estrarre la funzione `chiave()` gia'
   presente in `build.mjs` in un modulo condiviso, con gli alias gia' noti
   piu' quelli nuovi che servira' scoprire nel join Understat/football-data
   (saranno diversi da quelli bookmaker/Understat: football-data usa sigle
   piu' brevi, es. "Man United" invece di "Manchester United").
2. **`scripts/dataset.mjs`** — per ogni lega e stagione: scarica
   `scaricaUnderstatCompleto`, scarica il CSV football-data (gia' fatto in
   `backtest.mjs`, la funzione `scarica()` e' riusabile), unisce per
   data+squadra normalizzata. Ogni riga del dataset finale porta: xG, npxG,
   ppda, deep home/away, quota di chiusura 1X2 e O/U 2.5, risultato vero,
   **timestamp della partita**. Le partite che non trovano corrispondenza in
   una delle due fonti vengono contate e riportate, non scartate in silenzio.
3. **Verifica anti-leakage** — ogni riga del dataset serve al backtest per
   dire "cosa avrebbe previsto il modello usando SOLO le partite precedenti a
   questa data". Il dataset stesso non contiene previsioni: quelle le
   calcola il backtest a runtime, con `stimaForze` chiamato ogni volta solo
   sulle partite con data precedente. E' esattamente lo schema gia' in
   `backtest.mjs` (walk-forward), da riusare, non da reinventare.
4. **Split temporale** — non train/test casuale. Sequenza cronologica:
   `TRAIN` (stagioni piu' vecchie) → `VALIDATION` (una stagione intermedia,
   dove si tara emivita, rho, eventuali pesi) → `TEST` (l'ultima stagione
   disponibile, toccata una volta sola a fine lavoro).
5. **Formato di storage** — file JSON per lega/stagione dentro `data/dataset/`,
   non un unico file monolitico: cosi' si puo' rigenerare una sola stagione
   senza ricalcolare tutto, e i diff su git restano leggibili.
6. **Metriche** (FASE 4, non qui) — una volta che il dataset esiste,
   `scripts/backtest.mjs` calcola Brier, log loss, RPS confrontando
   `football-v1-baseline` e `football-v2-understat` (e ogni versione
   successiva) sullo stesso TEST, sotto lo stesso protocollo.

## Cosa NON fare

- Non mescolare mai train/validation/test per comodita' di codice: il
  controllo "nessuna feature con timestamp successivo al kickoff" va
  verificato a livello di dataset, non solo di modello.
- Non stimare l'emivita o rho sul TEST: solo su VALIDATION. Il TEST serve a
  una sola cosa, dire se il modello scelto su VALIDATION regge anche su dati
  mai visti.
- Non buttare le partite che non trovano corrispondenza fra le due fonti:
  contarle e riportarle e' un dato di qualita' del dataset stesso.
