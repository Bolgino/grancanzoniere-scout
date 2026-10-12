// tags.js — etichette per momento e branca, con proposte automatiche per l'admin.
// Le proposte guardano sezione, titolo, autore e parole del testo; ognuna ha un motivo e un grado di sicurezza.

export const TAG_GROUPS = [
    { id: "messa", label: "Messa", tags: [
        ["messa-ingresso", "Ingresso"], ["messa-penitenziale", "Atto penitenziale"], ["messa-gloria", "Gloria"],
        ["messa-salmo", "Salmo"], ["messa-alleluia", "Alleluia"], ["messa-offertorio", "Offertorio"],
        ["messa-santo", "Santo"], ["messa-agnello", "Agnello di Dio"], ["messa-comunione", "Comunione"],
        ["messa-finale", "Canto finale"], ["mariano", "Mariano"],
    ] },
    { id: "momento", label: "Momento", tags: [
        ["bans", "Bans"], ["fuoco", "Fuoco"], ["strada", "Strada"], ["preghiera", "Preghiera / veglia"], ["scout", "Canti scout"],
    ] },
    { id: "branca", label: "Branca", tags: [["lc", "L/C"], ["eg", "E/G"], ["rs", "R/S"]] },
];
export const TAG_LABEL = Object.fromEntries(TAG_GROUPS.flatMap(g => g.tags));
export const ALL_TAGS = TAG_GROUPS.flatMap(g => g.tags.map(([k]) => k));

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[’'`]/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const has = (text, word) => (" " + text + " ").includes(" " + word + " ");

// Parole del testo per ogni momento della Messa (contano le parole diverse trovate)
const MASS_WORDS = {
    "messa-ingresso": ["venite", "radunati", "insieme", "lodate", "lodiamo", "cantate", "cantiamo", "popolo", "festa", "casa del signore", "entrate", "veniamo", "acclamate", "esultate", "giubilo"],
    "messa-penitenziale": ["signore pieta", "cristo pieta", "kyrie", "eleison", "perdono", "perdonaci", "abbi pieta"],
    "messa-gloria": ["gloria a dio", "alto dei cieli", "pace in terra", "ti lodiamo", "ti benediciamo", "ti adoriamo", "ti glorifichiamo"],
    "messa-alleluia": ["alleluia", "parola", "vangelo", "lampada ai miei passi"],
    "messa-offertorio": ["pane", "vino", "frutto della terra", "frutto della vite", "offriamo", "offerta", "doni", "ti presentiamo", "benedetto sei tu", "accetta", "ti offro", "lavoro dell uomo", "grano", "spiga"],
    "messa-santo": ["santo santo santo", "osanna", "benedetto colui che viene", "i cieli e la terra"],
    "messa-agnello": ["agnello di dio", "togli i peccati del mondo", "dona a noi la pace"],
    "messa-comunione": ["corpo", "sangue", "pane di vita", "pane del cielo", "pane vivo", "cena", "mangiate", "mangia", "comunione", "ti ricevo", "io sono il pane", "spezzato", "calice", "banchetto", "dimora", "rimanete in me", "tu sei con noi"],
    "messa-finale": ["andate", "missione", "annunciare", "annunciate", "testimoni", "inviati", "nel mondo intero", "ovunque", "partiamo"],
    "mariano": ["maria", "ave", "madre", "vergine", "magnificat", "piena di grazia", "regina"],
};
const RELIGIOUS = ["signore", "dio", "gesu", "cristo", "spirito", "alleluia", "padre", "santo", "osanna", "amen", "preghiera", "cielo", "salvatore", "maria", "croce", "risorto"];
const STRADA = ["strada", "cammino", "camminare", "cammina", "zaino", "sentiero", "passo", "passi", "partire", "partenza", "montagna", "monti", "vetta", "marcia", "pellegrino", "route", "orizzonte", "vento", "andare", "via"];
const SCOUT = ["scout", "promessa", "reparto", "squadriglia", "jamboree", "akela", "lupetti", "branco", "clan", "baden powell", "fuoco di bivacco", "bivacco", "fazzolettone", "giglio", "trifoglio", "lupo", "estote parati", "del nostro meglio", "buona caccia", "buona strada"];
const LC = ["lupetti", "lupetto", "branco", "akela", "giungla", "mowgli", "bagheera", "baloo", "kaa", "coccinelle", "coccinella", "cerchio", "arcanda", "fratellino", "sorellina", "rupe"];
const EG = ["reparto", "squadriglia", "esploratori", "esploratore", "guide", "campo", "tenda", "avventura", "impresa", "alta squadriglia"];
const RS = ["clan", "fuoco", "noviziato", "servizio", "comunita", "partenza", "scelta", "route", "strada", "carta di clan"];
// Cantautori e band: canzoni da fuoco (e più da R/S)
const SONGWRITERS = ["de gregori", "guccini", "de andre", "battisti", "dalla", "battiato", "vasco", "ligabue", "jovanotti", "venditti",
    "bennato", "baglioni", "fossati", "gaber", "jannacci", "modugno", "tenco", "lauzi", "branduardi", "nomadi", "pooh", "cohen", "dylan",
    "beatles", "marley", "simon", "garfunkel", "queen", "u2", "oasis", "coldplay", "sheeran", "pezzali", "883", "negramaro", "moda",
    "elisa", "mannoia", "morandi", "celentano", "ramazzotti", "pausini", "zucchero", "pino daniele", "ron", "mia martini", "rino gaetano",
    "max gazze", "silvestri", "fabi", "cremonini", "lunapop", "renga", "tiromancino", "subsonica", "vecchioni", "conte", "endrigo",
    "mengoni", "ultimo", "brunori", "calcutta", "thegiornalisti", "gazzelle", "coez", "nek", "britti", "carboni", "bersani", "dik dik",
    "equipe 84", "camaleonti", "giorgia", "cocciante", "baccini", "concato", "ruggeri", "kings of convenience", "john denver", "eagles",
    "cat stevens", "neil young", "bob", "springsteen", "elvis", "abba", "bee gees", "toto", "dire straits", "mumford", "lumineers",
    "avicii", "imagine dragons", "the cranberries", "r e m", "green day", "bon jovi", "pink floyd", "led zeppelin", "rolling stones"];

function countWords(text, words) { return words.filter(w => has(text, w)).length; }

// Proposte per una canzone: [{ tag, sure, why }] (sure = abbastanza sicura da accettare in blocco)
export function suggestTags(song) {
    const title = norm(song.title), author = norm(song.author), cat = norm(song.category);
    const lyrics = norm(String(song.lyrics || "").replace(/\[[^\]]*\]/g, " "));
    const all = title + " " + lyrics;
    const out = new Map();
    const add = (tag, sure, why) => { const o = out.get(tag); if (!o || (sure && !o.sure)) out.set(tag, { tag, sure, why }); };

    // 1. Sezione
    const liturgical = /liturg|messa|chiesa|religios|spiritual|sacr|celebraz/.test(cat);
    if (/bans/.test(cat)) add("bans", true, `sezione "${song.category}"`);
    if (/fuoco|bivacco|serata/.test(cat)) add("fuoco", true, `sezione "${song.category}"`);
    if (/strada|marci|route|hike|cammin/.test(cat)) add("strada", true, `sezione "${song.category}"`);
    if (/scout|tradizional|promessa/.test(cat)) add("scout", true, `sezione "${song.category}"`);
    if (/marian|maria/.test(cat)) add("mariano", true, `sezione "${song.category}"`);
    if (/preghier|veglia|adoraz/.test(cat)) add("preghiera", true, `sezione "${song.category}"`);
    if (/lupett|coccinell|branco|\blc\b|l c/.test(cat)) add("lc", true, `sezione "${song.category}"`);
    if (/reparto|esplorator|guide|\beg\b|e g/.test(cat)) add("eg", true, `sezione "${song.category}"`);
    if (/clan|rover|scolte|noviziato|\brs\b|r s/.test(cat)) add("rs", true, `sezione "${song.category}"`);
    if (/cantautor|italian|pop|rock|stranier|inglese|english|canzoni/.test(cat)) add("fuoco", false, `sezione "${song.category}"`);

    // 2. Momenti della Messa: titolo (sicuro) o parole del testo (probabile)
    const religious = liturgical || countWords(all, RELIGIOUS) >= 2;
    const titleRules = [
        ["messa-gloria", /^gloria\b/], ["messa-santo", /^santo\b|^osanna\b/], ["messa-agnello", /agnello di dio/],
        ["messa-penitenziale", /signore pieta|kyrie|atto penitenziale/], ["messa-salmo", /^salmo\b/],
        ["messa-alleluia", /\balleluia\b/], ["mariano", /\bave maria\b|\bmagnificat\b|\bmaria\b|\bmadre\b/],
        ["messa-offertorio", /offertorio|offriamo|\bpane e vino\b/], ["messa-comunione", /comunione|pane di vita|\bpane del cielo\b/],
    ];
    const cover = /cohen|buckley|hallelujah/.test(author + " " + title);   // "Hallelujah" di Cohen non è un canto della Messa
    if (religious && !cover) {
        titleRules.forEach(([tag, re]) => { if (re.test(title)) add(tag, true, "titolo"); });
        const scored = Object.entries(MASS_WORDS).map(([tag, words]) => {
            const hits = words.filter(w => has(lyrics, w));
            return { tag, n: hits.length, hits };
        }).filter(x => x.n >= 2).sort((a, b) => b.n - a.n);
        scored.slice(0, 2).forEach((x, i) => add(x.tag, x.n >= 4 && i === 0 && liturgical, `nel testo: ${x.hits.slice(0, 3).join(", ")}`));
        if (!liturgical && !out.size && countWords(all, RELIGIOUS) >= 3) add("preghiera", false, "testo religioso");
    }

    // 3. Bans, scout, strada, fuoco
    if (/^bans\b|\bbans\b/.test(title)) add("bans", true, "titolo");
    const scoutHits = SCOUT.filter(w => has(all, w));
    if (scoutHits.length >= 2 || /promessa|addio|jamboree|bivacco|akela/.test(title)) add("scout", scoutHits.length >= 3 || /promessa|jamboree|akela/.test(title), `parole scout: ${scoutHits.slice(0, 3).join(", ") || "titolo"}`);
    const stradaHits = STRADA.filter(w => has(all, w));
    if (stradaHits.length >= 3) add("strada", stradaHits.length >= 5, `nel testo: ${stradaHits.slice(0, 3).join(", ")}`);
    const writer = SONGWRITERS.find(w => has(author, w));
    if (writer && !liturgical) { add("fuoco", true, `autore: ${song.author}`); add("rs", false, `cantautore (${song.author})`); }
    else if (!religious && !out.has("bans") && !liturgical && lyrics.length > 200) add("fuoco", false, "canzone non liturgica");

    // 4. Branca dalle parole del testo
    const lc = LC.filter(w => has(all, w)), eg = EG.filter(w => has(all, w)), rs = RS.filter(w => has(all, w));
    if (lc.length) add("lc", lc.length >= 2, `parole L/C: ${lc.slice(0, 3).join(", ")}`);
    if (eg.length >= 2) add("eg", eg.length >= 3, `parole E/G: ${eg.slice(0, 3).join(", ")}`);
    if (rs.length >= 2) add("rs", rs.length >= 3, `parole R/S: ${rs.slice(0, 3).join(", ")}`);
    if (out.has("bans") && !lc.length && !eg.length) { add("lc", false, "i bans si fanno soprattutto con L/C ed E/G"); add("eg", false, "i bans si fanno soprattutto con L/C ed E/G"); }

    return [...out.values()].filter(s => ALL_TAGS.includes(s.tag));
}

// Proposte che non sono già tra le etichette della canzone
export function pendingSuggestions(song) {
    const current = new Set(song.tags || []);
    return suggestTags(song).filter(s => !current.has(s.tag));
}
