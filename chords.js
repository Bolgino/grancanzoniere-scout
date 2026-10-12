// chords.js — note degli accordi, diteggiature per chitarra e ukulele, diagrammi SVG e capotasto consigliato.
// Solo funzioni "pure": si possono provare da sole.
import { parseChord, normalizeChord, transposeChord } from "./music-utils.js";

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES_SHARP = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];
const NAMES_FLAT = ["Do", "Reb", "Re", "Mib", "Mi", "Fa", "Solb", "Sol", "Lab", "La", "Sib", "Si"];

const pcOf = (eng) => (PC[eng[0]] + (eng[1] === "#" ? 1 : eng[1] === "b" ? -1 : 0) + 12) % 12;

// --- TIPO DI ACCORDO E INTERVALLI ---------------------------------------------------------------
// Il suffisso (m, 7, maj7, sus4...) diventa un tipo noto e una lista di intervalli in semitoni.
// Notazione italiana: "7+" = settima maggiore (Do7+ = Domaj7); "+" da solo = aumentato.
const TYPE_BY_SUFFIX = {
    "": "", "M": "", "maj": "",
    "m": "m", "-": "m", "min": "m",
    "7": "7", "m7": "m7", "-7": "m7", "min7": "m7",
    "maj7": "maj7", "M7": "maj7", "7+": "maj7", "Δ": "maj7", "Δ7": "maj7", "7M": "maj7",
    "sus4": "sus4", "sus": "sus4", "4": "sus4", "sus2": "sus2", "2": "sus2",
    "6": "6", "m6": "m6", "-6": "m6",
    "7sus4": "7sus4", "7sus": "7sus4", "74": "7sus4",
    "add9": "add9", "add2": "add9", "(add9)": "add9", "9": "9",
    "dim": "dim", "°": "dim", "dim7": "dim7", "°7": "dim7",
    "aug": "aug", "+": "aug", "+5": "aug", "(#5)": "aug",
    "m7b5": "m7b5", "m7-5": "m7b5", "ø": "m7b5", "ø7": "m7b5", "-7b5": "m7b5",
    "5": "5",
};
const INTERVALS = {
    "": [0, 4, 7], "m": [0, 3, 7], "7": [0, 4, 7, 10], "m7": [0, 3, 7, 10], "maj7": [0, 4, 7, 11],
    "sus4": [0, 5, 7], "sus2": [0, 2, 7], "6": [0, 4, 7, 9], "m6": [0, 3, 7, 9], "7sus4": [0, 5, 7, 10],
    "add9": [0, 4, 7, 2], "9": [0, 4, 7, 10, 2], "dim": [0, 3, 6], "dim7": [0, 3, 6, 9], "aug": [0, 4, 8],
    "m7b5": [0, 3, 6, 10], "5": [0, 7],
};
// Intervalli per suffissi non in tabella (m9, maj9, 11, 13, 7b9...): li costruisco pezzo per pezzo
function intervalsFromSuffix(suf) {
    let s = suf, third = 4, fifth = 7;
    const extra = new Set();
    if (/^(m(?!aj)|min|-)/.test(s)) { third = 3; s = s.replace(/^(min|m|-)/, ""); }
    if (/^(dim|°)/.test(s)) { third = 3; fifth = 6; s = s.replace(/^(dim|°)/, ""); if (/^7/.test(s)) { extra.add(9); s = s.slice(1); } }
    if (/^(aug|\+)/.test(s)) { fifth = 8; s = s.replace(/^(aug|\+)/, ""); }
    if (/maj7|M7|7\+|Δ/.test(s)) { extra.add(11); s = s.replace(/maj7|M7|7\+|Δ7?/, ""); }
    if (/maj9|M9/.test(s)) { extra.add(11); extra.add(2); s = s.replace(/maj9|M9/, ""); }
    if (/13/.test(s)) { extra.add(10); extra.add(9); s = s.replace("13", ""); }
    if (/11/.test(s)) { extra.add(10); extra.add(5); s = s.replace("11", ""); }
    if (/(^|[^d])9/.test(s)) { if (!extra.has(11)) extra.add(10); extra.add(2); s = s.replace("9", ""); }
    if (/7/.test(s)) { extra.add(10); s = s.replace("7", ""); }
    if (/6/.test(s)) { extra.add(9); s = s.replace("6", ""); }
    if (/sus4|sus/.test(s)) { third = 5; s = s.replace(/sus4?/, ""); }
    if (/sus2/.test(s)) { third = 2; s = s.replace("sus2", ""); }
    if (/add9|add2/.test(s)) { extra.add(2); }
    if (/b5|-5/.test(s)) fifth = 6;
    if (/#5/.test(s)) fifth = 8;
    if (/b9/.test(s)) extra.add(1);
    return [0, third, fifth, ...extra];
}

// "Lam7/Sol" -> { root, bass, tones:[pc...], type, name, notes:["La","Do","Mi","Sol"] } | null
export function chordInfo(raw) {
    const p = parseChord(raw);
    if (!p) return null;
    const root = pcOf(p.root);
    const suf = p.suffix;
    const type = Object.prototype.hasOwnProperty.call(TYPE_BY_SUFFIX, suf) ? TYPE_BY_SUFFIX[suf] : null;
    const ints = type !== null ? INTERVALS[type] : intervalsFromSuffix(suf);
    const flat = /b$/.test(p.root) || [3, 5, 8, 10].includes(root);   // Mib, Fa, Lab, Sib... scritti coi bemolli
    const names = flat ? NAMES_FLAT : NAMES_SHARP;
    const tones = [...new Set(ints.map(i => (root + i) % 12))];
    let bass = root;
    if (p.bass && p.bass.root) bass = pcOf(p.bass.root);
    return { root, bass, tones, ints, type, suffix: suf, notes: tones.map(t => names[t]), bassName: names[bass], slash: bass !== root };
}

// --- CHITARRA -------------------------------------------------------------------------------------
// Corde dalla 6ª (Mi basso) alla 1ª (Mi cantino). -1 = corda non suonata.
const GUITAR = [4, 9, 2, 7, 11, 4];
// Accordi aperti classici (quelli che si imparano per primi), per tipo e radice
const G_OPEN = {
    "":     { 0: [-1,3,2,0,1,0], 2: [-1,-1,0,2,3,2], 4: [0,2,2,1,0,0], 5: [1,3,3,2,1,1], 7: [3,2,0,0,0,3], 9: [-1,0,2,2,2,0] },
    "m":    { 9: [-1,0,2,2,1,0], 4: [0,2,2,0,0,0], 2: [-1,-1,0,2,3,1] },
    "7":    { 9: [-1,0,2,0,2,0], 11: [-1,2,1,2,0,2], 0: [-1,3,2,3,1,0], 2: [-1,-1,0,2,1,2], 4: [0,2,0,1,0,0], 7: [3,2,0,0,0,1] },
    "m7":   { 9: [-1,0,2,0,1,0], 4: [0,2,0,0,0,0], 2: [-1,-1,0,2,1,1], 11: [-1,2,0,2,0,2] },
    "maj7": { 0: [-1,3,2,0,0,0], 2: [-1,-1,0,2,2,2], 4: [0,2,1,1,0,0], 5: [-1,-1,3,2,1,0], 7: [3,2,0,0,0,2], 9: [-1,0,2,1,2,0] },
    "sus4": { 9: [-1,0,2,2,3,0], 2: [-1,-1,0,2,3,3], 4: [0,2,2,2,0,0], 0: [-1,3,3,0,1,1], 7: [3,3,0,0,1,3] },
    "sus2": { 9: [-1,0,2,2,0,0], 2: [-1,-1,0,2,3,0], 4: [0,2,4,4,0,0], 0: [-1,3,0,0,1,3], 7: [3,0,0,0,3,3] },
    "6":    { 0: [-1,3,2,2,1,0], 2: [-1,-1,0,2,0,2], 4: [0,2,2,1,2,0], 7: [3,2,0,0,0,0], 9: [-1,0,2,2,2,2] },
    "m6":   { 9: [-1,0,2,2,1,2], 2: [-1,-1,0,2,0,1], 4: [0,2,2,0,2,0] },
    "7sus4":{ 9: [-1,0,2,0,3,0], 2: [-1,-1,0,2,1,3], 4: [0,2,0,2,0,0], 7: [3,3,0,0,1,1] },
    "add9": { 0: [-1,3,2,0,3,0], 7: [3,0,0,2,0,3], 4: [0,2,2,1,0,2], 9: [-1,0,2,4,2,0] },
    "9":    { 4: [0,2,0,1,0,2], 0: [-1,3,2,3,3,3], 2: [-1,-1,0,2,1,0], 7: [3,-1,0,2,0,1] },
    "dim7": { 9: [-1,0,1,2,1,2] },
    "aug":  { 0: [-1,3,2,1,1,0], 4: [0,3,2,1,1,0], 7: [3,2,1,0,0,3], 9: [-1,0,3,2,2,1] },
};
// "Fa piccolo" e simili: alternative facili per chi non sa ancora fare il barrè
const G_EASY_ALT = { "": { 5: [-1,-1,3,2,1,1] } };
// Forme mobili (barrè): radice sulla 6ª corda (forma di Mi) o sulla 5ª (forma di La). null = non suonata
const G_SHAPE_E = {
    "": [0,2,2,1,0,0], "m": [0,2,2,0,0,0], "7": [0,2,0,1,0,0], "m7": [0,2,0,0,0,0], "maj7": [0,2,1,1,0,0],
    "sus4": [0,2,2,2,0,0], "6": [0,2,2,1,2,0], "m6": [0,2,2,0,2,0], "7sus4": [0,2,0,2,0,0], "9": [0,2,0,1,0,2],
    "add9": [0,2,2,1,0,2], "aug": [0,3,2,1,1,0], "5": [0,2,2,null,null,null],
    "m7b5": [0,null,0,0,-1,null], "dim7": [0,null,-1,0,-1,null], "dim": [0,1,2,0,null,null],
};
const G_SHAPE_A = {
    "": [null,0,2,2,2,0], "m": [null,0,2,2,1,0], "7": [null,0,2,0,2,0], "m7": [null,0,2,0,1,0], "maj7": [null,0,2,1,2,0],
    "sus4": [null,0,2,2,3,0], "sus2": [null,0,2,2,0,0], "6": [null,0,2,2,2,2], "m6": [null,0,2,2,1,2], "7sus4": [null,0,2,0,3,0],
    "9": [null,0,-1,0,0,0], "add9": [null,0,2,4,2,0], "dim": [null,0,1,2,1,null], "dim7": [null,0,1,-1,1,null],
    "m7b5": [null,0,1,0,1,null], "5": [null,0,2,2,null,null],
};

function fromShape(shape, r) {
    if (shape.some(o => o !== null && r + o < 0)) return null;   // la forma non sta sul manico a questa altezza
    return shape.map(o => o === null ? -1 : r + o);
}
const sounding = (frets, tuning) => frets.map((f, i) => f < 0 ? null : (tuning[i] + f) % 12);

// Etichetta della diteggiatura: "aperto", "barrè 3ª", "5ª posizione"
function autoLabel(frets) {
    const { barre } = fingerCount(frets);
    if (barre) return `barrè ${barre.fret}ª`;
    const fretted = frets.filter(f => f > 0);
    const min = fretted.length ? Math.min(...fretted) : 0;
    return min > 3 ? `${min}ª posizione` : "aperto";
}

// Dita necessarie: le note alla stessa fret più bassa sulle corde più acute si fanno con un barrè
function fingerCount(frets) {
    const fretted = frets.map((f, i) => [f, i]).filter(([f]) => f > 0);
    if (!fretted.length) return { fingers: 0, barre: null };
    const min = Math.min(...fretted.map(([f]) => f));
    const atMin = fretted.filter(([f]) => f === min);
    // il barrè serve solo se le note da premere sono più di 4 (es. Fa 133211, Sim x24432)
    let barre = null;
    if (atMin.length >= 2 && fretted.length > 4) {
        const from = atMin[0][1];
        const ok = frets.slice(from).every(f => f >= min);   // nessuna corda vuota sotto il barrè
        if (ok) barre = { fret: min, from, to: frets.length - 1 };
    }
    const fingers = barre ? 1 + fretted.filter(([f]) => f > min).length : fretted.length;
    return { fingers, barre };
}

function voicingScore(frets, info, tuning) {
    const played = frets.filter(f => f >= 0);
    const fretted = played.filter(f => f > 0);
    const { fingers, barre } = fingerCount(frets);
    const min = fretted.length ? Math.min(...fretted) : 0, max = fretted.length ? Math.max(...fretted) : 0;
    const notes = new Set(sounding(frets, tuning).filter(x => x !== null));
    const missing = info.tones.filter((t, i) => !notes.has(t) && !(info.ints[i] === 7 && info.tones.length > 3)).length;
    return (max - min) * 1.5 + min * 0.8 + fingers + (barre ? 2.5 : 0) + missing * 6 + (frets.length - played.length) * 0.3
         - played.filter(f => f === 0).length * 0.4;
}

// Cerca una diteggiatura qualsiasi (accordi rari, accordi col basso: Do/Mi)
function searchVoicing(info, tuning, opts) {
    const n = tuning.length;
    let best = null, bestScore = Infinity;
    const must = new Set([info.root, info.tones[1]].filter(x => x !== undefined));
    info.ints.forEach((iv, i) => { if (iv === 10 || iv === 11 || iv === 9 || iv === 2 || iv === 6 || iv === 8) must.add(info.tones[i]); });
    for (let base = 0; base <= 9; base++) {
        const choices = [0];
        for (let f = Math.max(1, base); f <= base + 3; f++) choices.push(f);
        const frets = new Array(n).fill(-1);
        const rec = (i) => {
            if (i === n) {
                const played = frets.map((f, k) => [f, k]).filter(([f]) => f >= 0);
                if (played.length < Math.min(n, opts.minStrings)) return;
                if (opts.bassRule) {
                    const low = played[0][1];
                    if ((tuning[low] + frets[low]) % 12 !== info.bass) return;
                    // dopo la prima corda suonata niente corde mute
                    if (played.length !== n - low) return;
                }
                const notes = new Set(played.map(([f, k]) => (tuning[k] + f) % 12));
                for (const m of must) if (!notes.has(m)) return;
                const { fingers } = fingerCount(frets);
                if (fingers > 4) return;
                const sc = voicingScore(frets, info, tuning);
                if (sc < bestScore) { bestScore = sc; best = frets.slice(); }
                return;
            }
            const opt = opts.allowMute && i < opts.maxMuted ? [-1, ...choices] : choices;
            for (const f of opt) {
                if (f >= 0) {
                    const pcn = (tuning[i] + f) % 12;
                    if (!info.tones.includes(pcn) && pcn !== info.bass) continue;
                }
                frets[i] = f;
                rec(i + 1);
            }
            frets[i] = -1;
        };
        rec(0);
    }
    return best;
}

// Accordo più semplice da suonare quando quello scritto non ha una diteggiatura comoda: m9 -> m7 -> m
function simpler(raw) {
    const p = parseChord(raw);
    if (!p) return null;
    const steps = [[/(maj9|M9)$/, "maj7"], [/m(9|11|13)$/, "m7"], [/(9|11|13)$/, "7"], [/m7$/, "m"], [/7$/, ""], [/(add9|add2|6|sus2|sus4)$/, ""]];
    for (const [re, rep] of steps) if (re.test(p.suffix)) {
        const root = transposeChord(normalizeChord(raw).replace(/\/.*/, "").replace(p.suffix, ""), 0);
        return root + p.suffix.replace(re, rep);
    }
    return null;
}
const withFallback = (fn) => (raw) => {
    let r = fn(raw), name = raw, guard = 0;
    while (!r.length && guard++ < 3) { name = simpler(name); if (!name) break; r = fn(name).map(v => ({ ...v, label: `come ${name}` })); }
    return r;
};

// Diteggiature per chitarra, la più facile per prima (max 2)
export const guitarVoicings = withFallback(guitarVoicingsRaw);
function guitarVoicingsRaw(raw) {
    const info = chordInfo(raw);
    if (!info) return [];
    const out = [];
    const add = (f, label) => { if (f && !out.some(o => o.frets.join() === f.join())) out.push({ frets: f, label: label || autoLabel(f), ...fingerCount(f) }); };
    if (info.slash) {
        add(searchVoicing(info, GUITAR, { bassRule: true, allowMute: true, maxMuted: 3, minStrings: 4 }), `basso ${info.bassName}`);
    }
    const t = info.type;
    if (t !== null) {
        if (G_EASY_ALT[t] && G_EASY_ALT[t][info.root] && !info.slash) add(G_EASY_ALT[t][info.root], "facile, senza barrè");
        if (G_OPEN[t] && G_OPEN[t][info.root]) add(G_OPEN[t][info.root]);
        const rE = (info.root - 4 + 12) % 12, rA = (info.root - 9 + 12) % 12;
        const cands = [];
        if (G_SHAPE_E[t]) cands.push([fromShape(G_SHAPE_E[t], rE), rE]);
        if (G_SHAPE_A[t]) cands.push([fromShape(G_SHAPE_A[t], rA), rA]);
        cands.filter(([f]) => f).sort((a, b) => a[1] - b[1]).forEach(([f]) => add(f));
    }
    if (!out.length) add(searchVoicing(info, GUITAR, { bassRule: true, allowMute: true, maxMuted: 3, minStrings: 4 }));
    return out.slice(0, 2);
}

// --- UKULELE (Sol Do Mi La, la corda di Sol è acuta) --------------------------------------------
const UKE = [7, 0, 4, 9];
const U_OPEN = {
    "":    { 0:[0,0,0,3], 1:[1,1,1,4], 2:[2,2,2,0], 3:[0,3,3,1], 4:[1,4,0,2], 5:[2,0,1,0], 6:[3,1,2,1], 7:[0,2,3,2], 8:[5,3,4,3], 9:[2,1,0,0], 10:[3,2,1,1], 11:[4,3,2,2] },
    "m":   { 0:[0,3,3,3], 1:[1,1,0,4], 2:[2,2,1,0], 3:[3,3,2,1], 4:[0,4,3,2], 5:[1,0,1,3], 6:[2,1,2,0], 7:[0,2,3,1], 8:[4,3,4,2], 9:[2,0,0,0], 10:[3,1,1,1], 11:[4,2,2,2] },
    "7":   { 0:[0,0,0,1], 1:[1,1,1,2], 2:[2,2,2,3], 3:[3,3,3,4], 4:[1,2,0,2], 5:[2,3,1,3], 6:[3,4,2,4], 7:[0,2,1,2], 8:[1,3,2,3], 9:[0,1,0,0], 10:[1,2,1,1], 11:[2,3,2,2] },
    "m7":  { 0:[3,3,3,3], 1:[1,1,0,2], 2:[2,2,1,3], 3:[3,3,2,4], 4:[0,2,0,2], 5:[1,3,1,3], 6:[2,4,2,4], 7:[0,2,1,1], 8:[1,3,2,2], 9:[0,0,0,0], 10:[1,1,1,1], 11:[2,2,2,2] },
    "maj7":{ 0:[0,0,0,2], 2:[2,2,2,4], 4:[1,3,0,2], 5:[2,4,1,3], 7:[0,2,2,2], 9:[1,1,0,0], 10:[3,2,1,0] },
};
export const ukuleleVoicings = withFallback(ukuleleVoicingsRaw);
function ukuleleVoicingsRaw(raw) {
    const info = chordInfo(raw);
    if (!info) return [];
    const out = [];
    const add = (f, label) => { if (f && !out.some(o => o.frets.join() === f.join())) out.push({ frets: f, label, ...fingerCount(f) }); };
    if (info.type !== null && U_OPEN[info.type] && U_OPEN[info.type][info.root] !== undefined) add(U_OPEN[info.type][info.root], "");
    add(searchVoicing(info, UKE, { bassRule: false, allowMute: false, minStrings: 4 }), out.length ? "alternativa" : "");
    return out.slice(0, 2);
}

// --- DIAGRAMMA SVG -------------------------------------------------------------------------------
export function chordDiagramSvg(v, nStrings) {
    const frets = v.frets;
    const fretted = frets.filter(f => f > 0);
    const maxF = fretted.length ? Math.max(...fretted) : 0;
    const minF = fretted.length ? Math.min(...fretted) : 1;
    const start = maxF <= 4 ? 1 : minF;           // prima fret mostrata
    const W = nStrings === 6 ? 120 : 92, H = 150, left = 18, top = 30, rows = 5;
    const gapX = (W - left - 12) / (nStrings - 1), gapY = (H - top - 12) / rows;
    const x = (i) => left + i * gapX, y = (r) => top + r * gapY;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="chord-svg" role="img">`;
    // capotasto o numero della fret
    s += start === 1 ? `<rect x="${x(0) - 1}" y="${top - 4}" width="${x(nStrings - 1) - x(0) + 2}" height="4" fill="currentColor"/>`
                     : `<text x="${left - 6}" y="${y(0) + gapY * 0.65}" font-size="11" text-anchor="end" fill="currentColor">${start}</text>`;
    for (let r = 0; r <= rows; r++) s += `<line x1="${x(0)}" y1="${y(r)}" x2="${x(nStrings - 1)}" y2="${y(r)}" stroke="currentColor" stroke-opacity=".45"/>`;
    for (let i = 0; i < nStrings; i++) s += `<line x1="${x(i)}" y1="${y(0)}" x2="${x(i)}" y2="${y(rows)}" stroke="currentColor" stroke-opacity=".7"/>`;
    if (v.barre) {
        const r = v.barre.fret - start;
        s += `<rect x="${x(v.barre.from) - 6}" y="${y(r) + gapY / 2 - 6}" width="${x(v.barre.to) - x(v.barre.from) + 12}" height="12" rx="6" fill="var(--chord-color, #ff85c0)"/>`;
    }
    frets.forEach((f, i) => {
        if (f < 0) s += `<text x="${x(i)}" y="${top - 10}" font-size="12" text-anchor="middle" fill="currentColor" fill-opacity=".7">×</text>`;
        else if (f === 0) s += `<circle cx="${x(i)}" cy="${top - 14}" r="4" fill="none" stroke="currentColor"/>`;
        else if (!(v.barre && f === v.barre.fret && i >= v.barre.from)) s += `<circle cx="${x(i)}" cy="${y(f - start) + gapY / 2}" r="6" fill="var(--chord-color, #ff85c0)"/>`;
    });
    return s + `</svg>`;
}

// --- CAPOTASTO CONSIGLIATO -----------------------------------------------------------------------
// Difficoltà di una forma per chitarra (1 = facilissimo, 4 = barrè). Sono gli accordi aperti che si
// imparano per primi; tutto il resto richiede il barrè.
const EASY = {
    "": { 0: 1, 2: 1, 4: 1, 7: 1, 9: 1, 5: 2.5 },
    "m": { 9: 1, 4: 1, 2: 1, 11: 3 },
    "7": { 9: 1, 2: 1, 4: 1, 7: 1, 0: 1.5, 11: 2 },
    "m7": { 9: 1, 4: 1, 2: 1, 11: 2 },
    "maj7": { 0: 1.5, 2: 1.5, 4: 1.5, 5: 1.5, 7: 1.5, 9: 1.5 },
    "sus4": { 9: 1.5, 2: 1.5, 4: 1.5, 0: 2, 7: 2 },
    "sus2": { 9: 1.5, 2: 1.5, 4: 2, 0: 2, 7: 2 },
    "6": { 0: 1.5, 2: 1.5, 4: 1.5, 7: 1.5, 9: 1.5 },
    "m6": { 9: 1.5, 2: 1.5, 4: 1.5 },
    "7sus4": { 9: 1.5, 2: 1.5, 4: 1.5, 7: 1.5 },
    "add9": { 0: 1.5, 7: 2, 4: 2, 9: 2 },
    "9": { 4: 2, 2: 2, 7: 2.5 },
};
export function shapeDifficulty(raw) {
    const info = chordInfo(raw);
    if (!info) return 0;
    const table = info.type !== null ? EASY[info.type] : null;
    let d = table && table[info.root] !== undefined ? table[info.root]
          : ["dim", "dim7", "aug", "m7b5"].includes(info.type) ? 3 : 4;
    if (info.slash) d += 0.5;
    return d;
}

// chords: nomi degli accordi come si vedono (già trasposti) con quante volte compaiono.
// Prova il capotasto da 0 a 7 e restituisce le opzioni ordinate, con la migliore.
export function capoOptions(chordCounts) {
    const entries = Object.entries(chordCounts).filter(([c]) => chordInfo(c));
    const total = entries.reduce((t, [, n]) => t + n, 0);
    if (!total) return null;
    const options = [];
    for (let capo = 0; capo <= 7; capo++) {
        let sum = 0;
        const shapes = [];
        for (const [c, n] of entries) {
            const shape = transposeChord(normalizeChord(c), -capo);
            sum += shapeDifficulty(shape) * n;
            if (!shapes.includes(shape)) shapes.push(shape);
        }
        const avg = sum / total;
        const barre = shapes.filter(sh => shapeDifficulty(sh) >= 3).length;
        options.push({ capo, avg, score: avg + capo * 0.06, shapes, barre });
    }
    const best = options.slice().sort((a, b) => a.score - b.score)[0];
    const now = options[0];
    // conviene solo se è davvero più facile (meno barrè o difficoltà media più bassa di almeno 0,4)
    const suggested = best.capo !== 0 && (best.barre < now.barre || now.avg - best.avg >= 0.75) ? best : null;
    return { options, best, suggested, current: now };
}
