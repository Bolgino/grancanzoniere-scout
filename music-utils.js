const SCALA = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

const MAPPA_ITA_TO_ENG = {"Do":"C","Re":"D","Mi":"E","Fa":"F","Sol":"G","La":"A","Si":"B"};

const MAPPA_ENG_TO_ITA = {
    "C": "Do", "C#": "Do#", "Db": "Reb",
    "D": "Re", "D#": "Re#", "Eb": "Mib",
    "E": "Mi",
    "F": "Fa", "F#": "Fa#", "Gb": "Solb",
    "G": "Sol", "G#": "Sol#", "Ab": "Lab",
    "A": "La", "A#": "La#", "Bb": "Sib",
    "B": "Si"
};

export function extractChords(t) {
    const m = t.match(/\[(.*?)\]/g);
    return m ? m.map(x => x.replace(/[\[\]]/g,'')) : [];
}

export function normalizeChord(c) {
    c = c.trim();
    for (let [ita, eng] of Object.entries(MAPPA_ITA_TO_ENG)) {
        if (c.startsWith(ita)) {
            c = c.replace(ita, eng);
            break; 
        }
    }
    return c;
}

export function transposeChord(c, s) {
    let m = c.match(/^([A-G][#b]?)(.*)$/);
    if (!m) return c; 
    let r = m[1], suf = m[2];

    if (r.endsWith("b")) {
        let idx = SCALA.indexOf(r[0]) - 1;
        r = SCALA[idx < 0 ? 11 : idx];
    }

    let idx = SCALA.indexOf(r);
    if (idx === -1) return c;
    
    let n = (idx + s) % 12;
    if (n < 0) n += 12;

    let newNoteEng = SCALA[n];
    let newNoteIta = MAPPA_ENG_TO_ITA[newNoteEng] || newNoteEng;

    return newNoteIta + suf;
}