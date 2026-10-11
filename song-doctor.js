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

// --- TONALITÀ E ACCORDI FUORI TONALITÀ ---------------------------------------------
//
// Ogni accordo diventa (radice 0-11, tipo). Per ognuna delle 12 tonalità maggiori k
// (la relativa minore ha gli stessi accordi) si contano gli accordi che le appartengono:
//   diatonici:        I(k) ii(k+2,m) iii(k+4,m) IV(k+5) V(k+7) vi(k+9,m) vii°(k+11,dim)   peso 1
//   prestiti comuni:  II(k+2) = V/V,  III(k+4) = V/vi (anche il V del minore),
//                     VI(k+9) = V/ii, bVII(k+10), iv(k+5,m)                            peso 0,5
// Vince la tonalità col punteggio più alto; gli accordi che non stanno in nessuna delle due
// liste sono "sospetti". Non dice se un accordo è giusto: dice solo che è insolito.

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const KEY_NAMES = ["Do", "Reb", "Re", "Mib", "Mi", "Fa", "Fa#", "Sol", "Lab", "La", "Sib", "Si"];

// "Lam7" -> { pc: 9, q: "m" }, "Do7" -> { pc: 0, q: "M" }, "Sib/Re" -> { pc: 10, q: "M" }
export function chordToPc(raw) {
    let c = tidyChord(raw);
    const slash = c.indexOf("/");
    if (slash > 0) c = c.slice(0, slash);
    // Fadd9 / Faug sono accordi inglesi; il resto Do/Re/Mi... -> C/D/E...
    if (!/^F(add|aug)/.test(c)) c = c.replace(/^(Do|Re|Mi|Fa|Sol|La|Si)/, r => ({ Do: "C", Re: "D", Mi: "E", Fa: "F", Sol: "G", La: "A", Si: "B" })[r]);
    const m = c.match(/^([A-G])([#b]?)(.*)$/);
    if (!m) return null;
    const pc = (PC[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12;
    const suf = m[3];
    let q = "M";
    if (/^(dim|°|ø|m7b5|m7-5)/.test(suf)) q = "dim";
    else if (/^(m(?!aj)|min|-)/.test(suf)) q = "m";
    else if (/^sus/.test(suf)) q = "sus";
    else if (/^5$/.test(suf)) q = "5";
    return { pc, q };
}

function fitWeight(k, { pc, q }) {
    const d = (pc - k + 12) % 12;
    if (q === "M") return [0, 5, 7].includes(d) ? 1 : [2, 4, 9, 10].includes(d) ? 0.5 : 0;
    if (q === "m") return [2, 4, 9].includes(d) ? 1 : d === 5 ? 0.5 : 0;
    if (q === "dim") return d === 11 ? 1 : [1, 6, 8].includes(d) ? 0.5 : 0; // vii°, e i diminuiti di passaggio più comuni
    if (q === "sus" || q === "5") return [0, 2, 5, 7, 9].includes(d) ? 1 : 0;
    return 0;
}

// Tutti gli accordi della canzone, sia tra [ ] sia sulle righe di soli accordi
export function collectChords(lyrics) {
    const out = [];
    (lyrics || "").replace(/\r\n?/g, "\n").split("\n").forEach(l => {
        const line = expandTabs(l.replace(/ /g, " "));
        const parsed = parseChordLine(line);
        if (parsed) {
            parsed.tokens.filter(t => t.kind === "chord").forEach(t => out.push(t.text.replace(/^\(|\)$/g, "")));
            return;
        }
        for (const m of line.matchAll(/\[([^\[\]]*)\]/g)) {
            const inner = m[1].trim();
            if (!inner || RE_BRACKET_NOTE.test(inner)) continue;
            inner.split(/\s+/).filter(p => isBracketChord(p)).forEach(p => out.push(p));
        }
    });
    return out;
}

export function analyzeKey(lyrics) {
    const names = collectChords(lyrics);
    const parsed = names.map(n => ({ name: tidyChord(n), ...chordToPc(n) })).filter(x => x.pc !== undefined);
    if (parsed.length < 4) return null;

    let best = null;
    for (let k = 0; k < 12; k++) {
        let score = parsed.reduce((t, c) => t + fitWeight(k, c), 0);
        const first = parsed[0];
        if (first.pc === k && first.q === "M") score += 0.5;          // inizia sul I
        if (first.pc === (k + 9) % 12 && first.q === "m") score += 0.5; // inizia sul vi (canzone in minore)
        if (!best || score > best.score) best = { k, score };
    }
    const k = best.k;
    const firstIsMinorTonic = parsed[0].pc === (k + 9) % 12 && parsed[0].q === "m";
    const keyName = firstIsMinorTonic ? KEY_NAMES[(k + 9) % 12] + "m" : KEY_NAMES[k];

    const outside = new Map();
    let inKey = 0;
    parsed.forEach(c => {
        if (fitWeight(k, c) > 0) inKey++;
        else outside.set(c.name, (outside.get(c.name) || 0) + 1);
    });

    // In tonalità con i bemolli (Fa, Sib, Mib, Lab, Reb e le loro relative) La# si scrive Sib, ecc.
    const FLAT_KEYS = [1, 3, 5, 8, 10];
    const spelling = new Set();
    if (FLAT_KEYS.includes(k)) parsed.forEach(c => { if (/#/.test(c.name)) spelling.add(c.name); });

    return {
        key: keyName,
        fit: inKey / parsed.length,
        total: parsed.length,
        outside: [...outside.entries()].map(([chord, count]) => ({ chord, count })),
        spelling: [...spelling],
    };
}

// Insieme degli accordi (come sono scritti) da evidenziare nell'anteprima
export function suspiciousChords(lyrics) {
    const a = analyzeKey(lyrics);
    return a && a.fit >= 0.6 ? new Set(a.outside.map(o => o.chord)) : new Set();
}

// --- DIAGNOSI -------------------------------------------------------------------

export const ISSUES = {
    "chords-above":  { label: "Accordi su riga separata", hint: "Non si traspongono e si disallineano. Correggibile in automatico.", fixable: true },
    "unknown-chord": { label: "Accordi non riconosciuti", hint: "Contenuto tra [ ] che non è un accordo valido. Da correggere a mano.", fixable: false },
    "brackets":      { label: "Parentesi [ ] non chiuse", hint: "Una [ senza ] (o viceversa) sulla stessa riga. Da correggere a mano.", fixable: false },
    "encoding":      { label: "Caratteri strani (Ã¨, â€™…)", hint: "Accenti rovinati da un import. Correggibile in automatico.", fixable: true },
    "tidy":          { label: "Accordi scritti male", hint: "[SOL7], [ Do ], [Fa♯], [Do Sol]... Correggibile in automatico.", fixable: true },
    "off-key":       { label: "Accordi fuori tonalità", hint: "Accordi che non stanno nella tonalità della canzone: spesso sono errori di battitura (manca una m, # al posto di m...). Nell'editor sono sottolineati in rosso. Da controllare a orecchio: possono anche essere giusti.", fixable: false },
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
    const key = analyzeKey(lyrics);
    if (key && key.fit >= 0.6 && key.outside.length) {
        issues.push({ code: "off-key", detail: `in ${key.key}: ` + key.outside.map(o => o.count > 1 ? `${o.chord} ×${o.count}` : o.chord).join(", ") });
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
