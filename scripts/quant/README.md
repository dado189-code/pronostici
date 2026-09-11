# Motore quantitativo candidato — prima fase

Entrypoint ES module: `scripts/quant/index.mjs`. Solo JavaScript standard, Node >=22, nessuna dipendenza. Le funzioni pure possono essere importate anche dal browser; il CLI usa Node. Tutte le percentuali in input sono frazioni (0.65, non 65). Le quote sono decimali. Gli errori di input generano eccezioni: nessuna probabilità sostitutiva viene inventata.

Il codice è implementato e testato matematicamente. Non equivale a un modello validato per puntate reali. Non è collegato all'interfaccia o al workflow di produzione. La policy online resta invariata finché non viene approvata l'integrazione. I nuovi modelli e mercati richiedono un backtest cronologico specifico; il backtest pubblicato finora riguarda solo il precedente calcio 1X2.

## Calcio

`fitFootball(history, asOf)` accetta un array di oggetti con `id`, `kickoff`, `observedAt`, `home`, `away`, `homeXG`, `awayXG`, `homeGoals`, `awayGoals`. Timestamp ISO UTC terminanti in Z; `observedAt` è il momento in cui il dato è diventato disponibile. Sono utilizzabili solo osservazioni antecedenti al cutoff. Almeno 100 partite; ID unici.

Riutilizza la stima esistente di attacco, difesa ed effetto casa con dimezzamento del peso in 180 giorni. Gli xGA sono gli xG realizzati dall'avversario nella stessa partita, non una seconda variabile da sommare. I gol reali servono alla stima della correzione rho. La stima sulle quantità xG continue è una pseudo-verosimiglianza Poisson, non la verosimiglianza originale di conteggi interi Dixon-Coles.

`predictFootball(model, home, away)` restituisce intensità, matrice punteggi e `markets`: `1`, `X`, `2`, `over25`, `under25`, `goal`, `noGoal`. `footballFromRates({homeXG,awayXG,rho,tolerance})` espone il calcolo diretto con intensità già stimate. La distribuzione è Poisson(homeXG) × Poisson(awayXG) × tau; tau corregge 0–0, 0–1, 1–0, 1–1. Coda adattiva con errore massimo richiesto 1e-12; restituisce `omittedMass`. Rho incompatibile produce errore, non clipping. Questo cambiamento della coda ha una versione distinta dal motore già sottoposto a backtest.

## Tennis

`tennisSurfaceStats(rows,{surface,asOf})`: uno storico per ciascun giocatore. Ogni riga contiene `id`, `kickoff`, `observedAt`, `surface` e conteggi interi `servePoints`, `firstIn`, `firstWon`, `secondWon`, `bpFaced`, `bpSaved`, `bpChances`, `bpConverted`. Surface: `clay`, `hard`, `grass`. I punti sulla seconda includono quelli persi per doppio fallo nel denominatore `servePoints-firstIn`. Non si mediano percentuali di partite con pesi uguali: si aggregano numeratori e denominatori.

`predictTennis(statsA,statsB,format)` usa:

- p servizio ordinario = firstInRate × firstWinRate + (1-firstInRate) × secondWinRate.
- p servizio su break point = (BP salvati del battitore + BP non convertiti dal ricevitore + priorPoints × p ordinario) / (BP affrontati + BP a favore del ricevitore + priorPoints).
- `pressurePriorPoints=20` è una scelta di shrinkage dichiarata e da validare, non un coefficiente stimato o uno standard ITF. In assenza di break point osservati, torna esattamente alla probabilità ordinaria.
- Game: catena assorbente a 18 stati transitori; risolve `(I-Q)u=r`, inclusi deuce e vantaggi. La probabilità di break point sostituisce quella ordinaria esclusivamente negli stati di possibile break.
- Tie-break: ordine di servizio 1-2-2, margine di due punti, coda infinita risolta analiticamente.
- Set: primo a sei game con due di vantaggio, tie-break sul 6–6; distribuzione congiunta vincitore/prossimo battitore. Match: conserva l'ordine di servizio fra i set.

