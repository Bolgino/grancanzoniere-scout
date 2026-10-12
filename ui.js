// ui.js — notifiche e finestre di conferma nello stile dell'app,
// al posto di alert(), confirm() e prompt() del browser e dei toast di Bootstrap.

const ICONS = {
    success: "bi-check-circle-fill",
    danger: "bi-x-octagon-fill",
    warning: "bi-exclamation-triangle-fill",
    info: "bi-info-circle-fill",
};
const MAX_VISIBLE = 3;

function host() {
    let el = document.getElementById("appNotifications");
    if (!el) {
        el = document.createElement("div");
        el.id = "appNotifications";
        el.setAttribute("aria-live", "polite");
        document.body.appendChild(el);
    }
    return el;
}

// notify("Salvato", "success") — notifica che sparisce da sola.
// opzioni: { duration: ms (0 = resta finché non la chiudi), actions: [{ label, onClick, primary }] }
// Si chiude toccandola o trascinandola verso l'alto.
export function notify(message, type = "info", opts = {}) {
    if (!ICONS[type]) type = "info";
    const actions = opts.actions || [];
    const duration = opts.duration ?? (actions.length ? 8000 : (type === "danger" || type === "warning") ? 6000 : 3500);
    const box = host();

    while (box.children.length >= MAX_VISIBLE) box.firstElementChild.remove();

    const el = document.createElement("div");
    el.className = `app-note app-note-${type}`;
    el.setAttribute("role", type === "danger" ? "alert" : "status");
    el.innerHTML = `<i class="bi ${ICONS[type]} app-note-icon"></i><div class="app-note-body"><div class="app-note-text"></div></div>`
        + `<button class="app-note-close" aria-label="Chiudi"><i class="bi bi-x-lg"></i></button>`
        + (duration ? `<div class="app-note-timer" style="animation-duration:${duration}ms"></div>` : "");
    el.querySelector(".app-note-text").textContent = String(message ?? "");

    if (actions.length) {
        const row = document.createElement("div");
        row.className = "app-note-actions";
        actions.forEach(a => {
            const b = document.createElement("button");
            b.className = "app-note-action" + (a.primary === false ? "" : " primary");
            b.textContent = a.label;
            b.addEventListener("click", (e) => { e.stopPropagation(); close(); try { a.onClick && a.onClick(); } catch (err) { console.error(err); } });
            row.appendChild(b);
        });
        el.querySelector(".app-note-body").appendChild(row);
    }

    let timer = null, closed = false;
    function close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        el.classList.add("leaving");
        setTimeout(() => el.remove(), 220);
    }
    const arm = () => { if (duration) timer = setTimeout(close, duration); };

    // tocca per chiudere, trascina verso l'alto per buttarla via
    let startY = null;
    el.addEventListener("pointerdown", (e) => { if (e.target.closest(".app-note-action")) return; startY = e.clientY; el.classList.add("dragging"); });
    el.addEventListener("pointermove", (e) => { if (startY === null) return; const dy = Math.min(0, e.clientY - startY); el.style.transform = `translateY(${dy}px)`; el.style.opacity = String(1 + dy / 120); });
    const end = (e) => {
        if (startY === null) return;
        const dy = e.clientY - startY;
        startY = null;
        el.classList.remove("dragging");
        if (dy < -30 || Math.abs(dy) < 6) close();
        else { el.style.transform = ""; el.style.opacity = ""; }
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", () => { startY = null; el.classList.remove("dragging"); el.style.transform = ""; el.style.opacity = ""; });
    // in pausa mentre ci passi sopra col mouse
    el.addEventListener("mouseenter", () => { clearTimeout(timer); el.classList.add("paused"); });
    el.addEventListener("mouseleave", () => { el.classList.remove("paused"); arm(); });

    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add("shown"));
    arm();
    return { close };
}

// Finestra di conferma/inserimento nello stile dell'app. Restituisce una Promise.
//   appDialog({ title, message, okText, cancelText, danger, input: { value, placeholder } })
//   -> { ok: true/false, value }
export function appDialog({ title = "Conferma", message = "", okText = "Conferma", cancelText = "Annulla",
                            danger = false, icon = null, input = null } = {}) {
    return new Promise(resolve => {
        const previousFocus = document.activeElement;
        const overlay = document.createElement("div");
        overlay.className = "app-dialog-overlay";
        overlay.innerHTML = `
            <div class="app-dialog ${danger ? "danger" : ""}" role="dialog" aria-modal="true" aria-labelledby="appDialogTitle">
                <div class="app-dialog-head"><i class="bi ${icon || (danger ? "bi-exclamation-triangle-fill" : "bi-question-circle-fill")}"></i><h5 id="appDialogTitle"></h5></div>
                <p class="app-dialog-msg"></p>
                ${input ? `<input class="app-dialog-input" type="text" autocomplete="off">` : ""}
                <div class="app-dialog-buttons">
                    <button class="app-btn app-btn-ghost" data-act="cancel"></button>
                    <button class="app-btn ${danger ? "app-btn-danger" : "app-btn-primary"}" data-act="ok"></button>
                </div>
            </div>`;
        overlay.querySelector("h5").textContent = title;
        overlay.querySelector(".app-dialog-msg").textContent = message;
        overlay.querySelector('[data-act="cancel"]').textContent = cancelText;
        overlay.querySelector('[data-act="ok"]').textContent = okText;
        const field = overlay.querySelector(".app-dialog-input");
        if (field) { field.value = input.value || ""; field.placeholder = input.placeholder || ""; }

        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            document.removeEventListener("keydown", onKey, true);
            overlay.classList.remove("shown");
            setTimeout(() => overlay.remove(), 180);
            if (previousFocus && previousFocus.focus) try { previousFocus.focus(); } catch (e) {}
            resolve({ ok, value: field ? field.value.trim() : undefined });
        };
        const onKey = (e) => {
            if (e.key === "Escape") { e.preventDefault(); finish(false); }
            else if (e.key === "Enter" && (!field || document.activeElement === field)) { e.preventDefault(); finish(true); }
        };
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) return finish(false);
            const act = e.target.closest("[data-act]");
            if (act) finish(act.dataset.act === "ok");
        });
        document.addEventListener("keydown", onKey, true);
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add("shown"));
        setTimeout(() => (field || overlay.querySelector('[data-act="ok"]')).focus(), 30);
    });
}

export const appConfirm = (message, opts = {}) => appDialog({ message, ...opts }).then(r => r.ok);
export const appPrompt = (message, value = "", opts = {}) =>
    appDialog({ title: opts.title || "Inserisci", message, okText: opts.okText || "OK", icon: "bi-pencil-fill", input: { value, placeholder: opts.placeholder || "" } })
        .then(r => (r.ok && r.value ? r.value : null));
