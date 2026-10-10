// song-doctor.js — controllo e correzione automatica dei testi del canzoniere.
// Solo funzioni "pure" (nessun accesso a Firebase o al DOM): si possono testare da sole.

// --- RICONOSCIMENTO ACCORDI -------------------------------------------------

// Radici ammesse su una riga di soli accordi (senza parentesi): Do / DO, Sol / SOL, A-G.
// Le minuscole ("la la la") NON contano come accordi, per non scambiare il testo per accordi.
const ROOT_STRICT = "(?:Do|DO|Re|RE|Mi|MI|Fa|FA|Sol|SOL|La|LA|Si|SI|[A-G])";
// Dentro le parentesi [ ] accettiamo anche le minuscole: [lam] è comunque un accordo.
const ROOT_ANY = "(?:[Dd][Oo]|[Rr][Ee]|[Mm][Ii]|[Ff][Aa]|[Ss][Oo][Ll]|[Ll][Aa]|[Ss][Ii]|[A-Ga-g])";
const ACC = "(?:#|b|♯|♭)?";
const SUFFIX = "(?:maj|Maj|MAJ|min|dim|aug|sus|add|m|M|[0-9]|[+\\-°øΔ#b♯♭()])*";
const BASS = (root) => `(?:/(?:${root}${ACC}|[0-9]+))?`;

const RE_CHORD_STRICT = new RegExp(`^\\(?${ROOT_STRICT}${ACC}${SUFFIX}${BASS(ROOT_STRICT)}\\)?$`);
const RE_CHORD_ANY = new RegExp(`^${ROOT_ANY}${ACC}${SUFFIX}${BASS(ROOT_ANY)}$`);

// Segni che possono stare su una riga di accordi senza essere accordi
const RE_DECORATION = /^(\|+|:?\|\|?:?|x\d+|\(x\d+\)|\d+x|\(\d+x\)|[-–—.\/%*]+|\.\.\.|N\.?C\.?)$/i;
// Etichette di sezione: "Intro:", "Rit.", "Coro", "Strofa 2:" ...
const RE_LABEL = /^(intro|outro|rit|ritornello|coro|strofa|bridge|ponte|special|solo|finale|fine|bis|pre-?rit|inciso)\.?:?$/i;
const RE_LABEL_COLON = /^[A-Za-zÀ-ÿ]+\.?:$/;

// Contenuti tra [ ] che sono annotazioni volute, non accordi
const RE_BRACKET_NOTE = /^\(?\s*(rit|ritornello|coro|strofa|intro|outro|bridge|ponte|special|solo|finale|fine|bis|pre-?rit|inciso|x\s?\d+|\d+\s?x|n\.?c\.?)\b.*\)?$/i;

export function isChordToken(tok) {
    return RE_CHORD_STRICT.test(tok);
}

export function isBracketChord(content) {
    return RE_CHORD_ANY.test(content.trim().replace(/\s+/g, ""));
}

