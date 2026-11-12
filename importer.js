// importer.js — legge una canzone da una foto o da un PDF e la scrive nel formato del canzoniere:
// gli accordi stampati sopra il testo diventano [Accordo] dentro la riga, sulla lettera che avevano sotto.
//
//  - PDF con il testo (scaricati da internet, fatti al computer): si leggono parole e posizioni (pdf.js)
//  - foto, scansioni e PDF senza testo: riconoscimento del testo (Tesseract, italiano) con le posizioni
//
// Le due librerie si scaricano solo la prima volta che si usa la funzione (da cdnjs / jsdelivr).
// La parte che ricostruisce righe, accordi e strofe (layoutToSong) è "pura": si prova senza browser.

import { parseChordLine, syllables } from "./song-doctor.js";

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const MAX_PAGES = 6;

// ---------------------------------------------------------------------------------------------------
// 1. RICOSTRUZIONE: parole con la loro posizione -> testo con [accordi]
//    pages = [{ words: [{ text, x0, y0, x1, y1, chars?: [{ x0, x1 }] }] }]   (y cresce verso il basso)
// ---------------------------------------------------------------------------------------------------

const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Errori tipici del riconoscimento negli accordi: 5ol / S0l / So1 / So! -> Sol, Lam. -> Lam, Cc -> C, (Re) resta (Re)
// (senza "lookbehind" nelle espressioni: i vecchi iPhone non le conoscono)
function ocrChordText(token) {
    let t = String(token).replace(/[.,;:'’"]+$/, "");
    if (/^\(.*\)$/.test(t)) return t;
    t = t.replace(/^[([{]+/, "").replace(/[)\]}]+$/, "");
    return t.replace(/^5(?=[o0][l1!|])/, "S")
        .replace(/^([A-Z][a-z]?)0/, "$1o")
        .replace(/([A-Za-z])[1!|](?!\d)/g, "$1l")
        .replace(/^([A-G])([a-g])$/, (m, a, b) => a.toLowerCase() === b ? a : m);
}

// Larghezza delle lettere (Helvetica, millesimi di em): serve a stimare dove sta ogni lettera dentro una parola
// (le posizioni delle singole lettere date dal riconoscimento del testo sono troppo imprecise)
const CHAR_W = {};
("a556 b556 c500 d556 e556 f278 g556 h556 i222 j222 k500 l222 m833 n556 o556 p556 q556 r333 s500 t278 u556 v500 w722 x500 y500 z500 " +
 "A667 B667 C722 D722 E667 F611 G778 H722 I278 J500 K667 L556 M833 N722 O778 P667 Q778 R722 S667 T611 U722 V667 W944 X667 Y667 Z611 " +
 "'191 ’222 ,278 .278 :278 ;278 !278 ?556 -333 (333 )333 \"355").split(" ").forEach(s => { CHAR_W[s[0]] = +s.slice(1); });
const charWidth = (c) => CHAR_W[c] || CHAR_W[c.normalize("NFD")[0]] || 556;
const textWidth = (s) => [...s].reduce((a, c) => a + charWidth(c), 0);

// Bordi delle lettere di una parola tra x0 e x1: proporzionali (Helvetica) o tutte uguali (caratteri monospazio)
function wordEdges(text, x0, x1, mono) {
    const n = text.length;
    if (mono || !n) return Array.from({ length: n + 1 }, (_, k) => x0 + (x1 - x0) * k / Math.max(1, n));
    const tot = textWidth(text);
    let acc = 0;
    const e = [x0];
    for (const c of text) { acc += charWidth(c); e.push(x0 + (x1 - x0) * acc / tot); }
    return e;
}

// Pagina scritta a macchina (tutte le lettere larghe uguali)? Lo si vede da quanto variano le larghezze delle parole.
function isMonospace(words) {
    const ws = words.filter(w => w.text.length >= 4 && /^[A-Za-zÀ-ÿ']+$/.test(w.text));
    if (ws.length < 6) return false;
    const cv = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) / m; };
    return cv(ws.map(w => (w.x1 - w.x0) / w.text.length)) < 0.75 * cv(ws.map(w => (w.x1 - w.x0) / textWidth(w.text)));
}
const LABEL = /^(intro|strum|strumentale|rit|ritornello|coro|strofa|bridge|finale|fine|solo|coda|special|chorus|verse)\b/i;

// Righe di stampa: parole raggruppate per altezza, da sinistra a destra.
// Se il riconoscimento dice già quali parole stanno sulla stessa riga (w.line), si parte da lì (regge le foto storte).
function groupLines(words) {
    const ws = words.filter(w => String(w.text || "").trim()).map(w => ({ ...w, text: String(w.text).trim(), h: w.y1 - w.y0 }));
    const h = median(ws.map(w => w.h)) || 10;
    const seeds = new Map();
    ws.forEach((w, i) => {
        const k = w.line != null ? "L" + w.line : "W" + i;
        if (!seeds.has(k)) seeds.set(k, []);
        seeds.get(k).push(w);
    });
    const box = (ws2) => ({ words: ws2, y0: Math.min(...ws2.map(w => w.y0)), y1: Math.max(...ws2.map(w => w.y1)) });
    const groups = [...seeds.values()].map(box).sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const lines = [];
    groups.forEach(g => {
        const gh = g.y1 - g.y0;
        const line = lines.find(l => {
            const ov = Math.min(l.y1, g.y1) - Math.max(l.y0, g.y0);
            return ov >= 0.5 * Math.min(l.y1 - l.y0, gh);
        });
        if (line) { line.words.push(...g.words); line.y0 = Math.min(line.y0, g.y0); line.y1 = Math.max(line.y1, g.y1); }
        else lines.push(g);
    });
    lines.forEach(l => {
        l.words.sort((a, b) => a.x0 - b.x0);
        // centro della riga: mediana dei centri delle parole (il riconoscimento a volte dà riquadri troppo alti)
        l.cy = median(l.words.map(w => (w.y0 + w.y1) / 2));
        l.hText = median(l.words.map(w => w.h));
    });
    return { lines: lines.sort((a, b) => a.cy - b.cy), h };
}

// Una riga di soli accordi (con eventuali "Intro:", "|", "x2")? Stesse regole della bacchetta (parseChordLine).
function asChordRow(line, h) {
    const tryParse = (toks) => { const p = parseChordLine(toks.join(" ")); return p && p.tokens.length === toks.length ? p : null; };
    let fixed = line.words.map(w => ocrChordText(w.text) || w.text);
    let parsed = tryParse(fixed);
    if (!parsed) {
        // "sol", "soL", "sSoL", "Soi" letti male (succede con il grassetto o le maiuscole piccole). Si accettano se
        // sulla riga c'è già un accordo scritto giusto, oppure se la parola ha maiuscole e minuscole mescolate
        // (cosa che nel testo non succede).
        const weird = (t) => /[a-z]/.test(t) && /[A-Z]/.test(t.slice(1));
        const cap = fixed.map(t => {
            const m = t.replace(/^[a-z](?=[A-Z])/, "").match(/^(do|re|mi|fa|so[l1i!|]|la|si)(.*)$/i);
            if (!m) return t;
            const root = m[1].toLowerCase().replace(/^so./, "sol");
            return root[0].toUpperCase() + root.slice(1) + m[2];
        });
        // "po" da solo su una riga: è "DO" letto male
        if (cap.length === 1 && /^[pP][oO0]$/.test(cap[0])) cap[0] = "Do";
        const p2 = tryParse(cap);
        const validBefore = (t) => { const p = tryParse([t]); return !!p && p.tokens[0].kind === "chord"; };
        if (p2 && cap.some((t, i) => p2.tokens[i].kind === "chord" && (validBefore(fixed[i]) || weird(fixed[i]) || cap.length === 1 && /^[pP][oO0]$/.test(fixed[i])))) { parsed = p2; fixed = cap; }
    }
    if (!parsed) return null;
    const out = line.words.map((w, i) => parsed.tokens[i].kind === "chord" ? { ...w, chord: fixed[i] } : { ...w, deco: true });
    // "Do Re Mi Fa" scritti vicini come parole normali: è testo cantato, non accordi
    const chords = out.filter(w => w.chord);
    if (chords.length >= 3 && chords.every(w => /^(Do|Re|Mi|Fa|Sol|La|Si)$/i.test(w.chord))) {
        const gaps = line.words.slice(1).map((w, i) => w.x0 - line.words[i].x1);
        if (median(gaps) < 0.6 * h) return null;
    }
    return out;
}

// Posizione (x) di ogni lettera della riga di testo, unendo le parole con uno spazio
function lyricLayout(line, mono) {
    let text = "";
    const xs = [];   // x sinistra di ogni carattere (gli spazi prendono la fine della parola prima)
    line.words.forEach((w, wi) => {
        if (wi) { text += " "; xs.push(line.words[wi - 1].x1); }
        const n = w.text.length;
        const edges = w.chars && w.chars.length === n ? null : wordEdges(w.text, w.x0, w.x1, mono);
        for (let k = 0; k < n; k++) xs.push(edges ? edges[k] : w.chars[k].x0);
        text += w.text;
    });
    const charW = line.words.reduce((a, w) => a + (w.x1 - w.x0), 0) / Math.max(1, line.words.reduce((a, w) => a + w.text.length, 0));
    return { text, xs, charW, x1: line.words[line.words.length - 1].x1 };
}

// Accordi della riga sopra messi dentro la riga di testo. Ogni accordo va all'inizio della sillaba più vicina al
// suo bordo sinistro (misurato in pixel): sui fogli fatti con gli spazi gli accordi sono allineati "a occhio",
// un po' prima o un po' dopo la sillaba giusta.
function mergeRow(row, lyric, mono) {
    const { text, xs, charW, x1 } = lyricLayout(lyric, mono);
    const starts = syllables(text).map(x => x.start);
    const inserts = [];
    let tail = "";
    row.forEach(w => {
        if (!w.chord) return;
        const ref = w.x0 + 0.2 * charW;
        if (ref >= x1 + 0.5 * charW) { tail += ` [${w.chord}]`; return; }   // dopo la fine del testo
        let at = -1, bd = Infinity;
        starts.forEach(st => { const d = Math.abs(xs[st] - ref); if (d < bd) { bd = d; at = st; } });
        if (at < 0 || bd > 2.5 * charW) {        // nessuna sillaba vicina: la lettera sotto
            if (ref > x1 - charW) { tail += ` [${w.chord}]`; return; }   // sopra l'ultima lettera o oltre
            at = 0;
            while (at + 1 < xs.length && xs[at + 1] <= ref) at++;
            if (text[at] === " ") at++;
        }
        // virgolette o parentesi attaccate alla parola: l'accordo va prima ("[Fa]“dai" e non "“[Fa]dai")
        while (at > 0 && /[“"'«(‘]/.test(text[at - 1]) && (at === 1 || text[at - 2] === " ")) at--;
        inserts.push({ at, text: `[${w.chord}]` });
    });
    let out = text;
    inserts.map((x, k) => ({ ...x, k })).sort((a, b) => b.at - a.at || b.k - a.k).forEach(x => { out = out.slice(0, x.at) + x.text + out.slice(x.at); });
    return out + tail;
}

// Riga di accordi senza testo sotto (intro, parti strumentali): accordi distanziati come sulla pagina
function standaloneRow(row, charW) {
    let out = "", col = 0;
    const x0 = row[0].x0;
    row.forEach(w => {
        const want = Math.round((w.x0 - x0) / Math.max(1, charW));
        if (out) out += " ".repeat(Math.max(1, want - col));
        out += w.chord ? `[${w.chord}]` : w.text;
        col = Math.max(want, col) + (w.chord ? 0 : w.text.length) + 1;
    });
    return out;
}

// Pagina su due (o tre) colonne: c'è una striscia verticale senza parole che va da cima a fondo, con parecchio
// testo da entrambe le parti. Le colonne si leggono una dopo l'altra, da sinistra a destra.
export function splitColumns(words) {
    const ws = words.filter(w => String(w.text || "").trim());
    if (ws.length < 12) return [ws];
    const h = median(ws.map(w => w.y1 - w.y0)) || 10;
    const x0 = Math.min(...ws.map(w => w.x0)), x1 = Math.max(...ws.map(w => w.x1));
    const bw = Math.max(1, h / 2), nb = Math.ceil((x1 - x0) / bw) + 1;
    const cov = new Uint16Array(nb);
    ws.forEach(w => { for (let b = Math.floor((w.x0 - x0) / bw); b <= Math.floor((w.x1 - x0) / bw); b++) cov[b]++; });
    const thr = Math.max(1, Math.floor(ws.length * 0.01));
    let best = null;
    for (let b = 0; b < nb;) {
        if (cov[b] > thr) { b++; continue; }
        let e = b;
        while (e + 1 < nb && cov[e + 1] <= thr) e++;
        const gx0 = x0 + b * bw, gx1 = x0 + (e + 1) * bw;
        const mid = (gx0 + gx1) / 2;
        const left = ws.filter(w => (w.x0 + w.x1) / 2 < mid), right = ws.filter(w => (w.x0 + w.x1) / 2 >= mid);
        if (b > 0 && e < nb - 1 && gx1 - gx0 >= 2 * h && left.length >= 0.2 * ws.length && right.length >= 0.2 * ws.length
            && (!best || gx1 - gx0 > best.w)) best = { w: gx1 - gx0, left, right };
        b = e + 1;
    }
    if (!best) return [ws];
    return [...splitColumns(best.left), ...splitColumns(best.right)];
}

// Righe da buttare: indirizzi web, righe di soli trattini; numeri di pagina solo in cima o in fondo alla pagina
const JUNK = [/(www\.|https?:|\.com\b|\.it\b|\.org\b|\.net\b)/i, /^[\s\-–—_=.·•*~|'"‘’“”]+$/,
    // scritta che alcuni telefoni stampano sulla foto (modello e data/ora)
    /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b.*\b\d{1,2}[:.]\d{2}\b/, /\b(redmi|xiaomi|samsung|galaxy|iphone|huawei|oppo|honor|realme|poco|oneplus|shot on|scattata con)\b/i];
const PAGE_NUM = /^\s*(pag(ina)?\.?\s*)?\d{1,3}(\s*(\/|di)\s*\d{1,3})?\s*$/i;

export function layoutToSong(pages) {
    const out = [];
    let title = "", lines = 0, merged = 0, chordCount = 0;
    const parts = [];
    pages.forEach(page => splitColumns(page.words || []).forEach(words => parts.push({ words, mono: page.mono })));
    let carry = null;
    parts.forEach((page, pi) => {
        const { lines: pl, h } = groupLines(page.words || []);
        const units = pl.filter((l, i) => {
            const s = l.words.map(w => w.text).join(" ");
            if (JUNK.some(re => re.test(s))) return false;
            if (s.replace(/[^A-Za-zÀ-ÿ0-9]/g, "").length < 2 && !asChordRow(l, 10)) return false;
            // una sola parola letta con poca sicurezza (pezzo di un altro foglio, piega): via
            if (l.words.length === 1 && (l.words[0].conf ?? 100) < 50 && !asChordRow(l, 10)) return false;
            return !((i === 0 || i === pl.length - 1) && PAGE_NUM.test(s));
        });
        if (!units.length) return;
        // titolo: prima riga della prima pagina scritta più grande
        const bodyH = median(units.map(l => l.hText)) || h;
        const caps = (l) => { const t = l.words.map(w => w.text).join(" "), let_ = t.replace(/[^A-Za-zÀ-ÿ]/g, ""); return let_.length >= 6 && let_ === let_.toUpperCase() && l.words.length <= 10; };
        const isTitle = (l) => l && (l.hText >= 1.25 * bodyH || caps(l)) && !asChordRow(l, h);
        if (pi === 0 && !title && units.length > 2) {
            // sopra il titolo di una foto ci può essere un segno letto per sbaglio (bordo del foglio)
            if (!isTitle(units[0]) && isTitle(units[1]) && units[0].words.map(w => w.text).join("").length <= 3) units.shift();
            if (isTitle(units[0])) title = units.shift().words.map(w => w.text).join(" ");
        } else if (pi > 0 && title && isTitle(units[0])) {
            // seconda pagina (o seconda foto) con lo stesso titolo in cima: non lo ripeto nel testo
            const norm = (x) => x.toLowerCase().replace(/[^a-zà-ÿ0-9]/g, "");
            if (norm(units[0].words.map(w => w.text).join(" ")) === norm(title)) units.shift();
        }
        if (!units.length) return;
        const lyricUnits = units.filter(l => !asChordRow(l, h));
        const mono = page.mono ?? isMonospace(lyricUnits.flatMap(l => l.words));
        const charW = median(lyricUnits.map(l => lyricLayout(l, mono).charW)) || h * 0.5;
        const left = Math.min(...lyricUnits.map(l => l.words[0].x0), Infinity);
        // passo solito tra due righe stampate, da centro a centro (alcuni fogli lasciano una riga vuota anche tra
        // accordi e testo): una riga di accordi va con il testo sotto se non è più lontano del solito
        const usualPitch = median(units.slice(1).map((l, i) => l.cy - units[i].cy).filter(g => g > 0)) || 2 * h;
        const closeEnough = (a, b) => b.cy - a.cy <= Math.max(1.8 * h, 1.35 * usualPitch);
        // righe della canzone: una riga di accordi si unisce al testo subito sotto
        const blocks = [];
        let start = 0;
        // riga di accordi rimasta in fondo alla colonna (o pagina) prima: va sulla prima riga di questa
        if (carry && units[0] && !asChordRow(units[0], h)) {
            const k = charW / carry.charW;
            const row = carry.row.map(w => ({ ...w, x0: left + (w.x0 - carry.left) * k, x1: left + (w.x1 - carry.left) * k }));
            blocks.push({ text: mergeRow(row, units[0], mono), top: units[0].cy, bottom: units[0].cy });
            merged++; lines++; start = 1;
        } else if (carry) out.push(carry.text);
        carry = null;
        for (let i = start; i < units.length; i++) {
            const l = units[i];
            const row = asChordRow(l, h);
            if (!row) { blocks.push({ text: l.words.map(w => w.text).join(" "), top: l.cy, bottom: l.cy }); lines++; continue; }
            chordCount += row.filter(w => w.chord).length;
            const next = units[i + 1];
            const hasLabel = row.some(w => w.deco && LABEL.test(w.text));
            if (next && !hasLabel && !asChordRow(next, h) && closeEnough(l, next)
                && row.some(w => w.chord && w.x0 < next.words[next.words.length - 1].x1 + charW)) {
                blocks.push({ text: mergeRow(row, next, mono), top: l.cy, bottom: next.cy });
                merged++; lines++; i++;
            } else if (!next && !hasLabel && pi < parts.length - 1) {
                carry = { row, left, charW, text: standaloneRow(row, charW) };   // continua nella colonna dopo
            } else blocks.push({ text: standaloneRow(row, charW), top: l.cy, bottom: l.cy });
        }
        // righe vuote tra le strofe: dove la distanza tra due righe della canzone è molto più grande del solito
        const gaps = blocks.slice(1).map((b, i) => b.top - blocks[i].bottom);
        const usual = median(gaps.filter(g => g > 0)) || 2 * h;
        if (pi > 0 && out.length && out[out.length - 1] !== "") out.push("");
        blocks.forEach((b, i) => {
            if (i > 0 && gaps[i - 1] > Math.max(1.8 * h, 1.5 * usual) && out.length && out[out.length - 1] !== "") out.push("");
            out.push(b.text);
        });
    });
    if (carry) out.push(carry.text);
    while (out.length && out[out.length - 1] === "") out.pop();
    let text = out.join("\n");
    // foglio con gli accordi all'italiana: una "A" isolata è "LA" letto senza la L
    const all = [...text.matchAll(/\[([^\]]+)\]/g)].map(m => m[1]);
    const ita = all.filter(c => /^(do|re|mi|fa|sol|la|si)/i.test(c)).length;
    if (ita >= 6 && all.length - ita <= ita / 6) text = text.replace(/\[A(-|m|7|-7|m7)?\]/g, (m, suf) => `[La${suf || ""}]`);
    // il "-" dei minori è piccolo e a volte non si legge: se nella canzone "LA-" c'è spesso e "LA" quasi mai,
    // anche quei pochi "LA" sono "LA-" (lo stesso accordo maggiore e minore nella stessa canzone è raro)
    ["Do", "Re", "Mi", "Fa", "Sol", "La", "Si"].forEach(root => {
        const minor = new RegExp(`\\[${root}-\\]`, "gi"), bare = new RegExp(`\\[(${root})\\]`, "gi");
        const nm = (text.match(minor) || []).length, nb = (text.match(bare) || []).length;
        if (nm >= 3 && nb && nb <= nm / 2) text = text.replace(bare, "[$1-]");
    });
    return { title, text, lines, merged, chords: chordCount };
}

// ---------------------------------------------------------------------------------------------------
// 2. PDF (pdf.js): pezzi di testo con posizione -> parole
// ---------------------------------------------------------------------------------------------------

// Bordi di ogni lettera dentro un pezzo di testo del PDF. Il carattere vero del PDF (pdf.js lo carica nel browser
// quando disegna la pagina, con il nome fontName) dà le misure esatte; senza, si stima con la tabella.
let measureCtx = null;
function charEdges(str, fontName, fallback, width) {
    const n = str.length;
    const est = () => wordEdges(str, 0, width, fallback === "monospace");
    try {
        if (typeof document === "undefined") return est();
        measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
        measureCtx.font = `100px "${fontName}", ${fallback || "sans-serif"}`;
        const full = measureCtx.measureText(str).width;
        if (!full) return est();
        return Array.from({ length: n + 1 }, (_, k) => width * measureCtx.measureText(str.slice(0, k)).width / full);
    } catch (e) { return est(); }
}

export function itemsToWords(items, pageHeight, styles = {}) {
    const words = [];
    items.forEach(it => {
        const str = it.str || "";
        if (!str.trim() || !it.transform) return;
        const [a, b, c, d, e, f] = it.transform;
        const size = Math.hypot(c, d) || it.height || Math.hypot(a, b) || 10;
        const width = it.width || size * 0.5 * str.length;
        const edges = charEdges(str, it.fontName, styles[it.fontName] && styles[it.fontName].fontFamily, width);
        const top = pageHeight - f - size * 0.8, bottom = pageHeight - f + size * 0.2;
        const re = /\S+/g;
        let m;
        while ((m = re.exec(str)) !== null) {
            const s = m.index, t = s + m[0].length;
            const chars = [];
            for (let k = s; k < t; k++) chars.push({ x0: e + edges[k], x1: e + edges[k + 1] });
            words.push({ text: m[0], x0: e + edges[s], x1: e + edges[t], y0: top, y1: bottom, chars });
        }
    });
    return words;
}

// ---------------------------------------------------------------------------------------------------
// 3. Riconoscimento del testo (Tesseract): parole e lettere con la loro posizione
// ---------------------------------------------------------------------------------------------------

export function ocrToWords(data) {
    const words = [];
    let lineNo = 0;
    // le posizioni delle singole lettere non si usano: sono imprecise, si stimano dalla larghezza della parola
    const push = (w, line) => {
        const bb = w.bbox || {};
        let text = String(w.text || "").trim();
        const conf = w.confidence != null ? w.confidence : 100;
        if (!text || conf < 30) return;                                                  // macchie e bordi letti come segni
        // segni piccoli poco sicuri (bordo del foglio, piega, puntini): "|", "i", "4,"
        if (conf < 65 && text.replace(/[^A-Za-zÀ-ÿ0-9]/g, "").length <= 1 && !/^[A-G]$/.test(text)) return;
        if (text === "ll") text = "Il";                                                  // "Il" letto con due elle
        words.push({ text, x0: bb.x0, x1: bb.x1, y0: bb.y0, y1: bb.y1, line, conf: Math.round(conf) });
    };
    if (data && Array.isArray(data.blocks) && data.blocks.length) {
        data.blocks.forEach(bl => (bl.paragraphs || []).forEach(p => (p.lines || []).forEach(l => { lineNo++; (l.words || []).forEach(w => push(w, lineNo)); })));
    } else if (data && Array.isArray(data.words)) data.words.forEach(w => push(w, undefined));
    return words;
}

// ---------------------------------------------------------------------------------------------------
// 4. Nel browser: file -> pagine -> canzone
// ---------------------------------------------------------------------------------------------------

const loaded = {};
function loadScript(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (!loaded[src]) loaded[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src; s.async = true; s.crossOrigin = "anonymous";
        s.onload = () => window[globalName] ? resolve(window[globalName]) : reject(new Error("libreria non caricata"));
        s.onerror = () => { delete loaded[src]; reject(new Error("serve la connessione per scaricare il lettore la prima volta")); };
        document.head.appendChild(s);
    });
    return loaded[src];
}

// Foto: girata giusta (EXIF), ridimensionata, in grigio. Le ombre e la luce non uniforme si tolgono dividendo
// per il "fondo" del foglio (stimato su una griglia: il punto più chiaro di ogni quadretto, poi sfumato).
export async function prepareImage(source) {
    let bmp = source;
    if (source instanceof Blob) {
        try { bmp = await createImageBitmap(source, { imageOrientation: "from-image" }); }
        catch (e) {
            bmp = await new Promise((res, rej) => {
                const img = new Image();
                img.onload = () => res(img);
                img.onerror = () => rej(new Error("immagine non leggibile (prova con una foto JPG o PNG)"));
                img.src = URL.createObjectURL(source);
            });
        }
    }
    const w0 = bmp.width, h0 = bmp.height;
    if (!w0 || !h0) throw new Error("immagine vuota");
    const scale = Math.min(2600 / Math.max(w0, h0), Math.max(1, 1600 / Math.min(w0, h0)));
    const canvas = document.createElement("canvas");
    const W = canvas.width = Math.round(w0 * scale), H = canvas.height = Math.round(h0 * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, W, H);
    if (bmp.close) bmp.close();
    try {
        const img = ctx.getImageData(0, 0, W, H), px = img.data;
        const gray = new Uint8ClampedArray(W * H);
        for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
            // accordi colorati (rossi, blu...) diventano scuri come il testo
            gray[j] = Math.min(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2], Math.min(px[i], px[i + 1], px[i + 2]) + 40);
        }
        const f = Math.max(8, Math.round(Math.max(W, H) / 100));
        const sw = Math.ceil(W / f), sh = Math.ceil(H / f);
        let bg = new Float32Array(sw * sh);
        const sum = new Float32Array(sw * sh), cnt = new Uint32Array(sw * sh);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const k = ((y / f) | 0) * sw + ((x / f) | 0), v = gray[y * W + x];
            if (v > bg[k]) bg[k] = v;
            sum[k] += v; cnt[k]++;
        }
        // fuori dal foglio (tavolo, coperta...): quadretti molto più scuri della carta. Si tolgono solo se la
        // separazione è netta (pochi quadretti a metà strada), così un'ombra sul foglio non viene cancellata.
        const means = Array.from(sum, (v, k) => v / Math.max(1, cnt[k]));
        const paper = means.slice().sort((a, b) => a - b)[Math.floor(means.length * 0.9)] || 255;
        const rel = means.map(m => m / paper);
        const valley = rel.filter(r => r >= 0.38 && r < 0.58).length / rel.length;
        const offPaper = valley < 0.06 && rel.filter(r => r < 0.38).length / rel.length > 0.05
            ? rel.map(r => r < 0.45) : null;
        for (let pass = 0; pass < 2; pass++) {          // sfumatura 3x3
            const nb = new Float32Array(bg.length);
            for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
                let s = 0, c = 0;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                    const yy = y + dy, xx = x + dx;
                    if (yy >= 0 && yy < sh && xx >= 0 && xx < sw) { s += bg[yy * sw + xx]; c++; }
                }
                nb[y * sw + x] = s / c;
            }
            bg = nb;
        }
        const out = new Uint8ClampedArray(W * H);
        for (let y = 0; y < H; y++) {
            const gy = Math.min(sh - 1.001, Math.max(0, y / f - 0.5)), y0 = gy | 0, ty = gy - y0;
            for (let x = 0; x < W; x++) {
                const gx = Math.min(sw - 1.001, Math.max(0, x / f - 0.5)), x0 = gx | 0, tx = gx - x0;
                const i0 = y0 * sw + x0, i1 = Math.min(i0 + 1, y0 * sw + sw - 1), i2 = Math.min(i0 + sw, bg.length - 1), i3 = Math.min(i2 + 1, bg.length - 1);
                const b = (bg[i0] * (1 - tx) + bg[i1] * tx) * (1 - ty) + (bg[i2] * (1 - tx) + bg[i3] * tx) * ty;
                const v = 255 * gray[y * W + x] / Math.max(24, b);
                out[y * W + x] = offPaper && offPaper[((y / f) | 0) * sw + ((x / f) | 0)] ? 255 : v;
            }
        }
        const hist = new Uint32Array(256);
        for (let j = 0; j < out.length; j++) hist[out[j]]++;
        // contrasto: l'1% più scuro diventa nero, il foglio bianco
        let acc = 0, lo = 0;
        while (lo < 200 && (acc += hist[lo]) < out.length * 0.01) lo++;
        const hi = 235, span = Math.max(20, hi - lo);
        for (let i = 0, j = 0; j < out.length; i += 4, j++) {
            const v = (out[j] - lo) * 255 / span;
            px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
    } catch (e) { /* senza correzione va bene lo stesso */ }
    return canvas;
}