Formato: `bestOf` 3 o 5; `firstServer` 0 (A) o 1 (B); `tieBreakTarget` 7 o 10; `finalSetTieBreakTarget` 7 o 10. Default 3, 0, 7, 10: il chiamante deve passare il regolamento effettivo del torneo. Non sono supportati advantage set senza tie-break, no-ad, Fast4, doppio, match tie-break sostitutivo del set, ritiri o walkover. Un formato non supportato richiede un'estensione esplicita, non una falsa equivalenza.

Le funzioni `gameWinProbability`, `tieBreakProbability` e `tennisMatchFromProbabilities` sono disponibili separatamente. Le probabilità elementari devono essere strettamente fra zero e uno per garantire assorbimento. Il pooling BP è un modello candidato; non è una misura psicologica. Il servizio ordinario non è corretto per il livello degli avversari storici, né per età/recenza del campione. L'accuratezza empirica va misurata per superficie, circuito e formato.

## Basket

`fourFactors(box,opponent,{minutes=48,regulationMinutes=48,freeThrowWeight=0.44})` richiede conteggi interi `fgm`, `fga`, `threeMade`, `ftm`, `fta`, `tov`, `orb`, `drb`, per squadra e avversaria:

- eFG = (FGM + 0.5 × 3PM) / FGA.
- TOV = TOV / (FGA + 0.44 × FTA + TOV).
- ORB = ORB / (ORB + DRB avversari).
- FT/FGA = liberi **realizzati** / FGA, non tentati.
- Possessi stimati = media dei due valori FGA + 0.44 × FTA − ORB + TOV.
- Pace = possessi stimati × durata regolamentare / minuti effettivi. Usare 40 per WNBA/FIBA e 48 per NBA, dichiarando tutti i minuti, inclusi overtime.

Il coefficiente 0.44 è un'approssimazione configurabile. Le definizioni dei provider possono differire: non mescolare TOV/possessi con la definizione sopra. Il box score di una partita da prevedere non può mai essere usato per costruirne le feature.