// Una riga è "di soli accordi" se ogni parola è un accordo, un segno (| x2 ...) o un'etichetta iniziale.
// Restituisce null se non lo è, altrimenti { tokens: [{text, col, kind}], hasExtras }
export function parseChordLine(line) {
    if (!line || line.includes("[")) return null;
    const tokens = [];
    const re = /\S+/g;
    let m, chords = 0, hasExtras = false, first = true;
    while ((m = re.exec(line)) !== null) {
        const t = m[0];
        let kind;
        if (isChordToken(t)) { kind = "chord"; chords++; }
        else if (RE_DECORATION.test(t)) { kind = "extra"; hasExtras = true; }
        else if (first && (RE_LABEL.test(t) || RE_LABEL_COLON.test(t))) { kind = "extra"; hasExtras = true; }
        else return null;
        tokens.push({ text: t, col: m.index, kind });
        first = false;
    }
    return chords > 0 ? { tokens, hasExtras } : null;
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

// Sistema la grafia di un accordo già tra parentesi: "SOL7"->"Sol7", "do"->"Do", "Fa♯"->"Fa#"
export function tidyChord(c) {
    let s = c.trim().replace(/♯/g, "#").replace(/♭/g, "b");
    const fixRoot = (part) => part.replace(/^(do|re|mi|fa|sol|la|si)(?=$|[^a-z]|m|sus|add|dim|aug|maj)/i,
        (r) => r[0].toUpperCase() + r.slice(1).toLowerCase())
        .replace(/^([a-g])(?=$|[#b0-9+\-°ø()\/]|m|sus|add|dim|aug|maj)/, (r) => r.toUpperCase());
    const slash = s.indexOf("/");
    if (slash > 0) return fixRoot(s.slice(0, slash)) + "/" + fixRoot(s.slice(slash + 1));
    return fixRoot(s);
}

// Converte una riga di accordi in formato [Accordo] mantenendo le colonne.
// Il CSS mostra gli accordi con larghezza 0, quindi dopo ogni [Do] rimetto tanti spazi
// quanti erano i caratteri dell'accordo, così gli accordi successivi restano allineati.
function chordLineToInline(parsed) {
    let out = "", cursor = 0;
    for (const t of parsed.tokens) {
        out += " ".repeat(Math.max(0, t.col - cursor));
        if (t.kind === "chord") {
            const name = tidyChord(t.text.replace(/^\(|\)$/g, ""));
            out += `[${name}]` + " ".repeat(t.text.length);
        } else {
            out += t.text;
        }
        cursor = t.col + t.text.length;
    }
    return out;
}

// Inserisce gli accordi della riga sopra dentro la riga di testo, alla stessa colonna.
function mergeChordLine(parsed, lyric) {
    let text = lyric;
    const chords = parsed.tokens.filter(t => t.kind === "chord");
    const maxCol = Math.max(...chords.map(t => t.col));
    if (text.length < maxCol) text = text + " ".repeat(maxCol - text.length);
    // da destra a sinistra così gli indici non si spostano
    for (let i = chords.length - 1; i >= 0; i--) {
        const t = chords[i];
        const name = tidyChord(t.text.replace(/^\(|\)$/g, ""));
        text = text.slice(0, t.col) + `[${name}]` + text.slice(t.col);
    }
    return text.replace(/\s+$/, "");
}

// Correzione completa del testo. Restituisce il testo nuovo e cosa è stato cambiato.
export function fixLyrics(input) {
    const changes = { chordLines: 0, chordsTidied: 0, encoding: 0, splitBrackets: 0 };
    let text = (input || "").replace(/\r\n?/g, "\n");

    let lines = text.split("\n").map(l => {
        const fixed = fixMojibakeLine(l);
        if (fixed !== l) changes.encoding++;
        return expandTabs(fixed.replace(/\u00A0/g, " "));
    });

    // 1. Accordi su riga separata -> [Accordo] dentro il testo
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const parsed = parseChordLine(lines[i]);
        if (!parsed) { out.push(lines[i]); continue; }
        const next = lines[i + 1];
        const nextIsLyric = next !== undefined && next.trim() !== "" && !parseChordLine(next);
        if (nextIsLyric && !parsed.hasExtras) {
            out.push(mergeChordLine(parsed, next));
            i++; // la riga di testo è stata consumata
        } else {
            out.push(chordLineToInline(parsed));
        }
        changes.chordLines++;
    }
    lines = out;

    // 2. Accordi già tra parentesi: grafia ([SOL7] -> [Sol7], [ Do ] -> [Do]) e [Do Sol] -> [Do] [Sol]
    lines = lines.map(l => l.replace(/\[([^\[\]]*)\]/g, (whole, inner) => {
        if (RE_BRACKET_NOTE.test(inner.trim())) return whole;
        const parts = inner.trim().split(/\s+/).filter(Boolean);
        if (parts.length > 1 && parts.every(p => isBracketChord(p))) {
            changes.splitBrackets++;
            return parts.map(p => `[${tidyChord(p)}]` + " ".repeat(p.length)).join(" ").trimEnd();
        }
        if (parts.length === 1 && isBracketChord(parts[0])) {
            const t = tidyChord(parts[0]);
            if (`[${t}]` !== whole) { changes.chordsTidied++; return `[${t}]`; }
        }
        return whole;
    }));

    // 3. Spazi: niente spazi a fine riga, al massimo una riga vuota tra le strofe
    text = lines.map(l => l.replace(/\s+$/, "")).join("\n")
                .replace(/\n{3,}/g, "\n\n")
                .replace(/^\n+|\n+$/g, "");

    return { text, changes };
}

export function describeChanges(c) {
    const parts = [];
    const pl = (n, uno, tanti) => `${n} ${n === 1 ? uno : tanti}`;
    if (c.chordLines) parts.push(pl(c.chordLines, "riga di accordi convertita", "righe di accordi convertite"));
    if (c.splitBrackets) parts.push(pl(c.splitBrackets, "parentesi con più accordi divisa", "parentesi con più accordi divise"));
    if (c.chordsTidied) parts.push(pl(c.chordsTidied, "accordo riscritto", "accordi riscritti"));
    if (c.encoding) parts.push(pl(c.encoding, "riga con caratteri strani sistemata", "righe con caratteri strani sistemate"));
    return parts.length ? parts.join(", ") : "nessuna modifica agli accordi (solo spazi)";
}

// --- DIAGNOSI -------------------------------------------------------------------

export const ISSUES = {
    "chords-above":  { label: "Accordi su riga separata", hint: "Non si traspongono e si disallineano. Correggibile in automatico.", fixable: true },
    "unknown-chord": { label: "Accordi non riconosciuti", hint: "Contenuto tra [ ] che non è un accordo valido. Da correggere a mano.", fixable: false },
    "brackets":      { label: "Parentesi [ ] non chiuse", hint: "Una [ senza ] (o viceversa) sulla stessa riga. Da correggere a mano.", fixable: false },
    "encoding":      { label: "Caratteri strani (Ã¨, â€™…)", hint: "Accenti rovinati da un import. Correggibile in automatico.", fixable: true },
    "tidy":          { label: "Accordi scritti male", hint: "[SOL7], [ Do ], [Fa♯], [Do Sol]... Correggibile in automatico.", fixable: true },
    "duplicate":     { label: "Titoli doppi", hint: "Stesso titolo (ignorando accenti e punteggiatura) in più canzoni.", fixable: false },
    "empty":         { label: "Vuote", hint: "Senza testo.", fixable: false },
    "no-chords":     { label: "Senza accordi", hint: "Solo testo.", fixable: false },
};

const normTitle = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();

export function diagnoseSong(song) {
    const issues = [];
    const lyrics = (song.lyrics || "").replace(/\r\n?/g, "\n");
    if (lyrics.trim().length <= 5) { issues.push({ code: "empty", detail: "" }); return issues; }

    const lines = lyrics.split("\n");
    const above = lines.filter(l => parseChordLine(expandTabs(l.replace(/\u00A0/g, " ")))).length;
    if (above) issues.push({ code: "chords-above", detail: above === 1 ? "1 riga" : `${above} righe` });

    const unknown = new Set();
    let badBrackets = 0;
    lines.forEach(l => {
        const opens = (l.match(/\[/g) || []).length, closes = (l.match(/\]/g) || []).length;
        if (opens !== closes || /\[[^\]]*\[/.test(l)) badBrackets++;
        for (const m of l.matchAll(/\[([^\[\]]*)\]/g)) {
            const inner = m[1].trim();
            if (!inner || RE_BRACKET_NOTE.test(inner)) continue;
            const parts = inner.split(/\s+/);
            if (!parts.every(p => isBracketChord(p))) unknown.add(`[${m[1]}]`);
        }
    });
    if (unknown.size) issues.push({ code: "unknown-chord", detail: [...unknown].slice(0, 6).join(" ") });
    if (badBrackets) issues.push({ code: "brackets", detail: badBrackets === 1 ? "1 riga" : `${badBrackets} righe` });
    if (hasBrokenEncoding(lyrics)) issues.push({ code: "encoding", detail: "" });

    const fixed = fixLyrics(lyrics);
    if (fixed.changes.chordsTidied || fixed.changes.splitBrackets) {
        issues.push({ code: "tidy", detail: `${fixed.changes.chordsTidied + fixed.changes.splitBrackets} accordi` });
    }
    if (!above && !lyrics.includes("[")) issues.push({ code: "no-chords", detail: "" });
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
        if (list.length > 1) list.forEach(s => report.duplicate.push({
            song: s, detail: list.filter(o => o !== s).map(o => o.category).join(", ") || ""
        }));
    });
    return report;
}

// La correzione automatica cambia qualcosa di sostanziale (non solo spazi)?
export function isAutoFixable(song) {
    const { changes } = fixLyrics(song.lyrics || "");
    return changes.chordLines + changes.chordsTidied + changes.encoding + changes.splitBrackets > 0;
}
