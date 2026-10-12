// song-doctor.js — controllo e correzione automatica dei testi del canzoniere.
// Solo funzioni "pure" (nessun accesso a Firebase o al DOM): si possono testare da sole.
import { parseChord, chordPitch, suggestChord, transposeChord, normalizeChord } from "./music-utils.js";

// --- RICONOSCIMENTO ---------------------------------------------------------------

// Segni che possono stare su una riga di accordi senza essere accordi
const RE_DECORATION = /^(\|+|:?\|\|?:?|x\d+|\(x\d+\)|\d+x|\(\d+x\)|[-–—.\/%*]+|\.\.\.|N\.?C\.?)$/i;
// Etichette di sezione a inizio riga: "Intro:", "Rit.", "Coro", "Strofa 2:" ...
const RE_LABEL = /^(intro|outro|rit|ritornello|coro|strofa|bridge|ponte|special|solo|finale|fine|bis|pre-?rit|inciso|chorus|verse|riff|coda)\.?:?$/i;
const RE_LABEL_COLON = /^[A-Za-zÀ-ÿ]+\.?:$/;

// Contenuti tra [ ] che sono annotazioni volute, non accordi: [Rit.] [x2] [Chorus] [riff] [a cappella]...
const RE_BRACKET_NOTE = /^\(?\s*(rit|ritornello|coro|strofa|intro|outro|bridge|ponte|special|solo|assolo|finale|fine|bis|pre-?rit|pre-?chorus|inciso|chorus|verse|riff|coda|interludio|interlude|strumentale|instrumental|tutti|parlato|recitato|a ?cappella|lento|veloce|stop|pausa|break|tag|capo|ripeti|ripetere|da capo|d\.?c\.?|ad lib|fischio|fischiato|battiti|battito|percussioni|voce|voci|uomini|donne|bambini|x\s?\d+|\d+\s?x|n\.?c\.?|%|\|+).*$/i;

// Su una riga di soli accordi (senza parentesi) la radice deve essere maiuscola: "la la la" è testo
const RE_UPPER_ROOT = /^\(?(Do|DO|Re|RE|Mi|MI|Fa|FA|Sol|SOL|La|LA|Si|SI|[A-G])/;
export function isChordToken(tok) {
    return RE_UPPER_ROOT.test(tok) && parseChord(tok) !== null;
}

// Cosa c'è dentro una coppia di [ ]:
//   chord   accordo valido (anche (Re) opzionale, Re/Fa#)
//   multi   più accordi nella stessa parentesi: [Do Sol] [Do Sol x2]
//   note    annotazione: [Rit.] [Chorus] [riff] [a cappella / solo percussioni]
//   typo    quasi un accordo, con correzione proposta: [Miaj7] -> Mimaj7
//   unknown non si capisce: [Lsm]
const bracketCache = new Map();
export function classifyBracket(content) {
    const key = String(content ?? "");
    let r = bracketCache.get(key);
    if (!r) {
        r = classifyBracketRaw(key);
        if (bracketCache.size > 5000) bracketCache.clear();
        bracketCache.set(key, r);
    }
    return r;
}
function classifyBracketRaw(content) {
    const c = String(content ?? "").trim();
    if (!c) return { kind: "empty" };
    if (parseChord(c)) return { kind: "chord" };
    const parts = c.split(/\s+/);
    if (parts.length > 1 && parts.some(p => parseChord(p)) && parts.every(p => parseChord(p) || RE_DECORATION.test(p))) {
        return { kind: "multi", parts };
    }
    if (RE_BRACKET_NOTE.test(c)) return { kind: "note" };
    if (parts.length === 1) {
        const suggestion = suggestChord(c);
        if (suggestion) return { kind: "typo", suggestion };
    }
    const letters = c.replace(/[^A-Za-zÀ-ÿ]/g, "");
    if (parts.length > 1 || letters.length >= 5) return { kind: "note" };
    return { kind: "unknown" };
}

// Compatibilità con la versione precedente
export function isBracketChord(content) {
    const k = classifyBracket(content).kind;
    return k === "chord" || k === "multi";
}

// Testo cantato scambiato per accordi: "La La La", "Si Si Si", "Do Re Mi Fa Sol"
const SOLFEGE = ["do", "re", "mi", "fa", "sol", "la", "si"];
function looksLikeLyrics(chordTexts) {
    const bare = chordTexts.every(t => /^(Do|DO|Re|RE|Mi|MI|Fa|FA|Sol|SOL|La|LA|Si|SI)$/.test(t));
    if (!bare) return false;
    const low = chordTexts.map(t => t.toLowerCase());
    if (low.length >= 3 && low.every(t => t === low[0])) return true;
    if (low.length >= 4) {
        const idx = low.map(t => SOLFEGE.indexOf(t));
        const up = idx.every((v, i) => i === 0 || v === (idx[i - 1] + 1) % 7);
        const down = idx.every((v, i) => i === 0 || v === (idx[i - 1] + 6) % 7);
        if (up || down) return true;
    }
    return false;
}

// Riga di soli accordi SENZA parentesi ("Do    Sol    Lam").
// Restituisce null se non lo è, altrimenti { tokens: [{text, col, kind}], hasExtras, bracket:false }
export function parseChordLine(line) {
    if (!line || line.includes("[")) return null;
    const tokens = [];
    const re = /\S+/g;
    let m, hasExtras = false, first = true;
    while ((m = re.exec(line)) !== null) {
        const t = m[0];
        let kind;
        if (isChordToken(t)) kind = "chord";
        else if (RE_DECORATION.test(t)) { kind = "extra"; hasExtras = true; }
        else if (first && (RE_LABEL.test(t) || RE_LABEL_COLON.test(t))) { kind = "extra"; hasExtras = true; }
        else return null;
        tokens.push({ text: t, col: m.index, kind });
        first = false;
    }
    const chords = tokens.filter(t => t.kind === "chord");
    if (!chords.length || looksLikeLyrics(chords.map(t => t.text))) return null;
    return { tokens, hasExtras, bracket: false };
}

// Riga di soli accordi GIÀ tra parentesi ("[Fa]    [Sol#]   [Sol]"), senza testo cantato.
// col = colonna come si vede nell'anteprima (le parentesi e gli accordi hanno larghezza zero).
export function parseBracketChordLine(line) {
    if (!line || !line.includes("[")) return null;
    const tokens = [];
    let vis = 0, i = 0, hasExtras = false, chords = 0;
    while (i < line.length) {
        if (line[i] === "[") {
            const end = line.indexOf("]", i);
            if (end < 0) return null;
            const inner = line.slice(i + 1, end);
            const cls = classifyBracket(inner);
            if (cls.kind === "chord" || cls.kind === "typo") { tokens.push({ text: inner.trim(), col: vis, src: i, kind: "chord" }); chords++; }
            else if (cls.kind === "multi") {
                // [Do Sol] su una riga di soli accordi: li separo come se fossero scritti a parte
                let c = vis;
                cls.parts.forEach(p => {
                    if (parseChord(p)) { tokens.push({ text: p, col: c, src: i, kind: "chord" }); chords++; c += p.length + 1; }
                    else { tokens.push({ text: p, col: c, kind: "extra" }); hasExtras = true; c += p.length + 1; }
                });
            }
            else { tokens.push({ text: `[${inner}]`, col: vis, kind: "note" }); hasExtras = true; vis += inner.trim().length; }  // le annotazioni si vedono in linea
            i = end + 1;
            continue;
        }
        if (line[i] === "]") return null;
        if (!/\s/.test(line[i])) {
            // testo fuori dalle parentesi: ammesso solo se è un segno (| x2 %) o un'etichetta iniziale (Intro:)
            const m = line.slice(i).match(/^[^\s\[]+/);
            const word = m[0];
            const isFirst = tokens.length === 0;
            if (RE_DECORATION.test(word) || (isFirst && (RE_LABEL.test(word) || RE_LABEL_COLON.test(word)))) {
                tokens.push({ text: word, col: vis, kind: "extra" }); hasExtras = true;
                vis += word.length; i += word.length;
                continue;
            }
            return null;
        }
        vis++; i++;
    }
    return chords > 0 ? { tokens, hasExtras, bracket: true } : null;
}

// --- COME MOSTRARE UNA RIGA -----------------------------------------------------

// Testo da stampare per il contenuto di una [ ], già trasposto.
//   accordo -> trasposto ([Re] +2 = Mi);  refuso con correzione sicura -> la correzione trasposta ([Miaj7] -> Mimaj7);
//   annotazione o sconosciuto -> com'è scritto (non si traspone: prima [Chorus] diventava "Rehorus")
export function chordDisplay(content, transpose = 0) {
    const cls = classifyBracket(content);
    if (cls.kind === "chord") return transposeChord(normalizeChord(content), transpose);
    if (cls.kind === "typo") return transposeChord(normalizeChord(cls.suggestion), transpose);
    if (cls.kind === "multi") return cls.parts.map(p => parseChord(p) ? transposeChord(normalizeChord(p), transpose) : p).join(" ");
    return String(content ?? "").trim();
}

// Divide una riga in pezzi per l'anteprima:
//   { kind: "text", text }                       testo cantato (con eventuali ** e __)
//   { kind: "chord", raw, display, cls }         accordo (larghezza zero, sta sopra il testo)
//   { kind: "note", text }                        annotazione [Rit.] [x2] [Chorus]: si scrive in linea, non sopra
//   { kind: "pad", text }                         spazi aggiunti perché due accordi non si sovrappongano
// Gli accordi stanno sopra il testo con larghezza zero: se due sono troppo vicini ([Do][Sol], [Do] [Sol])
// si scriverebbero uno sopra l'altro. Prima di un accordo troppo vicino al precedente aggiungo gli spazi
// che mancano (nome dell'accordo precedente + 1).
export function layoutLine(line, transpose = 0) {
    const out = [];
    const re = /\[([^\[\]]*)\]/g;
    let last = 0, m, vis = 0, chordEnd = 0;
    const pushText = (t) => {
        if (!t) return;
        out.push({ kind: "text", text: t });
        vis += t.replace(/\*\*|__/g, "").length;
    };
    const pushChord = (raw, display, cls) => {
        if (vis < chordEnd) { const pad = " ".repeat(chordEnd - vis); out.push({ kind: "pad", text: pad }); vis = chordEnd; }
        out.push({ kind: "chord", raw, display, cls });
        chordEnd = vis + display.length + 1;
    };
    while ((m = re.exec(line)) !== null) {
        pushText(line.slice(last, m.index));
        last = m.index + m[0].length;
        const inner = m[1];
        const cls = classifyBracket(inner);
        if (cls.kind === "empty") continue;
        if (cls.kind === "note") {
            const t = inner.trim();
            out.push({ kind: "note", text: t });
            vis += t.length;
        } else if (cls.kind === "multi") {
            cls.parts.forEach(p => {
                if (parseChord(p)) pushChord(p, transposeChord(normalizeChord(p), transpose), { kind: "chord" });
                else { out.push({ kind: "note", text: p }); vis += p.length; }
            });
        } else {
            pushChord(inner, chordDisplay(inner, transpose), cls);
        }
    }
    pushText(line.slice(last));
    return out;
}

// Riga senza accordi ma con le annotazioni tenute come testo: "[Rit.] Do re [Do]mi" -> "(Rit.) Do re mi"
export function lineWithoutChords(line) {
    return String(line ?? "").replace(/\[([^\[\]]*)\]/g, (w, inner) => classifyBracket(inner).kind === "note" ? `(${inner.trim()})` : "");
}

// --- CORREZIONI SUL TESTO -------------------------------------------------------

// Mojibake tipico (UTF-8 letto come Windows-1252): "Ã¨" -> "è", "â€™" -> "’"
const CP1252 = { 0x20AC:0x80,0x201A:0x82,0x0192:0x83,0x201E:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,0x02C6:0x88,0x2030:0x89,0x0160:0x8A,0x2039:0x8B,0x0152:0x8C,0x017D:0x8E,0x2018:0x91,0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02DC:0x98,0x2122:0x99,0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F };
const RE_CONT = "[\\u0080-\\u00BF\\u0152\\u0153\\u0160\\u0161\\u0178\\u017D\\u017E\\u0192\\u02C6\\u02DC\\u2013\\u2014\\u2018-\\u201A\\u201C-\\u201E\\u2020-\\u2022\\u2026\\u2030\\u2039\\u203A\\u20AC\\u2122]";
const RE_MOJIBAKE = new RegExp("[\\u00C2-\\u00F4]" + RE_CONT + "+|\\u00C3 ", "g");

export function hasBrokenEncoding(text) {
    const t = text || "";
    return /\u00C3[\u0080-\u00BF ]|\u00E2\u20AC|\u00C2[\u00A0-\u00BF]|\uFFFD/.test(t);
}

// Ripara solo i pezzi rovinati ("perchÃ©" -> "perché") lasciando stare gli accenti già giusti
function decodeChunk(chunk) {
    const bytes = [];
    for (const ch of chunk) {
        const c = ch.codePointAt(0);
        if (c <= 0xFF) bytes.push(c);
        else if (CP1252[c] !== undefined) bytes.push(CP1252[c]);
        else return chunk;
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)); }
    catch { return chunk; }
}

function fixMojibakeLine(line) {
    RE_MOJIBAKE.lastIndex = 0;
    return line.replace(RE_MOJIBAKE, (chunk) => {
        if (chunk === "\u00C3 ") return "\u00E0"; // "Ã " = "à" a cui è stato tolto lo spazio speciale
        return decodeChunk(chunk);
    });
}

function expandTabs(line, size = 8) {
    if (!line.includes("\t")) return line;
    let out = "";
    for (const ch of line) {
        if (ch === "\t") out += " ".repeat(size - (out.length % size));
        else out += ch;
    }
    return out;
}


// Grafia di un accordo: "SOL7"->"Sol7", "do"->"Do", "Fa♯"->"Fa#", "LAM"->"Lam", "(re)"->"(Re)", " Do "->"Do".
// Se non è un accordo lo lascia com'è (senza spazi ai lati).
export function tidyChord(c) {
    const raw = String(c ?? "").trim();
    const p = parseChord(raw);
    if (!p) return raw;
    const root = (h) => (h.ita ? h.rootText[0].toUpperCase() + h.rootText.slice(1).toLowerCase() : h.rootText.toUpperCase()) + h.acc;
    let out = root(p) + p.suffix;
    if (p.bass) out += "/" + (p.bass.digits || root(p.bass));
    return p.paren ? `(${out})` : out;
}

// Nome dell'accordo da scrivere: grafia sistemata ed eventuale refuso corretto (solo se opts.typos)
function chordName(text, opts, changes) {
    const cls = classifyBracket(text);
    if (cls.kind === "typo") {
        if (opts.typos) { changes.typos.push(`${text} → ${cls.suggestion}`); return cls.suggestion; }
        return text.trim();
    }
    return tidyChord(text);
}

// Riga di soli accordi lasciata da sola (intro, interludio): accordi tra [ ] alle stesse colonne,
// con almeno uno spazio dopo ogni accordo così non si sovrappongono mai.
function formatStandalone(parsed, opts, changes) {
    let out = "", vis = 0, minCol = 0;
    for (const t of parsed.tokens) {
        const col = Math.max(t.col, minCol);
        out += " ".repeat(Math.max(0, col - vis));
        vis = Math.max(vis, col);
        if (t.kind === "chord") {
            const name = chordName(t.text, opts, changes);
            out += `[${name}]`;
            minCol = col + name.length + 1;           // l'accordo ha larghezza zero: lo spazio lo fanno gli spazi dopo
        } else {
            out += t.text;
            const w = t.kind === "note" ? t.text.length - 2 : t.text.length;   // [riff] si vede come "riff"
            vis = col + w;
            minCol = Math.max(minCol, col + w + 1);
        }
    }
    return out.replace(/\s+$/, "");
}

// Accordi (tra parentesi) presenti in una riga di testo, in notazione confrontabile
function lineChordKeys(line) {
    const keys = [];
    for (const m of line.matchAll(/\[([^\[\]]*)\]/g)) {
        const cls = classifyBracket(m[1]);
        if (cls.kind === "chord") keys.push(chordKey(m[1]));
        else if (cls.kind === "multi") cls.parts.filter(p => parseChord(p)).forEach(p => keys.push(chordKey(p)));
    }
    return keys;
}
function chordKey(c) {
    const p = parseChord(c);
    if (!p) return String(c).trim().toLowerCase();
    const pp = chordPitch(c);
    return `${pp.pc}:${p.suffix.replace(/^-/, "m")}${p.bass ? "/" + (p.bass.digits || p.bass.root) : ""}`;
}
const sameSeq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
// [Do Sol] -> [Do] [Sol];  [ Do ] -> [Do];  [SOL7] -> [Sol7];  [Do][Do] -> [Do];  refusi (se opts.typos)
function fixBracketsInLine(line, opts, changes) {
    let out = line.replace(/\[([^\[\]]*)\]/g, (whole, inner) => {
        const cls = classifyBracket(inner);
        if (cls.kind === "multi") {
            changes.splitBrackets++;
            return cls.parts.map(p => parseChord(p) ? `[${tidyChord(p)}]` + " ".repeat(tidyChord(p).length) : p).join(" ").trimEnd();
        }
        if (cls.kind === "chord") {
            const t = tidyChord(inner);
            if (`[${t}]` !== whole) changes.chordsTidied++;
            return `[${t}]`;
        }
        if (cls.kind === "typo" && opts.typos) {
            changes.typos.push(`${inner.trim()} → ${cls.suggestion}`);
            return `[${cls.suggestion}]`;
        }
        return whole;
    });
    // Stesso accordo ripetuto attaccato ([Do][Do] o [Do] [Do]) sopra il testo: nell'anteprima i due si
    // sovrappongono, quindi è un doppione: tengo quello più vicino alla sillaba.
    // Su una riga di soli accordi invece [Do]   [Do] sono due battute volute e restano.
    if (!out.replace(/\[[^\[\]]*\]/g, "").trim()) return out;
    const dup = /\[([^\[\]]+)\]( *)\[([^\[\]]+)\]/g;
    let prev;
    do {
        prev = out;
        out = out.replace(dup, (whole, a, sp, b) => {
            if (parseChord(a) && chordKey(a) === chordKey(b) && sp.length <= tidyChord(a).length) { changes.dupChords++; return `${sp}[${b}]`; }
            return whole;
        });
    } while (out !== prev);
    return out;
}


// Correzione completa del testo. opts.typos = correggi anche i refusi negli accordi.
// Restituisce il testo nuovo, cosa è stato cambiato e le righe da controllare a mano.
export function fixLyrics(input, opts = {}) {
    const changes = { chordLines: 0, bracketLines: 0, duplicateLines: 0, spacing: 0, chordsTidied: 0,
                      encoding: 0, splitBrackets: 0, dupChords: 0, typos: [], review: [] };
    let text = (input || "").replace(/\r\n?/g, "\n");

    let lines = text.split("\n").map(l => {
        const fixed = fixMojibakeLine(l);
        if (fixed !== l) changes.encoding++;
        return expandTabs(fixed.replace(/\u00A0/g, " "));
    });

    // 1. Righe di soli accordi (intro, parti strumentali, giri): restano righe a sé.
    //    Senza parentesi vengono messe tra [ ] alle stesse colonne (così si traspongono);
    //    se due accordi si toccano vengono distanziati. Non vengono mai unite al testo né tolte.
    lines = lines.map(line => {
        const parsed = parseChordLine(line) || parseBracketChordLine(line);
        if (!parsed) return line;
        const formatted = formatStandalone(parsed, opts, changes);
        if (formatted !== line.replace(/\s+$/, "")) {
            if (parsed.bracket) changes.spacing++; else changes.chordLines++;
        }
        return formatted;
    });

    // 2. Parentesi dentro le righe di testo
    lines = lines.map(l => l.includes("[") ? fixBracketsInLine(l, opts, changes) : l);

    // 3. Righe in cui ogni accordo compare esattamente due volte, fitte fitte (tipico di una riga di accordi
    //    unita due volte allo stesso testo): da controllare a mano
    lines.forEach((l, i) => {
        const k = lineChordKeys(l);
        if (k.length < 6 || k.length % 2) return;
        const counts = {};
        k.forEach(x => counts[x] = (counts[x] || 0) + 1);
        const twice = Object.values(counts).every(n => n === 2) || sameSeq(k.slice(0, k.length / 2), k.slice(k.length / 2));
        const visible = l.replace(/\[[^\[\]]*\]/g, "").trim();
        if (twice && visible.length > 0 && visible.length < k.length * 6) changes.review.push({ line: i + 1, why: "accordi ripetuti due volte" });
    });

    // 4. Spazi: niente spazi a fine riga, al massimo una riga vuota tra le strofe
    text = lines.map(l => l.replace(/\s+$/, "")).join("\n")
                .replace(/\n{3,}/g, "\n\n")
                .replace(/^\n+|\n+$/g, "");

    return { text, changes };
}

const plural = (n, uno, tanti) => `${n} ${n === 1 ? uno : tanti}`;
export function describeChanges(c) {
    const parts = [];
    if (c.chordLines) parts.push(plural(c.chordLines, "riga di accordi messa tra [ ] (ora si traspone)", "righe di accordi messe tra [ ] (ora si traspongono)"));
    if (c.spacing) parts.push(plural(c.spacing, "riga di accordi distanziata", "righe di accordi distanziate"));
    if (c.dupChords) parts.push(plural(c.dupChords, "accordo ripetuto tolto", "accordi ripetuti tolti"));
    if (c.splitBrackets) parts.push(plural(c.splitBrackets, "parentesi con più accordi divisa", "parentesi con più accordi divise"));
    if (c.chordsTidied) parts.push(plural(c.chordsTidied, "accordo riscritto", "accordi riscritti"));
    if (c.typos && c.typos.length) parts.push(`refusi corretti: ${c.typos.slice(0, 4).join(", ")}${c.typos.length > 4 ? "…" : ""}`);
    if (c.encoding) parts.push(plural(c.encoding, "riga con caratteri strani sistemata", "righe con caratteri strani sistemate"));
    if (c.review && c.review.length) parts.push(`da controllare: riga ${c.review.map(r => r.line).join(", ")}`);
    return parts.length ? parts.join(", ") : "nessuna modifica agli accordi (solo spazi)";
}

// --- TONALITÀ E ACCORDI FUORI TONALITÀ ---------------------------------------------
//
// Ogni accordo diventa (radice 0-11, tipo). Per ognuna delle 12 tonalità maggiori k
// (la relativa minore ha gli stessi accordi) si contano gli accordi che le appartengono:
//   diatonici:        I(k) ii(k+2,m) iii(k+4,m) IV(k+5) V(k+7) vi(k+9,m) vii°(k+11,dim)   peso 1
//   prestiti comuni:  II(k+2) = V/V,  III(k+4) = V/vi (anche il V del minore),
//                     VI(k+9) = V/ii, bVII(k+10), iv(k+5,m)                            peso 0,5
// La tonalità si calcola sull'intera canzone e, se una strofa ha almeno 6 accordi, anche sulla
// singola strofa (così una modulazione finale non fa segnalare mezza canzone).
// Un accordo fuori tonalità è "probabile errore" se nella canzone c'è un accordo vicino che invece
// ci sta (stessa radice con m/senza m, oppure mezzo tono sopra/sotto: Sol# vs Sol, Sol# vs Solm).

const KEY_NAMES = ["Do", "Reb", "Re", "Mib", "Mi", "Fa", "Fa#", "Sol", "Lab", "La", "Sib", "Si"];

// Compatibilità: "Lam7" -> { pc: 9, q: "m" }
export function chordToPc(raw) { return chordPitch(tidyChord(raw)); }

function fitWeight(k, { pc, q }) {
    const d = (pc - k + 12) % 12;
    if (q === "M") return [0, 5, 7].includes(d) ? 1 : [2, 3, 4, 8, 9, 10].includes(d) ? 0.5 : 0;
    if (q === "m") return [2, 4, 9].includes(d) ? 1 : [0, 5, 7].includes(d) ? 0.5 : 0;
    if (q === "dim") return d === 11 ? 1 : [1, 6, 8].includes(d) ? 0.5 : 0;
    if (q === "sus" || q === "5") return [0, 2, 5, 7, 9].includes(d) ? 1 : 0;
    return 0;
}

// Tutti gli accordi della canzone con la strofa in cui stanno, sia tra [ ] sia sulle righe di soli accordi
export function collectChords(lyrics) {
    const out = [];
    let section = 0, prevType = null;
    (lyrics || "").replace(/\r\n?/g, "\n").split("\n").forEach((l, lineNo) => {
        const line = expandTabs(l.replace(/\u00A0/g, " "));
        if (!line.trim()) { section++; prevType = null; return; }
        // passaggio da righe di soli accordi (parte strumentale) a righe cantate o viceversa = nuova strofa
        const type = (parseChordLine(line) || parseBracketChordLine(line)) ? "chords" : "text";
        if (prevType && type !== prevType) section++;
        prevType = type;
        const plain = parseChordLine(line);
        if (plain) { plain.tokens.filter(t => t.kind === "chord").forEach(t => out.push({ name: t.text, section, line: lineNo })); return; }
        for (const m of line.matchAll(/\[([^\[\]]*)\]/g)) {
            const cls = classifyBracket(m[1]);
            if (cls.kind === "chord") out.push({ name: m[1].trim(), section, line: lineNo });
            else if (cls.kind === "multi") cls.parts.filter(p => parseChord(p)).forEach(p => out.push({ name: p, section, line: lineNo }));
        }
    });
    return out;
}

function bestKey(parsed, favour = -1) {
    let best = null;
    for (let k = 0; k < 12; k++) {
        let score = parsed.reduce((t, c) => t + fitWeight(k, c), 0);
        const first = parsed[0];
        if (first.pc === k && first.q === "M") score += 0.5;
        if (first.pc === (k + 9) % 12 && first.q === "m") score += 0.5;
        if (k === favour) score += 0.75;
        if (!best || score > best.score) best = { k, score };
    }
    return best.k;
}

// Una riga tutta nel modo parallelo: in una canzone maggiore (tonica k) gli accordi del minore parallelo
// (relativa maggiore k+3: diatonici, più il V maggiore e la tonica maggiore come V/iv); in una minore quelli
// del maggiore parallelo.
function inParallelMode(seq, k, minorTonic) {
    if (minorTonic) {
        const P = (k + 9) % 12;
        return seq.every(c => fitWeight(P, c) === 1);
    }
    const r = (k + 3) % 12;
    return seq.every(c => {
        if (fitWeight(r, c) === 1) return true;
        const d = (c.pc - r + 12) % 12;
        return c.q === "M" && (d === 4 || d === 9);
    });
}

export function analyzeKey(lyrics, okChords = []) {
    const ok = new Set((okChords || []).map(c => tidyChord(c)));
    const parsed = collectChords(lyrics).map(c => {
        const name = tidyChord(c.name);
        return { name, section: c.section, line: c.line, ...chordPitch(name) };
    }).filter(x => x.pc !== undefined);
    if (parsed.length < 6) return null;

    const k = bestKey(parsed);
    const firstIsMinorTonic = parsed[0].pc === (k + 9) % 12 && parsed[0].q === "m";
    const minorTonic = firstIsMinorTonic;
    const keyName = firstIsMinorTonic ? KEY_NAMES[(k + 9) % 12] + "m" : KEY_NAMES[k];

    // tonalità di ogni strofa (se ha abbastanza accordi)
    const localKey = {};
    let modulates = false;
    [...new Set(parsed.map(c => c.section))].forEach(sec => {
        const cs = parsed.filter(c => c.section === sec);
        localKey[sec] = cs.length >= 6 ? bestKey(cs, k) : k;
        if (localKey[sec] !== k) modulates = true;
    });

    // Accordi "gemelli": stessa radice con/senza m (Re/Rem), oppure mezzo tono sopra/sotto (Sol#/Solm, Sol#/Sol)
    const near = (a, b) => {
        const d = (a.pc - b.pc + 12) % 12;
        return (d === 0 && a.q !== b.q && a.q !== "sus" && b.q !== "sus") || ((d === 1 || d === 11) && (a.q === b.q || (a.q === "M" && b.q === "m") || (a.q === "m" && b.q === "M")));
    };
    const countOf = (name) => parsed.filter(x => x.name === name).length;

    // PROVA DELLE STROFE: le canzoni ripetono gli stessi giri. Se una riga ha la stessa sequenza di altre
    // (almeno 2) tranne un accordo, e lì le altre hanno il gemello (Rem al posto di Re), è quasi certamente un refuso.
    const lineSeqs = new Map();
    parsed.forEach(c => { if (!lineSeqs.has(c.line)) lineSeqs.set(c.line, []); lineSeqs.get(c.line).push(c); });
    const bySeq = new Map();
    lineSeqs.forEach(seq => {
        if (seq.length < 2) return;
        const key = seq.map(c => c.name).join(" ");
        if (!bySeq.has(key)) bySeq.set(key, { seq, count: 0 });
        bySeq.get(key).count++;
    });
    const evidence = new Map();   // nome accordo -> { near: accordo che le altre strofe hanno al suo posto, others: quante }
    const groups = [...bySeq.values()];
    for (const A of groups) for (const B of groups) {
        if (A === B || A.seq.length !== B.seq.length || B.count < 2 || B.count < 2 * A.count) continue;
        const diff = A.seq.map((c, i) => i).filter(i => A.seq[i].name !== B.seq[i].name);
        if (diff.length !== 1) continue;
        const a = A.seq[diff[0]], b = B.seq[diff[0]];
        if (!near(a, b) || fitWeight(localKey[a.section], a) >= 1) continue;
        // Se tutta la riga sta nel modo parallelo (Dom Mib Fam Sol7 al posto di Do Mi Fa Sol7) è un cambio
        // di modo voluto: lo considero errore solo se le righe "normali" sono molte di più (almeno 3 contro 1).
        if (inParallelMode(A.seq, localKey[a.section], minorTonic) && !(B.count >= 3 && B.count >= 3 * A.count)) continue;
        evidence.set(a.name, { near: b.name, others: B.count });
    }

    let inKey = 0;
    const outside = new Map();
    parsed.forEach(c => {
        const w = fitWeight(localKey[c.section], c);
        if (w > 0 && !evidence.has(c.name)) { inKey++; return; }
        const o = outside.get(c.name) || { chord: c.name, count: 0, pc: c.pc, q: c.q, key: localKey[c.section], lines: [] };
        o.count++;
        if (!o.lines.includes(c.line + 1)) o.lines.push(c.line + 1);
        outside.set(c.name, o);
    });

    // Senza la prova delle strofe: sospetto solo un accordo fuori tonalità usato UNA volta, quando il suo
    // gemello nella tonalità compare almeno 3 volte. Tutti gli altri fuori tonalità sono solo "insoliti".
    const inKeyNames = new Map();
    parsed.forEach(c => { if (fitWeight(localKey[c.section], c) > 0 && !evidence.has(c.name)) inKeyNames.set(c.name, c); });
    const keyLabel = (kk) => minorTonic ? KEY_NAMES[(kk + 9) % 12] + "m" : KEY_NAMES[kk];
    const result = [...outside.values()].filter(o => !ok.has(o.chord)).map(o => {
        const ev = evidence.get(o.chord);
        let nearName = ev ? ev.near : null, why;
        if (ev) {
            why = `Le altre ${ev.others} righe uguali hanno ${ev.near} in questo punto: probabile errore di battitura.`;
        } else if (o.count === 1) {
            let best = -1;
            for (const c of inKeyNames.values()) {
                const n = countOf(c.name);
                if (near(o, c) && n >= 3 && n > best) { best = n; nearName = c.name; }
            }
            if (nearName) why = `Non appartiene alla tonalità (${keyLabel(o.key)}), compare una volta sola e ${nearName} compare ${best} volte: forse è ${nearName}.`;
        }
        if (!why) why = `Non appartiene alla tonalità stimata (${keyLabel(o.key)}). Spesso è giusto: passaggio cromatico, cambio di tonalità o di modo.`;
        return { chord: o.chord, count: o.count, likely: !!nearName, near: nearName, lines: o.lines, why };
    });

    const FLAT_KEYS = [1, 3, 5, 8, 10];
    const spelling = new Set();
    if (FLAT_KEYS.includes(k)) parsed.forEach(c => { if (/#/.test(c.name)) spelling.add(c.name); });

    return { key: keyName, fit: inKey / parsed.length, total: parsed.length, modulates, outside: result, spelling: [...spelling] };
}

// Accordi da evidenziare nell'anteprima: likely = probabile errore (rosso), unusual = insolito (arancione)
export function suspiciousChords(lyrics, okChords = []) {
    const a = analyzeKey(lyrics, okChords);
    const res = { likely: new Set(), unusual: new Set(), why: new Map() };
    if (!a || a.fit < 0.6) return res;
    a.outside.forEach(o => { (o.likely ? res.likely : res.unusual).add(o.chord); res.why.set(o.chord, o.why); });
    return res;
}

// --- DIAGNOSI -------------------------------------------------------------------

export const ISSUES = {
    "typo":          { label: "Accordi con refusi", hint: "Quasi accordi con una correzione sicura: [Miaj7] → Mimaj7, [Fasos2] → Fasus2, [H7] → Si7. Correggibile in automatico.", fixable: true, opts: { typos: true } },
    "unknown-chord": { label: "Accordi non riconosciuti", hint: "Contenuto tra [ ] che non è né un accordo né un'annotazione. Da correggere a mano.", fixable: false },
    "brackets":      { label: "Parentesi [ ] non chiuse", hint: "Una [ senza ] (o viceversa) sulla stessa riga. Da correggere a mano.", fixable: false },
    "encoding":      { label: "Caratteri strani (Ã¨, â€™…)", hint: "Accenti rovinati da un import. Correggibile in automatico.", fixable: true },
    "tidy":          { label: "Accordi scritti male", hint: "[SOL7], [ Do ], [Fa♯], [Do Sol], [Do][Do] sopra il testo, accordi attaccati che si sovrappongono. Correggibile in automatico. Le righe di soli accordi (parti strumentali) restano dove sono.", fixable: true },
    "review":        { label: "Righe da controllare", hint: "Ogni accordo ripetuto due volte nella stessa riga: probabilmente una riga di accordi unita due volte al testo dalla vecchia bacchetta. Da controllare a mano (o ripristina il backup).", fixable: false },
    "off-key-likely":{ label: "Accordi sospetti", hint: "Le altre righe uguali della canzone hanno un accordo gemello in quel punto (Rem invece di Re...): probabile errore. Nell'editor sono sottolineati in rosso: toccali per vedere il motivo o per segnarli come giusti.", fixable: false },
    "off-key":       { label: "Accordi insoliti", hint: "Fuori dalla tonalità stimata: spesso sono giusti (passaggi cromatici, cambi di tonalità). Nell'editor sono sottolineati in arancione: toccali per segnarli come giusti.", fixable: false },
    "duplicate":     { label: "Titoli doppi", hint: "Stesso titolo e stesso autore (o autore mancante). Stesso titolo con autori diversi è normale e non viene segnalato.", fixable: false },
    "empty":         { label: "Vuote", hint: "Senza testo.", fixable: false },
    "no-chords":     { label: "Senza accordi", hint: "Solo testo.", fixable: false },
};

// Stessa canzone = stesso titolo e stesso autore. Se uno dei due non ha l'autore la consideriamo la stessa;
// stesso titolo con autori diversi sono canzoni diverse (es. due "Alleluia").
const normAuthor = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
export function isSameSong(titleA, authorA, titleB, authorB) {
    if (normTitle(titleA) !== normTitle(titleB) || !normTitle(titleA)) return false;
    const a = normAuthor(authorA), b = normAuthor(authorB);
    return !a || !b || a === b;
}

const normTitle = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();

export function diagnoseSong(song) {
    const issues = [];
    const lyrics = (song.lyrics || "").replace(/\r\n?/g, "\n");
    if (lyrics.trim().length <= 5) { issues.push({ code: "empty", detail: "" }); return issues; }

    const lines = lyrics.split("\n");
    const { changes } = fixLyrics(lyrics, { typos: false });

    // nome -> righe in cui compare (per dire dove andare a correggere)
    const unknown = new Map(), typos = new Map(), badBrackets = [];
    const addTo = (map, key, lineNo) => { if (!map.has(key)) map.set(key, []); if (!map.get(key).includes(lineNo)) map.get(key).push(lineNo); };
    lines.forEach((l, i) => {
        const opens = (l.match(/\[/g) || []).length, closes = (l.match(/\]/g) || []).length;
        if (opens !== closes || /\[[^\]]*\[/.test(l)) badBrackets.push(i + 1);
        for (const m of l.matchAll(/\[([^\[\]]*)\]/g)) {
            const cls = classifyBracket(m[1]);
            if (cls.kind === "typo") addTo(typos, `[${m[1].trim()}] → ${cls.suggestion}`, i + 1);
            else if (cls.kind === "unknown") addTo(unknown, `[${m[1]}]`, i + 1);
        }
    });
    const where = (rows) => ` (riga ${rows.slice(0, 4).join(", ")}${rows.length > 4 ? "…" : ""})`;
    const list = (map, max) => [...map.entries()].slice(0, max).map(([k, rows]) => k + where(rows)).join("  ");
    if (typos.size) issues.push({ code: "typo", detail: list(typos, 4) });
    if (unknown.size) issues.push({ code: "unknown-chord", detail: list(unknown, 6) });
    if (badBrackets.length) issues.push({ code: "brackets", detail: "riga " + badBrackets.slice(0, 6).join(", ") });
    if (hasBrokenEncoding(lyrics)) issues.push({ code: "encoding", detail: "" });

    const tidy = changes.chordsTidied + changes.splitBrackets + changes.dupChords + changes.spacing;
    if (tidy) issues.push({ code: "tidy", detail: tidy === 1 ? "1 correzione" : `${tidy} correzioni` });
    if (changes.review.length) issues.push({ code: "review", detail: "riga " + changes.review.map(r => r.line).join(", ") });

    const key = analyzeKey(lyrics, song.chordOk);
    if (key && key.fit >= 0.6) {
        const fmt = (o) => (o.count > 1 ? `${o.chord} ×${o.count}` : o.chord) + (o.near ? ` forse ${o.near}?` : "")
            + (o.lines && o.lines.length ? ` (riga ${o.lines.slice(0, 4).join(", ")}${o.lines.length > 4 ? "…" : ""})` : "");
        const likely = key.outside.filter(o => o.likely), unusual = key.outside.filter(o => !o.likely);
        if (likely.length) issues.push({ code: "off-key-likely", detail: `in ${key.key}: ` + likely.map(fmt).join(", ") });
        if (unusual.length) issues.push({ code: "off-key", detail: `in ${key.key}${key.modulates ? " (cambia tonalità)" : ""}: ` + unusual.map(fmt).join(", ") });
    }
    const hasChords = lyrics.includes("[") || lines.some(l => parseChordLine(l));
    if (!hasChords) issues.push({ code: "no-chords", detail: "" });
    return issues;
}

// Scansione di tutto il canzoniere (lavora sui dati già in memoria: zero letture extra)
export function scanSongs(songs) {
    const report = {};
    Object.keys(ISSUES).forEach(k => report[k] = []);
    const byTitle = new Map();
    songs.forEach(s => {
        diagnoseSong(s).forEach(i => report[i.code].push({ song: s, detail: i.detail }));
        const k = normTitle(s.title);
        if (!byTitle.has(k)) byTitle.set(k, []);
        byTitle.get(k).push(s);
    });
    byTitle.forEach(list => {
        if (list.length < 2) return;
        list.forEach(s => {
            const twins = list.filter(o => o !== s && isSameSong(s.title, s.author, o.title, o.author));
            if (twins.length) report.duplicate.push({ song: s, detail: twins.map(o => `${o.author || "senza autore"} · ${o.category || ""}`).join(", ") });
        });
    });
    return report;
}

// La correzione automatica cambia qualcosa di sostanziale (non solo spazi)?
export function isAutoFixable(song, opts = {}) {
    const { changes: c } = fixLyrics(song.lyrics || "", opts);
    return c.chordLines + c.bracketLines + c.duplicateLines + c.spacing + c.chordsTidied + c.encoding
         + c.splitBrackets + c.dupChords + c.typos.length > 0;
}