// Gira il disegno di quarti di giro in senso antiorario (1 = 90°, 2 = 180°, 3 = 270°)
function rotateCanvas(src, quarters) {
    const q = ((quarters % 4) + 4) % 4;
    if (!q) return src;
    const c = document.createElement("canvas");
    c.width = q % 2 ? src.height : src.width;
    c.height = q % 2 ? src.width : src.height;
    const x = c.getContext("2d");
    x.translate(c.width / 2, c.height / 2);
    x.rotate(-q * Math.PI / 2);
    x.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
}

let tessWorker = null, ocrLabel = "", ocrProgress = () => {};
async function ocrCanvas(canvas, onProgress, label) {
    ocrLabel = label; ocrProgress = onProgress;
    const T = await loadScript(TESSERACT, "Tesseract");
    if (!tessWorker) {
        onProgress("Scarico il lettore di testo (solo la prima volta, qualche MB)…", null);
        tessWorker = await T.createWorker("ita", 1, {
            logger: (m) => { if (m && m.status === "recognizing text") ocrProgress(`${ocrLabel}: leggo il testo…`, m.progress); },
        });
        // una colonna di righe di grandezza diversa (titolo, accordi, testo)
        await tessWorker.setParameters({ tessedit_pageseg_mode: "4" });
    }
    onProgress(`${label}: leggo il testo…`, 0);
    // rotateAuto: raddrizza le foto un po' storte prima di leggerle
    const { data } = await tessWorker.recognize(canvas, { rotateAuto: true }, { blocks: true, text: false, hocr: false, tsv: false });
    const words = ocrToWords(data);
    console.debug(`[importer] ${label}: ${canvas.width}x${canvas.height}, sicurezza ${Math.round(data.confidence || 0)}, ${words.length} parole`);
    return { words, conf: data.confidence || 0 };
}

