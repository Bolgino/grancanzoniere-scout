const SCALA = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

const MAPPA_ITA_TO_ENG = {"do":"C","re":"D","mi":"E","fa":"F","sol":"G","la":"A","si":"B"};

const MAPPA_ENG_TO_ITA = {
    "C": "Do", "C#": "Do#", "Db": "Reb",
    "D": "Re", "D#": "Re#", "Eb": "Mib",
    "E": "Mi",
    "F": "Fa", "F#": "Fa#", "Gb": "Solb",
    "G": "Sol", "G#": "Sol#", "Ab": "Lab",
    "A": "La", "A#": "La#", "Bb": "Sib",
    "B": "Si"
};

// --- GRAMMATICA DI UN ACCORDO ------------------------------------------------------
// accordo = radice [# | b] suffisso [/basso], eventualmente tra parentesi: (Re) = accordo opzionale.
// Radici: italiane (Do Re Mi Fa Sol La Si, maiuscole o minuscole) oppure inglesi (A-G).
// Il suffisso ammette solo pezzi da accordo: m, maj, min, dim, aug, sus, add, numeri, + - ° ø ( ) # b.
// Così [Chorus], [Bridge], [Solo], [Fine] NON sono accordi e non vengono "trasposti" (prima: Dohorus).
const SUFFIX_RE = /^(?:maj|Maj|MAJ|min|dim|aug|sus|add|m|M|[0-9]|[+\-°øΔ#b()])*$/;
const ITA_ROOT_RE = /^(do|re|mi|fa|sol|la|si)/i;

function rootCandidates(s) {
    const out = [];
    const mi = s.match(ITA_ROOT_RE);
    if (mi) out.push({ eng: MAPPA_ITA_TO_ENG[mi[1].toLowerCase()], text: mi[1], ita: true });
    const me = s.match(/^[A-Ga-g]/);
    if (me) out.push({ eng: me[0].toUpperCase(), text: me[0], ita: false });
    return out;
}

// Una radice italiana scritta TUTTA MAIUSCOLA (LA, SOL, DO...) seguita da "M" vuol dire minore: LAM = Lam
function canonicalSuffix(rootText, ita, suffix) {
    let s = suffix.replace(/MAJ|Maj/g, "maj");
    if (ita && rootText.length >= 2 && rootText === rootText.toUpperCase() && /^M(?!aj)/.test(s)) s = "m" + s.slice(1);
    return s;
}

function parseHead(s, bassOnly) {
    for (const r of rootCandidates(s)) {
        let rest = s.slice(r.text.length);
        let acc = "";
        if (rest[0] === "#" || rest[0] === "b") { acc = rest[0]; rest = rest.slice(1); }
        if (bassOnly ? rest === "" : SUFFIX_RE.test(rest)) {
            return { root: r.eng + acc, rootText: r.text, acc, ita: r.ita, suffix: bassOnly ? "" : canonicalSuffix(r.text, r.ita, rest) };
        }
    }
    return null;
}

// "Lam7/Sol" -> { root:"A", suffix:"m7", bass:{root:"G"}, paren:false, ... }  |  "Chorus" -> null
export function parseChord(raw) {
    let s = String(raw ?? "").trim().replace(/♯/g, "#").replace(/♭/g, "b");
    let paren = false;
    if (s.length > 2 && s[0] === "(" && s[s.length - 1] === ")") { paren = true; s = s.slice(1, -1).trim(); }
    if (!s) return null;
    let main = s, bassTxt = null;
    const slash = s.indexOf("/");
    if (slash > 0) { main = s.slice(0, slash); bassTxt = s.slice(slash + 1); }
    const head = parseHead(main, false);
    if (!head) return null;
    let bass = null;
    if (bassTxt !== null) {
        if (/^[0-9]+$/.test(bassTxt)) bass = { digits: bassTxt };
        else { bass = parseHead(bassTxt, true); if (!bass) return null; }
    }
    return { ...head, bass, paren };
}

export function isChord(raw) { return parseChord(raw) !== null; }

export function extractChords(t) {
    const m = (t || "").match(/\[(.*?)\]/g);
    return m ? m.map(x => x.replace(/[\[\]]/g,'')) : [];
}

// Accordo in notazione inglese ("Do/Mi" -> "C/E"). Se non è un accordo lo restituisce com'è.
export function normalizeChord(c) {
    const p = parseChord(c);
    if (!p) return String(c ?? "").trim();
    let out = p.root + p.suffix;
    if (p.bass) out += "/" + (p.bass.digits || p.bass.root);
    return p.paren ? `(${out})` : out;
}

function transposeNote(r, s) {
    // Senza trasposizione lascia la nota com'è scritta (Sib resta Sib, non La#)
    if (s % 12 === 0 && MAPPA_ENG_TO_ITA[r]) return MAPPA_ENG_TO_ITA[r];
    if (r.endsWith("b")) {
        let idx = SCALA.indexOf(r[0]) - 1;
        r = SCALA[idx < 0 ? 11 : idx];
    }
    let idx = SCALA.indexOf(r);
    if (idx === -1) {
        // E# / B# (rari): un semitono sopra la nota naturale
        const nat = SCALA.indexOf(r[0]);
        if (nat === -1) return null;
        idx = (nat + 1) % 12;
    }
    let n = (idx + s) % 12;
    if (n < 0) n += 12;
    const eng = SCALA[n];
    return MAPPA_ENG_TO_ITA[eng] || eng;
}

// Traspone e scrive in italiano. Le annotazioni ([Chorus], [x2], [Rit.]) restano come sono.
export function transposeChord(c, s) {
    const p = parseChord(c);
    if (!p) return c;
    const root = transposeNote(p.root, s);
    if (root === null) return c;
    let out = root + p.suffix;
    if (p.bass) {
        if (p.bass.digits) out += "/" + p.bass.digits;
        else { const b = transposeNote(p.bass.root, s); out += "/" + (b === null ? p.bass.root : b); }
    }
    return p.paren ? `(${out})` : out;
}

// Altezza e tipo dell'accordo (per stimare la tonalità): { pc: 0-11, q: "M" | "m" | "dim" | "sus" | "5" }
export function chordPitch(raw) {
    const p = parseChord(raw);
    if (!p) return null;
    const base = SCALA.indexOf(p.root[0]);
    const pc = (base + (p.acc === "#" ? 1 : p.acc === "b" ? -1 : 0) + 12) % 12;
    const suf = p.suffix;
    let q = "M";
    if (/^(dim|°|ø|m7b5|m7-5)/.test(suf)) q = "dim";
    else if (/^(m(?!aj)|min|-)/.test(suf)) q = "m";
    else if (/^sus/.test(suf)) q = "sus";
    else if (/^5$/.test(suf)) q = "5";
    return { pc, q };
}

// --- SUGGERIMENTI PER I REFUSI ---------------------------------------------------------
// [Miaj7] -> Mimaj7, [Fasos2] -> Fasus2, [H7] -> Si7 (notazione tedesca), [DoSUS4] -> Dosus4.
// Propone una correzione solo se è UNICA a distanza minima: [Doma7] (maj7 o m7?) resta senza suggerimento.
const COMMON_SUFFIXES = ["", "m", "7", "m7", "maj7", "7+", "M7", "sus2", "sus4", "sus", "7sus4", "add9", "add2",
    "dim", "dim7", "°", "aug", "+", "6", "m6", "9", "m9", "11", "13", "4", "2", "5", "m7b5", "7b9", "m(maj7)", "-", "-7", "6/9"];

function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
}

export function suggestChord(raw) {
    let s = String(raw ?? "").trim();
    if (!s || parseChord(s)) return null;
    let paren = false;
    if (s.length > 2 && s[0] === "(" && s[s.length - 1] === ")") { paren = true; s = s.slice(1, -1).trim(); }
    const wrap = (x) => paren ? `(${x})` : x;
    // Notazione tedesca: H = Si
    if (/^[Hh]/.test(s) && parseChord("Si" + s.slice(1))) return wrap("Si" + s.slice(1));
    let bass = "";
    const slash = s.indexOf("/");
    if (slash > 0) { bass = s.slice(slash); s = s.slice(0, slash); if (!parseChord("C" + bass)) return null; }
    let best = null, bestD = Infinity, tie = false;
    for (const r of rootCandidates(s)) {
        let rest = s.slice(r.text.length), acc = "";
        if (rest[0] === "#" || rest[0] === "b") { acc = rest[0]; rest = rest.slice(1); }
        const maxD = rest.length >= 4 ? 2 : 1;
        const rootOut = (r.ita ? r.text[0].toUpperCase() + r.text.slice(1).toLowerCase() : r.text.toUpperCase()) + acc;
        for (const suf of COMMON_SUFFIXES) {
            const d = Math.min(lev(rest, suf), lev(rest.toLowerCase(), suf));
            if (d > maxD) continue;
            const cand = rootOut + suf + bass;
            if (!parseChord(cand)) continue;
            if (d < bestD) { bestD = d; best = cand; tie = false; }
            else if (d === bestD && cand !== best) tie = true;
        }
    }
    return best && !tie ? wrap(best) : null;
}
