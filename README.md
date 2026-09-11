# Prono

App statica HTML/CSS/JS con pipeline Node.js 24, JSON versionati e GitHub Pages. Nessun database o servizio backend a pagamento.

URL: https://dado189-code.github.io/pronostici/

## Uso e limiti

Tre sezioni: **Singola prudente**, **Combinata** (2–3 partite diverse, stesso bookmaker), **Ad alta quota**. Sono considerate soltanto partite ancora da iniziare nella giornata Europe/Rome; il browser applica anche il fuso scelto dall'utente e nasconde eventi già iniziati e snapshot di giorni precedenti. Se nessuna selezione supera tutti i filtri, la sezione lo dichiara. I fusi alternativi filtrano lo snapshot italiano, non aggiungono eventi assenti dalla raccolta giornaliera.

Mercato supportato con confronto verificabile: 1X2. Non vengono mostrate quote inventate per multigol, doppie chance o altri mercati non scaricati. Le probabilità del modello e del mercato sono affiancate. Quote decimali osservate presso bookmaker distinti, mercati completi a tre esiti, massimo 6 ore di età. Consenso con normalizzazione proporzionale del margine per ciascun book, poi media.

La confidence (0–100) **non è una probabilità di vincita**. Dipende da campione minimo delle due squadre, partite stagionali, età dello storico e delle quote, disaccordo. Un gap ≥10 punti percentuali non è classificabile VALORE. Il contributo EV al ranking satura al 25%. Le soglie stanno in `scripts/engine.mjs` e non sono parametri calibrati sulla redditività storica.

## Modello e verifica statistica

Si riusa il fitter xG del progetto: Poisson con forze di attacco/difesa e vantaggio campo, decadimento esponenziale con emivita 180 giorni, correzione Dixon–Coles dei quattro punteggi bassi. È una distribuzione Poisson con correzione locale; non è il generico modello Poisson bivariato a componente latente condivisa. Gli xG continui sono usati come obiettivo di pseudo-verosimiglianza Poisson. Rho è stimato sui risultati osservati delle ultime 300 partite. Le quote non sono input del modello.

Storico Understat 2022/23–2025/26 versionato, più aggiornamenti delle stagioni recenti: nessun reset stagionale. Previsioni pubblicate con fit a mezzanotte UTC della giornata, escludendo tutte le partite simultanee o successive. Le matrici non valide e i tassi estremi fanno astenere il motore, non vengono corretti silenziosamente.

`npm run backtest` ricostruisce ogni previsione con refit giornaliero su dati precedenti: warm-up 2022/23, train 2023/24, validation 2024/25 e test 2025/26. Brier multicategoria non diviso per 3; log loss naturale; RPS normalizzato per 2, ordine 1-X-2. Bootstrap appaiato per blocchi di settimana, 3.000 repliche con seed fisso. Il closing storico di confronto è Pinnacle da football-data.co.uk, **non** un consenso storico di tre bookmaker.

**Limite non risolvibile retroattivamente:** il repository preesistente ha già esplorato il 2025/26 per calibrazione e selezione delle varianti. Quella stagione non può essere dichiarata un nuovo holdout incontaminato. Le metriche ricalcolate sono descrittive out-of-sample temporali, non evidenza confermativa nuova. Inoltre gli xG sono snapshot retrospettivi: non conosciamo tutte le revisioni e i timestamp originali di pubblicazione. Nessuna feature, calibrazione o ensemble viene promossa; il draw-cal sperimentale del vecchio progetto non viene importato dalla produzione. Prima di un futuro miglioramento occorre congelare ipotesi, candidato e metrica, riservare risultati futuri mai esaminati e richiedere un bootstrap significativo sul test finale. Riutilizzare ripetutamente il test per selezionare modelli lo trasforma in validation.

I file precedenti di ricerca e l'interfaccia `index-legacy.html` sono conservati per audit, ma non inclusi nel sito pubblicato.

## Pipeline giornaliera

`.github/workflows/aggiorna.yml` sostituisce il vecchio workflow. Trigger UTC orari dalle 12:07 alle 21:07, gate con `Intl` su Europe/Rome dalle 14:07, marker giornaliero e concurrency globale. I trigger successivi servono solo per recuperare ritardi/errori: dopo il successo non riscaricano dati. GitHub può ritardare o saltare i trigger e disabilitare workflow di repository pubblici inattivi: non è un servizio con SLA orario. La configurazione timezone è nel motore; per cambiarla occorre allineare anche le ore UTC di recupero del workflow.

1. Esegue tutta la suite: test legacy e nuove regressioni.
2. Scarica tutte le fonti obbligatorie. Qualsiasi errore di rete/schema arresta la pubblicazione. Una squadra non riconosciuta o quote insufficienti producono un'astensione diagnostica.
3. Prepara in locale snapshot completo e registro; verifica formule, date, selezioni e rendimento.
4. Versiona i JSON completi in un unico commit e pubblica un unico artifact Pages. Un build fallito lascia online la versione precedente.
5. Verifica SHA-256 dei dati e dei tre asset dal sito pubblico. Solo allora scrive il marker di successo e invia Telegram, verificando `ok` nella risposta API.
6. In caso di errore, tenta una notifica di fallimento e lascia il workflow rosso. La consegna Telegram via API non prova la lettura da parte del destinatario.

Se un deploy fallisce dopo il commit, il retry riusa lo stesso snapshot, senza doppio calcolo. Un push del codice può ripubblicare lo snapshot esistente; non crea nuove osservazioni nello stesso giorno. I segreti `ODDS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` sono già configurati nel repository e vengono letti solo in Actions.

Le chiamate quote sono precedute dalla scoperta gratuita degli eventi. Le chiamate risultati vengono fatte solo per competizioni con pendenti. Il consumo effettivo dipende dal calendario e dal piano API: l'esaurimento dei crediti genera un errore, non dati fittizi. Non è garantito che ogni calendario rientri nel piano gratuito.

## Registro

`data/ledger.json` conserva ogni esito, quota e categoria originali. Un risultato chiude una riga solo se coincidono ID provider, kickoff UTC e nomi delle due squadre; una riga chiusa non viene modificata. La finestra API risultati di tre giorni può lasciare pendenti dopo outage prolungati o cambi di kickoff: sono segnalati e richiedono riconciliazione verificata, mai liquidazione per somiglianza di nomi. Gli esiti dello stesso match sono correlati e il saldo di tutti gli esiti non è la strategia delle tre sezioni.

`data/storico.json` precedente resta immutato; è escluso dal rendimento nuovo perché parte delle identità non è ricostruibile. Il saldo a migliori quote osservate è una simulazione ottimistica, non un guadagno reale né un limite superiore matematico. Il saldo a quote eque è mostrato separatamente e non rappresenta quote eseguibili.

## Comandi

```sh
npm test
npm run backtest
# Con ODDS_API_KEY nell'ambiente:
npm run build
npm run verify
```

Il report lega il backtest al contenuto del motore mediante hash (fine riga normalizzato). Cambiare il motore richiede rigenerare il report. Nessuna dipendenza npm necessaria.
