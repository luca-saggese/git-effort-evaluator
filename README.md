# Git Effort Evaluator

Tool CLI Node.js che analizza la cronologia Git di un repository e genera un report HTML con metriche di effort (ore uomo, giorni uomo, attività giornaliera, righe modificate).

## Requisiti

- Node.js (versione recente)
- Git
- Repository Git locale con cronologia disponibile

## Installazione

Dalla root del progetto:

```bash
npm run install
```

Lo script installa il comando `git-stats` in:

- `LOCAL_BIN` se impostata
- altrimenti `/opt/homebrew/bin` (se esiste)
- altrimenti `/usr/local/bin`

## Utilizzo

### 1) Esecuzione locale senza install globale

```bash
npm run git-stats
```

### 2) Esecuzione come comando installato

```bash
git-stats
```

Il comando va eseguito dentro un repository Git.

## Cosa produce

Il tool genera un file HTML in:

- `/tmp/git-stats-report.html`

e prova ad aprirlo automaticamente nel browser.

## Come funziona (algoritmo)

1. Legge tutti i commit in ordine cronologico (`git log --reverse`) con statistiche `--numstat`.
2. Per ogni commit calcola:
- file toccati
- righe aggiunte
- righe cancellate
3. Raggruppa i commit in segmenti di lavoro:
- se il gap tra due commit consecutivi supera `segmentGapMinutes` (default 60), parte un nuovo segmento
4. Stima la durata di ogni segmento:
- inizio = primo commit del segmento meno `warmupMinutes` (default 30)
- fine = ultimo commit del segmento
5. Converte la durata in:
- ore uomo
- giorni uomo (dividendo per `hoursPerManDay`, default 8)
6. Aggrega i dati per giorno e costruisce:
- card KPI
- grafico temporale
- tabella ore aggregate per giorno

## KPI nel report

Il report mostra queste card principali:

- Commit totali
- Primo commit (formato `gg/mm/yyyy`)
- Ultimo commit (formato `gg/mm/yyyy`)
- Giorni attivi
- File modificati
- Righe scritte
- Righe cancellate
- Ore uomo
- Giorni uomo
- Elapsed totale (giorni tra primo e ultimo commit)

## Configurazione

Attualmente la configurazione e hardcoded nello script:

- `segmentGapMinutes`: 60
- `warmupMinutes`: 30
- `hoursPerManDay`: 8
- `outputPath`: `/tmp/git-stats-report.html`
- `autoOpenReport`: `true`
- `gitLogMaxBufferBytes`: `50 * 1024 * 1024`

Per cambiarli, modifica l'oggetto `CONFIG` in `scripts/git-stats.js`.

## Note e limiti

- I file dentro `node_modules/` vengono ignorati nel conteggio righe/file.
- E una stima di effort basata sui timestamp dei commit, non un time tracker reale.
- Se non ci sono commit, il comando termina con errore.

## Sviluppo rapido

Rigenera il binario locale:

```bash
npm run build:bin
```

Esegui analisi:

```bash
npm run git-stats
```