`fitBasketball(rows,{asOf,ridge=1,minSamples=30})` stima una regressione ridge standardizzata, intercetta non penalizzata, su otto Four Factors (quattro propri, quattro concessi dall'avversario) ed effetto casa. Nessun peso 40/25/20/15 viene spacciato per una previsione di punteggio. Ogni riga: `id`, `featuresAt`, `kickoff`, `observedAt`, `own`, `opponentAllowed`, `isHome`, `points`, `possessions`. `own` e `opponentAllowed` contengono `efg`, `tov`, `orb`, `ftRate` calcolati **solo sulle partite precedenti**. Target: 100 × punti / possessi. Il chiamante deve fornire uno storico omogeneo per competizione; 30 righe è un minimo tecnico, non sufficienza statistica.

`predictBasketball(model,{home,away,leaguePace,at},residualModel)` richiede per entrambe le squadre `own`, `allowed`, `pace`, `featuresAt`, `regulationMinutes`. La pace di lega deve usare la stessa unità e lo stesso periodo dei profili squadra. Pace matchup = paceCasa × paceOspite / paceLega (ipotesi esplicita); punti attesi = rating × pace / 100.

Senza `residualModel`, restituisce punteggi e `pHome:null`, `pAway:null`. Non inventa una deviazione standard per costruire probabilità.

`fitBasketballResiduals(rows,{asOf,minSamples=30})` richiede vere previsioni cronologiche fuori campione, ciascuna con `id`, `trainingEnd`, `forecastAt`, `kickoff`, `observedAt`, `predictedHome`, `predictedAway`, `actualHome`, `actualAway`. Verifica trainingEnd < forecastAt < kickoff < observedAt < cutoff per le righe utilizzate. Calcola bias medio e deviazione campionaria degli errori di margine e totale. I timestamp dichiarati non certificano da soli la correttezza della provenienza: conservarne le previsioni immutabili e gli split. Nessun residuo in-sample va passato a questa funzione.

Con questi residui, pCasa = Phi((margine previsto + bias) / sd). L'approssimazione gaussiana deve essere verificata; il contratto è vincente finale **inclusi overtime**. `basketballTotals(prediction,line)` supporta solo linee mezzo punto per evitare pareggi/push non modellati. Non sono coperti mercati sui soli tempi regolamentari o linee intere. Errori e profili devono provenire dallo stesso modello/procedura e dalla stessa competizione.

## Mercato, EV e bankroll

`removeMargin(odds)` richiede tutte le quote di un singolo mercato esaustivo e mutuamente esclusivo, dello stesso bookmaker e istante. Restituisce p_i=(1/quota_i)/somma(1/quota), overround e metodo proporzionale. Queste sono probabilità di mercato stimate, non verità; il metodo non corregge automaticamente il favorite-longshot bias.

`expectedValue(p,odds)` = p × quota − 1.

`quarterKelly(p,odds,bankroll)` = max(0, 0.25 × (p × quota − 1)/(quota − 1)); restituisce frazione, percentuale, puntata e frazione grezza. Equivale alla formula con b=quota−1 e q=1−p. La puntata non è arrotondata né modificata con cap nascosti.

`evaluateValue({modelProbability,odds,marketProbability,bankroll})` qualifica soltanto EV ≥0.03 (tolleranza numerica 1e-12); restituisce Kelly teorico e puntata proposta azzerata sotto soglia. Non accetta un modello assente. Kelly è condizionato alla correttezza di p, non è una percentuale sicura o validata del bankroll. Il calcolo riguarda una singola posizione; non sommare Kelly di giocate correlate. Quote nette di commissioni, regole di rimborso e limiti di esecuzione vanno gestiti nell'adattatore dati prima di chiamarlo.

## Esecuzione e integrazione dati

`node scripts/quant/run.mjs richiesta.json` legge un file JSON; stdout contiene `{ok,result}`, errori su stderr e exit code 1. Il file deve avere `operation`:

| operation | Altri campi richiesti |
|---|---|
| football | history, asOf, home, away |
| tennis | playerA, playerB, surface, asOf; format facoltativo |
| basketball | history, asOf, match; ridge e residuals facoltativi |
| value | input con modelProbability, odds, marketProbability, bankroll |

I contratti dei campi annidati sono descritti sopra. Un adattatore API può passare gli stessi oggetti alle funzioni esportate. Il modulo non scarica dati, non usa credenziali e non sostituisce campi mancanti con statistiche dimostrative. I dati sintetici esistono esclusivamente nei test e non vengono esportati alla pubblicazione.

Verifiche: `node --test tests/quant.test.mjs`; suite completa: `npm test`. Le prove confrontano Poisson con identità analitiche, il game Markov con una formula chiusa indipendente e il tie-break con un'enumerazione in avanti indipendente. Verificano anche simmetria del match, ordine del servizio, isolamento superficie/cutoff, EV/Kelly, definizioni Four Factors, regressione, pace e rifiuto del leakage.

## Fonti e scelte implementative

- Dixon e Coles (1997), Modelling Association Football Scores and Inefficiencies in the Football Betting Market: https://doi.org/10.1111/1467-9876.00065
- Regole ITF 2026, game, set, match e alternative: https://www.itftennis.com/media/7221/2026-rules-of-tennis-english.pdf
- Poropudas e Halme, Dean Oliver's Four Factors Revisited: https://arxiv.org/abs/2305.13032 . Il paper spiega che il rapporto tra Four Factors e rating è non lineare; la regressione ridge qui implementata è una baseline predittiva stimabile, non l'equazione esatta del paper né un modello attribuito a Oliver.
- Kelly (1956), A New Interpretation of Information Rate: https://doi.org/10.1002/j.1538-7305.1956.tb03809.x . Kelly frazionario al 25% è la scelta richiesta dall'utente.

La correzione xG, il pooling BP, la regressione ridge e la formula di pace sono scelte del motore esplicitate qui; non sono tutte prescritte dalle fonti. La validazione empirica e l'integrazione UI costituiscono il passaggio successivo.
