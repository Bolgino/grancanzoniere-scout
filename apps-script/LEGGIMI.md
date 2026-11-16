# Mail al superadmin

L'app manda le notifiche a uno script Google (Apps Script), che le gira per mail.
L'indirizzo dello script è in `script.js` (`MAIL_HOOK`); il codice da mettere nello script è `Notifiche.gs`.

Arriva una mail quando:

- un ospite **propone una canzone** (anche letta da foto o PDF);
- qualcuno **segnala un errore** in una canzone (anche senza rete: la mail parte quando torna la connessione);
- un admin (non il superadmin) **aggiunge una canzone**, **unisce un testo** a una canzone esistente o **approva una proposta**: la canzone va confermata dal superadmin.

Quello che fa il superadmin non gli arriva per mail. Il pulsante nella mail apre l'app sulle proposte o sulla canzone.

## Lo script (progetto «Notifiche canzoniere» su script.google.com, account del superadmin)

Per crearlo da capo: **Nuovo progetto** → incolla `Notifiche.gs` → **Salva** → esegui la funzione **prova** e autorizza
(arriva una mail di prova) → **Esegui il deployment → Nuovo deployment →** ingranaggio → **App web**, Esegui come **Me**,
Chi ha accesso **Chiunque** → copia l'URL che finisce con `/exec` in `MAIL_HOOK` dentro `script.js`.

Per cambiare il codice senza cambiare indirizzo: incolla il codice nuovo → **Salva** →
**Esegui il deployment → Gestisci deployment →** matita **→ Versione: Nuova versione → Esegui il deployment**.

Controllo: aprendo l'indirizzo dello script in una finestra in incognito deve comparire «Notifiche del canzoniere attive».

Le mail arrivano all'account che ha pubblicato lo script. Per mandarle a un altro indirizzo scrivilo in `DESTINATARIO` in cima al codice.
Al massimo 30 mail all'ora (contro lo spam); Google permette circa 100 mail al giorno a un account normale.