// Copia rimpicciolita (lato lungo max px) per le prove veloci
function shrinkCanvas(src, max) {
    const k = Math.min(1, max / Math.max(src.width, src.height));
    if (k >= 1) return src;
    const c = document.createElement("canvas");
    c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return c;
}

// Lettura di una pagina-immagine nel verso giusto. Prima com'è; se il testo letto non ha senso (sicurezza bassa:
// foglio orizzontale fotografato in verticale, o capovolto) si prova velocemente il foglio girato di 90°, 270° e
// 180° su una copia piccola, e si rilegge bene nel verso che dà il testo più sicuro.
async function ocrOriented(canvas, onProgress, label) {
    const first = await ocrCanvas(canvas, onProgress, label);
    if (first.conf >= 70) return first.words;
    const small = shrinkCanvas(canvas, 1400);
    let bestQ = 0, bestConf = first.conf;
    for (const q of [1, 3, 2]) {
        const probe = await ocrCanvas(rotateCanvas(small, q), onProgress, `${label}: provo a girarla`);
        if (probe.conf > bestConf + 10) { bestQ = q; bestConf = probe.conf; }
        if (bestConf >= 70) break;
    }
    if (!bestQ) return first.words;
    return (await ocrCanvas(rotateCanvas(canvas, bestQ), onProgress, label)).words;
}

