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

// Radice italiana in qualsiasi maiuscolo/minuscolo: Do, DO, do, Sol, SOL...
const RE_ROOT_ITA = /^(do|re|mi|fa|sol|la|si)/i;

export function extractChords(t) {
    const m = (t || "").match(/\[(.*?)\]/g);
    return m ? m.map(x => x.replace(/[\[\]]/g,'')) : [];
}

// Converte una singola nota (senza suffisso) da italiano a inglese, se serve
function notaItaToEng(n) {
    // "Fadd9" / "Faug" sono accordi inglesi (F add9), non "Fa" + "dd9"
    if (/^F(add|aug)/.test(n)) return n;
    const m = n.match(RE_ROOT_ITA);
    if (!m) return n;
    return MAPPA_ITA_TO_ENG[m[1].toLowerCase()] + n.slice(m[1].length);
}

export function normalizeChord(c) {
    c = c.trim();
    // Gestisce anche il basso: "Do/Mi" -> "C/E", "LAm/SOL" -> "Am/G"
    const slash = c.indexOf("/");
    if (slash > 0) {
        return notaItaToEng(c.slice(0, slash)) + "/" + notaItaToEng(c.slice(slash + 1));
    }
    return notaItaToEng(c);
}

function transposeNote(r, s) {
    // Senza trasposizione lascia la nota com'è scritta (Sib resta Sib, non La#)
    if (s % 12 === 0 && MAPPA_ENG_TO_ITA[r]) return MAPPA_ENG_TO_ITA[r];
    if (r.endsWith("b")) {
        let idx = SCALA.indexOf(r[0]) - 1;
        r = SCALA[idx < 0 ? 11 : idx];
    }
    let idx = SCALA.indexOf(r);
    if (idx === -1) return null;
    let n = (idx + s) % 12;
    if (n < 0) n += 12;
    const eng = SCALA[n];
    return MAPPA_ENG_TO_ITA[eng] || eng;
}

export function transposeChord(c, s) {
    // Separa l'eventuale basso ("C/E") così viene trasposto anche quello
    let bass = "";
    const slash = c.indexOf("/");
    if (slash > 0) { bass = c.slice(slash + 1); c = c.slice(0, slash); }

    let m = c.match(/^([A-G][#b]?)(.*)$/);
    if (!m) return bass ? c + "/" + bass : c;

    const root = transposeNote(m[1], s);
    if (root === null) return bass ? c + "/" + bass : c;
    let out = root + m[2];

    if (bass) {
        const mb = bass.match(/^([A-G][#b]?)(.*)$/);
        const nb = mb ? transposeNote(mb[1], s) : null;
        out += "/" + (nb !== null ? nb + mb[2] : bass);
    }
    return out;
}
