# Mail al superadmin

L'app manda le notifiche a uno script Google (Apps Script), che le gira per mail.
L'indirizzo dello script è in `script.js` (`MAIL_HOOK`); il codice da mettere nello script è `Notifiche.gs`.

Arriva una mail quando:

- un ospite **propone una canzone** (anche letta da foto o PDF);
- qualcuno **segnala un errore** in una canzone (anche senza rete: la mail parte quando torna la connessione);
- un admin (non il superadmin) **aggiunge una canzone**, **unisce un testo** a una canzone esistente o **approva una proposta**: la canzone va confermata dal superadmin.

Quello che fa il superadmin non gli arriva per mail. Il pulsante nella mail apre l'app sulle proposte o sulla canzone.

## Aggiornare lo script (una volta sola)

1. Vai su [script.google.com](https://script.google.com) con l'account del superadmin e apri il progetto delle notifiche del canzoniere.
2. Cancella il codice che c'è, incolla tutto `Notifiche.gs` e premi **Salva**.
3. In alto scegli la funzione **prova** e premi **Esegui**. La prima volta Google chiede l'autorizzazione a mandare mail: accetta. Deve arrivare una mail di prova.
4. **Esegui il deployment → Gestisci deployment →** icona della matita **→ Versione: Nuova versione → Esegui il deployment**.
   Così l'indirizzo resta lo stesso e l'app non va cambiata.

Le mail arrivano all'account che ha pubblicato lo script. Per mandarle a un altro indirizzo scrivilo in `DESTINATARIO` in cima al codice.
Al massimo 30 mail all'ora (contro lo spam); Google permette circa 100 mail al giorno a un account normale.