async function pdfToPages(file, onProgress, label) {
    onProgress(`${label}: apro il PDF…`, null);
    const pdfjsLib = await loadScript(PDFJS, "pdfjsLib");
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    let pdf;
    try {
        // isEvalSupported: false = nessun codice eseguito dai caratteri del PDF (sicurezza)
        pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    } catch (e) {
        if (e && e.name === "PasswordException") throw new Error("il PDF è protetto da password");
        throw new Error("il file non sembra un PDF valido");
    }
    const n = Math.min(pdf.numPages, MAX_PAGES), pages = [];
    let usedOcr = false;
    for (let i = 1; i <= n; i++) {
        const pl = n > 1 ? `${label}, pagina ${i} di ${n}` : label;
        onProgress(`${pl}…`, (i - 1) / n);
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        // disegnare la pagina (anche piccola) carica i caratteri del PDF: così si misura dove sta ogni lettera
        try {
            const v0 = page.getViewport({ scale: 0.4 }), c0 = document.createElement("canvas");
            c0.width = Math.ceil(v0.width); c0.height = Math.ceil(v0.height);
            await page.render({ canvasContext: c0.getContext("2d"), viewport: v0 }).promise;
        } catch (e) { /* misure stimate */ }
        const tc = await page.getTextContent();
        let words = itemsToWords(tc.items, vp.height, tc.styles);
        if (words.length < 8) {   // PDF fatto di immagini (scansione): lo leggo come una foto
            const v2 = page.getViewport({ scale: Math.min(3, 2600 / Math.max(vp.width, vp.height)) });
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(v2.width); canvas.height = Math.ceil(v2.height);
            const cx = canvas.getContext("2d");
            cx.fillStyle = "#fff"; cx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: cx, viewport: v2 }).promise;
            words = await ocrOriented(await prepareImage(canvas), onProgress, pl);
            usedOcr = true;
        }
        pages.push({ words });
        page.cleanup();
    }
    pdf.destroy();
    return { pages, method: usedOcr ? "scansione" : "pdf", truncated: pdf.numPages > MAX_PAGES };
}

