/**
 * Canzoniere Scout — mail al superadmin.
 *
 * L'app manda qui (POST) proposte di canzoni, segnalazioni di errori e canzoni che un admin ha messo in conferma.
 * Lo script le gira per mail al superadmin.
 *
 * Come si aggiorna (vedi anche apps-script/LEGGIMI.md):
 *  1. script.google.com → apri il progetto delle notifiche del canzoniere → incolla tutto questo codice → Salva
 *  2. Esegui una volta la funzione "prova" (in alto: scegli "prova" → Esegui) e autorizza: arriva una mail di prova
 *  3. Esegui il deployment → Gestisci deployment → matita → Versione: "Nuova versione" → Esegui il deployment
 *     (così l'indirizzo resta lo stesso e l'app non va cambiata)
 */

// A chi arrivano le mail. Vuoto = all'account Google che ha pubblicato lo script.
const DESTINATARIO = "";
// Al massimo tante mail all'ora (se qualcuno scoprisse l'indirizzo e lo usasse per mandare spam)
const MAX_MAIL_ORA = 30;

const TIPI = {
  proposta:     { emoji: "🎵", oggetto: "Nuova proposta",            colore: "#0d6efd", bottone: "Apri le proposte" },
  segnalazione: { emoji: "🚩", oggetto: "Segnalazione",              colore: "#dc3545", bottone: "Apri la canzone" },
  revisione:    { emoji: "✅", oggetto: "Canzone da confermare",     colore: "#198754", bottone: "Apri la canzone" },
};

function doPost(e) {
  let d = {};
  try { d = JSON.parse((e && e.postData && e.postData.contents) || "{}"); } catch (err) { return risposta("dati non validi"); }
  if (!dentroIlLimite()) return risposta("troppe mail in questa ora");
  manda(d);
  return risposta("ok");
}

// Aprendo l'indirizzo nel browser: solo un controllo che lo script è pubblicato
function doGet() {
  return risposta("Notifiche del canzoniere attive");
}

// Da eseguire a mano dall'editor: manda una mail di prova (e fa chiedere l'autorizzazione la prima volta)
function prova() {
  manda({ tipo: "segnalazione", canzone: "Canzone di prova", autoreCanzone: "Autore", categoria: "Sezione",
          da: "Prova", dettagli: "Se leggi questa mail, le notifiche funzionano.", link: "", quando: "" });
}

function manda(d) {
  const tipo = TIPI[d.tipo] ? d.tipo : "proposta";
  const t = TIPI[tipo];
  // Messaggi dell'app di prima (solo titolo, autore = chi propone, categoria): li tratto come proposte
  const canzone = corto(d.canzone || d.titolo || "(senza titolo)", 150);
  const righe = [
    ["Canzone", canzone],
    ["Autore", corto(d.autoreCanzone, 150)],
    ["Sezione", corto(d.categoria, 100)],
    [tipo === "segnalazione" ? "Segnalata da" : tipo === "revisione" ? "Admin" : "Proposta da", corto(d.da || d.autore, 100)],
    [tipo === "segnalazione" ? "Problema" : "Dettagli", corto(d.dettagli, 1500)],
    ["Quando", corto(d.quando, 40)],
  ].filter(r => r[1]);
  const link = /^https:\/\//.test(String(d.link || "")) ? String(d.link) : "";

  const html =
    `<div style="font-family:Arial,sans-serif;max-width:560px">` +
    `<h2 style="color:${t.colore};margin:0 0 12px">${t.emoji} ${t.oggetto}</h2>` +
    `<table style="border-collapse:collapse">` +
    righe.map(r => `<tr><td style="padding:6px 10px 6px 0;color:#666;vertical-align:top;white-space:nowrap">${esc(r[0])}</td>` +
                   `<td style="padding:6px 0">${esc(r[1]).replace(/\n/g, "<br>")}</td></tr>`).join("") +
    `</table>` +
    (link ? `<p style="margin:18px 0"><a href="${esc(link)}" style="background:${t.colore};color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">${t.bottone}</a></p>` : "") +
    `<p style="color:#999;font-size:12px">Mail automatica del Canzoniere Scout.</p></div>`;
  const testo = righe.map(r => `${r[0]}: ${r[1]}`).join("\n") + (link ? `\n\n${t.bottone}: ${link}` : "");

  MailApp.sendEmail({
    to: DESTINATARIO || Session.getEffectiveUser().getEmail(),
    subject: `${t.emoji} ${t.oggetto}: ${canzone}`,
    body: testo,
    htmlBody: html,
    name: "Canzoniere Scout",
  });
}

function dentroIlLimite() {
  const cache = CacheService.getScriptCache();
  const chiave = "mail-" + Math.floor(Date.now() / 3600000);
  const n = Number(cache.get(chiave) || 0);
  if (n >= MAX_MAIL_ORA) return false;
  cache.put(chiave, String(n + 1), 3700);
  return true;
}

function corto(v, max) {
  const s = String(v == null ? "" : v).trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function risposta(msg) {
  return ContentService.createTextOutput(msg).setMimeType(ContentService.MimeType.TEXT);
}
