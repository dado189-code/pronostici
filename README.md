# Pronostici — dashboard che si aggiorna da sola

Pagina statica che mostra i pronostici e compone la schedina alla quota che scegli.
I dati vengono ricalcolati da GitHub Actions tre volte al giorno e pubblicati su Netlify.

## Come funziona

Il punto della pipeline e' che la stima delle probabilita **non guarda le quote**.
Un modello alimentato da un feed commerciale finisce per confrontare la lavagna
con se stessa, perche' gli stessi fornitori alimentano entrambe le cose.
Qui le due gambe sono separate.

**Gamba 1, il modello (`scripts/model.mjs`)**
1. Scarica da Understat gli expected goals di ogni partita giocata.
2. Stima per ogni squadra una forza di attacco e una di difesa, con punto fisso
   della massima verosimiglianza Poisson. Ogni partita pesa meno mano a mano che
   invecchia: emivita 180 giorni.
3. Stima il vantaggio del campo come parametro unico di lega.
4. Applica la correzione Dixon-Coles, che alza la frequenza di 0-0, 1-0, 0-1 e 1-1
   rispetto a quanto direbbe Poisson puro.
5. Da lambda casa e lambda trasferta costruisce la matrice dei punteggi e ne ricava
   ogni mercato: 1X2, doppie chance, multigol totale, multigol casa e trasferta,
   gol squadra, gol/nogol, under e over.

**Gamba 2, il mercato (`scripts/build.mjs`)**
6. Scarica le quote di piu bookmaker da the-odds-api.
7. Normalizza le quote di ogni singolo book a somma 1 per togliere il margine, poi
   fa la media: e' la probabilita che il mercato sta prezzando.
8. Confronta la probabilita del modello col miglior prezzo disponibile. Se il
   prodotto supera 1, quella giocata ha valore atteso positivo.
9. Segna come **sorpresa** gli esiti dove il modello e' almeno il 12% sopra il
   mercato e la probabilita resta sotto il 42%.

### Verifica del modello
Il fitter e' stato provato su un campionato simulato con forze note: recupera gli
attacchi con correlazione 0,99, le difese con 0,99, e il vantaggio del campo entro
il 4%. Se lo modifichi, ripeti quella prova prima di fidarti dei numeri.

### Nomi delle squadre
Understat e i bookmaker scrivono i nomi in modo diverso. `chiave()` normalizza e
usa una tabella di alias; gli eventi che restano non abbinati finiscono nel campo
`diagnostica` di `picks.json` invece di sparire in silenzio. Controllalo dopo ogni
inizio di stagione, quando cambiano le neopromosse.

## Setup, una volta sola

1. Crea un account gratuito su https://the-odds-api.com e copia la API key.
2. Su GitHub: Settings del repository, Secrets and variables, Actions, New repository secret.
   Nome `ODDS_API_KEY`, valore la chiave.
3. Su Netlify: Add new site, Import an existing project, collega questo repository.
   Build command vuoto, publish directory `.`
4. Lancia il primo aggiornamento a mano: tab Actions, workflow "Aggiorna pronostici", Run workflow.

Da qui in poi non serve piu toccare niente. Ogni volta che le Actions scrivono `data/picks.json`,
Netlify ripubblica il sito da solo e il tuo segnalibro mostra i dati nuovi.

## Consumo del piano gratuito

Il piano gratuito di the-odds-api da 500 richieste al mese. Lo script fa una richiesta per campionato,
9 campionati per esecuzione, 3 esecuzioni al giorno: circa 810 al mese, quindi va ridotto.
Due modi: togli campionati da `SPORTS` in `scripts/build.mjs`, oppure porta il cron a due esecuzioni al giorno
cambiando `0 6,12,18 * * *` in `0 7,17 * * *`.

## Limiti da conoscere

Il modello non sa chi gioca. Non conosce formazioni, infortuni, squalifiche, meteo
o motivazioni di classifica: stima la forza media recente di una rosa, non quella
della squadra che scendera' in campo. Quella lettura resta un'aggiunta manuale.

A inizio stagione le stime sono deboli, perche' pesano quasi solo partite vecchie
e le neopromosse non hanno storico nella lega. Le prime tre o quattro giornate
vanno prese con prudenza.

Il modello arriva sempre dopo il mercato, mai prima. I professionisti misurano il
proprio risultato sul closing line value, cioe' se hanno preso una quota migliore
di quella finale: se vuoi capire davvero se il metodo funziona, registra la quota
presa e quella di chiusura, non solo vinto o perso.