const isPdfFile = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");

// Lettura dei file: una o più foto / PDF (in ordine) -> { pages: [{ words }], method, truncated }
export async function readPages(files, onProgress = () => {}) {
    const list = [...files];
    const pages = [];
    const methods = new Set();
    let truncated = false;
    try {
        for (let k = 0; k < list.length; k++) {
            const file = list[k];
            const label = list.length > 1 ? `File ${k + 1} di ${list.length}` : (isPdfFile(file) ? "PDF" : "Foto");
            if (isPdfFile(file)) {
                const r = await pdfToPages(file, onProgress, label);
                pages.push(...r.pages); methods.add(r.method); truncated = truncated || r.truncated;
            } else {
                onProgress(`${label}: preparo l'immagine…`, null);
                const canvas = await prepareImage(file);
                pages.push({ words: await ocrOriented(canvas, onProgress, label) });
                methods.add("foto");
            }
        }
    } finally {
        // il lettore occupa molta memoria: lo chiudo (la volta dopo riparte dai file già scaricati)
        if (tessWorker) { const w = tessWorker; tessWorker = null; w.terminate().catch(() => {}); }
    }
    const method = methods.has("foto") ? "foto" : methods.has("scansione") ? "scansione" : "pdf";
    return { pages, method, truncated };
}

// Punto d'ingresso: file -> { title, text, lines, merged, chords, method, truncated }
// onProgress(messaggio, frazione 0..1 oppure null)
export async function importSongFiles(files, onProgress = () => {}) {
    const { pages, method, truncated } = await readPages(files, onProgress);
    return { ...layoutToSong(pages), method, truncated };
}
