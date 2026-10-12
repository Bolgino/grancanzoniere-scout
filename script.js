import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getFirestore, collection, getDocs, getDocsFromCache, doc, updateDoc, addDoc, deleteDoc, writeBatch, arrayUnion, arrayRemove, enableMultiTabIndexedDbPersistence, onSnapshot, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, setPersistence, inMemoryPersistence } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { extractChords, normalizeChord, transposeChord } from "./music-utils.js";
import { scanSongs, fixLyrics, describeChanges, isAutoFixable, ISSUES, suspiciousChords, analyzeKey, tidyChord, layoutLine, chordDisplay, lineWithoutChords, classifyBracket, isSameSong, parseChordLine, parseBracketChordLine } from "./song-doctor.js";
import { notify, appConfirm, appPrompt, openSheet, closeAllSheets } from "./ui.js";
import { chordInfo, guitarVoicings, ukuleleVoicings, chordDiagramSvg, capoOptions } from "./chords.js";
import { TAG_GROUPS, TAG_LABEL, ALL_TAGS, suggestTags } from "./tags.js";
import { qrSvg } from "./qr.js";

// --- 1. FUNZIONI DI UTILITÀ ---
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Evita che un titolo o un testo con "<...>" venga eseguito come HTML (es. proposte degli ospiti)
function escapeHtml(str) {
    return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
window.escapeHtml = escapeHtml;

// Testo da mettere dentro onclick="...('${...}')": prima l'escape per la stringa JS, poi per l'attributo HTML.
// Senza, una sezione con l'apostrofo (es. "Canti dell'alba") non si apriva.
function jsArg(str) {
    return escapeHtml(String(str ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, "\\n"));
}
window.jsArg = jsArg;

// Unico renderer del testo con accordi (editor, proposta, revisione): costruisce la stringa e la scrive una volta sola.
//   suspects: { likely, unusual } accordi fuori tonalità da sottolineare (solo admin)
//   marks:    true = evidenzia anche refusi e accordi non riconosciuti (solo admin)
// Le annotazioni ([Rit.] [x2] [Chorus]) si scrivono in linea e restano visibili anche nascondendo gli accordi;
// due accordi troppo vicini ([Do][Sol]) vengono distanziati invece di sovrapporsi.
function lyricsToHtml(txt, transpose = 0, chordStyle = "", suspects = null, marks = false) {
    const likely = suspects && suspects.likely ? suspects.likely : (suspects instanceof Set ? suspects : null);
    const unusual = suspects && suspects.unusual ? suspects.unusual : null;
    return (txt || "").split("\n").map(l => {
        let line = layoutLine(l, transpose).map(seg => {
            if (seg.kind === "text") return escapeHtml(seg.text);
            if (seg.kind === "pad") return `<span class="chord-pad">${seg.text}</span>`;
            if (seg.kind === "note") return `<span class="chord-note">${escapeHtml(seg.text)}</span>`;
            let cls = "", attr = chordStyle;
            const name = tidyChord(seg.raw);
            const why = suspects && suspects.why ? suspects.why.get(name) : null;
            const data = ` data-chord="${escapeHtml(name)}"`;
            if (likely && likely.has(name)) { cls = " chord-suspect"; attr = ` title="${escapeHtml(why || "Probabile errore: controlla")}"` + data; }
            else if (unusual && unusual.has(name)) { cls = " chord-unusual"; attr = ` title="${escapeHtml(why || "Accordo insolito per questa tonalità")}"` + data; }
            else if (marks && seg.cls.kind === "typo") { cls = " chord-typo"; attr = ` title="Scritto: ${escapeHtml(seg.raw.trim())} (la bacchetta lo corregge)"` + ` data-chord="${escapeHtml(seg.raw.trim())}" data-fix="${escapeHtml(seg.cls.suggestion)}"`; }
            else if (marks && seg.cls.kind === "unknown") { cls = " chord-unknown"; attr = ' title="Accordo non riconosciuto"' + ` data-chord="${escapeHtml(seg.raw.trim())}"`; }
            return `<span class="chord-span${cls}"${attr}>${escapeHtml(seg.display)}</span>`;
        }).join("")
            .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
            .replace(/__(.*?)__/g, '<i>$1</i>');
        return `<div>${line || '&nbsp;'}</div>`;
    }).join("");
}

// Testo per LaTeX: caratteri speciali protetti, **grassetto** e __corsivo__ convertiti,
// accordi come \[accordo], annotazioni in corsivo. chordFn(contenuto) -> nome da stampare.
function latexEscape(t) {
    return String(t ?? "").replace(/\\/g, "\u0001").replace(/([&%$#_{}])/g, "\\$1")
        .replace(/~/g, "\\textasciitilde{}").replace(/\^/g, "\\textasciicircum{}").replace(/\u0001/g, "\\textbackslash{}");
}
function latexLine(line, chordFn) {
    const saved = [];
    let t = String(line ?? "").replace(/\[([^\[\]]*)\]/g, (w, inner) => {
        const k = classifyBracket(inner).kind;
        saved.push(k === "note" ? `\\textit{${latexEscape(inner.trim())}}` : k === "empty" ? "" : `\\[${chordFn(inner)}]`);
        return `\u0003${saved.length - 1}\u0004`;
    });
    t = t.replace(/\*\*(.*?)\*\*/g, "\u0005$1\u0006").replace(/__(.*?)__/g, "\u0007$1\u0008");
    t = latexEscape(t).replace(/\u0005/g, "\\textbf{").replace(/\u0007/g, "\\textit{").replace(/[\u0006\u0008]/g, "}");
    return t.replace(/\u0003(\d+)\u0004/g, (w, i) => saved[+i]);
}

// --- 2. DEFINIZIONE DELLA RICERCA ---
const debouncedGlobalSearch = debounce(() => {
    if (typeof window.performGlobalSearch === 'function') {
        window.performGlobalSearch();
    }
}, 300);

window.debouncedGlobalSearch = debouncedGlobalSearch;
window.extractChords = extractChords;

// --- CONFIGURAZIONE FIREBASE ---
const firebaseConfig = {
  apiKey: "AIzaSyD3Tew1Lp8nGe0vpwHyIlNGxsmLX6nZ7Qw",
  authDomain: "grancanzoniere-b74d2.firebaseapp.com",
  projectId: "grancanzoniere-b74d2",
  storageBucket: "grancanzoniere-b74d2.firebasestorage.app",
  messagingSenderId: "454613760216",
  appId: "1:454613760216:web:4dda3bdb5a400d1091ffad"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// --- VARIABILI GLOBALI ---
let isAdmin = false;
let isSuperAdmin = false;
let hasUnsavedChanges = false;
let allSongs=[], allSections=[], allProposals=[], allSetlists = [];
let currentCategory=null, currentSongId=null, currentTranspose=0, currentFontSize=16;
let editingSectionId=null, currentCoverUrl="", sectionOrder=[];
let favorites = JSON.parse(localStorage.getItem('scoutFavorites')) || [];
let currentSetlistId = null;
let autoScrollInterval = null;
let exportSectionOrder = [];
let isUserInteracting = false;
let exportSectionCovers = {};
let targetMergeSongId = null;
let mDuplicateWarning; // Variabile per il modale
let pendingMergeData = null;
let isFirstLoad = true;// Dove salviamo i dati in attesa di conferma
let persistenceOn = false; // canzoni salvate sul telefono per l'uso offline
const APP_START = performance.now();
// Attesa con frase del loader quando si cambia schermata. Prima era 300 ms a ogni click.
// 0 = schermate istantanee: le frasi compaiono comunque mentre si ricaricano i dati (loadData).
// Rimetti 300 per riavere la frase anche a ogni click.
const NAV_DELAY_MS = 0;
let currentRenderLimit = 30;
let currentRenderList = [];
// Loader phrases
const loaderPhrases = [
    "Osservo gli astri...", 
    "Accordo la chitarra...", 
    "Scaldo le corde vocali...",
    "Cerco il Nord...", 
    "Preparo il fuoco...", 
    "Consulto la mappa..." , 
    "Raccolgo la legna...", 
    "Cerco il capotasto...",
    "Monto la tenda...",
    "Allaccio gli scarponi...",
    "Ripasso gli accordi...",
    "Cerco il plettro...",
    "Srotolo il sacco a pelo...",
    "Ascolto il vento...",
    "Accendo la torcia...",
    "Scelgo la prossima canzone...",
    "Preparo il caffè sul fuoco...",
    "Esploro il sentiero...",
    "Pulisco il binocolo...",
    "Sistemo l'amaca...",
    "Aspetto l'alba...",
    "Ascolto i grilli...",
    "Aggiusto la bussola...",
    "Alimento la fiamma...",
    "Riempio la borraccia...",
    "Allineo i picchetti...",
    "Guardo il tramonto...",
    "Intaglio un legnetto...",
    "Annuso il profumo dei pini...",
    "Scrivo sul taccuino...",
    "Preparo la griglia...",
    "Inseguo le lucciole..."
];
let loaderInterval;
// --- FUNZIONE PER AGGIORNARE IL CONTATORE ---
window.updateTotalSongsCounter = () => {
    const countEl = document.getElementById("totalSongsCount");
    if (countEl) countEl.innerText = allSongs.length;
};
// Modals
let mLogin, mAddSong, mAddSection, mEditSection, mEditSongMeta, mConfirm, mExport, mSearchSetlist, mExportSetlist, mAddToSetlist, mCreateSetlist, mReviewProposal;

window.addEventListener('load', () => {
    startLoaderAnimation();
    manageDynamicBackgrounds();
    
    // Inizializzazione Modali Bootstrap
    mLogin = new bootstrap.Modal(document.getElementById('loginModal'));
    mAddSong = new bootstrap.Modal(document.getElementById('addSongModal'));
    mAddSection = new bootstrap.Modal(document.getElementById('addSectionModal'));
    mEditSection = new bootstrap.Modal(document.getElementById('editSectionModal'));
    mEditSongMeta = new bootstrap.Modal(document.getElementById('editSongMetadataModal'));
    mConfirm = new bootstrap.Modal(document.getElementById('confirmationModal'));
    mExport = new bootstrap.Modal(document.getElementById('exportOptionsModal'));
    mSearchSetlist = new bootstrap.Modal(document.getElementById('searchForSetlistModal'));
    mExportSetlist = new bootstrap.Modal(document.getElementById('exportSetlistModal'));
    mAddToSetlist = new bootstrap.Modal(document.getElementById('addToSetlistModal'));
    mReviewProposal = new bootstrap.Modal(document.getElementById('reviewProposalModal'));
    mDuplicateWarning = new bootstrap.Modal(document.getElementById('duplicateWarningModal'));
    
    // NUOVO MODAL
    const createSetlistEl = document.getElementById('createSetlistModal');
    if(createSetlistEl) mCreateSetlist = new bootstrap.Modal(createSetlistEl);
});

// Variabile per evitare che l'inizializzazione riparta se richiamata più volte
let hasInitAnimStarted = false;

function startLoaderAnimation() {
    const textEl = document.getElementById('loaderText');
    if(!textEl) return;
    
    if (isFirstLoad) {
        // --- PRIMO AVVIO ---
        // SE l'animazione è già partita, FERMATI QUI. Non resettare il testo.
        if (hasInitAnimStarted) return;
        
        hasInitAnimStarted = true; // Segna che è partita
        
        // Reset e avvio scrittura
        if(loaderInterval) clearTimeout(loaderInterval);
        textEl.innerText = ""; 
        textEl.classList.add('typing-cursor'); 

        let phrase = "Inizializzazione...";
        let charIndex = 0;

        const typeEffect = () => {
            if (charIndex < phrase.length) {
                textEl.innerText += phrase[charIndex];
                charIndex++;
                // Velocità scrittura + pausa finale
                loaderInterval = setTimeout(typeEffect, 70); 
            }
        };
        typeEffect();

    } else {
        // --- CARICAMENTI SUCCESSIVI ---
        // Qui resettiamo sempre per mostrare una nuova frase random
        if(loaderInterval) clearTimeout(loaderInterval);
        
        const randomPhrase = loaderPhrases[Math.floor(Math.random() * loaderPhrases.length)];
        textEl.innerText = randomPhrase;
        textEl.classList.remove('typing-cursor'); 
    }
}
// AVVIO PERSISTENZA E DATI
// Canzoni salvate sul telefono (anche con l'app aperta in più schede)
enableMultiTabIndexedDbPersistence(db)
  .then(() => { persistenceOn = true; })
  .catch((err) => {
      console.warn("Persistenza offline non attiva:", err.code);
  })
  .finally(() => {
      setPersistence(auth, inMemoryPersistence)
        .then(() => console.log("Sessione In Memory"))
        .catch((error) => console.error("Errore auth:", error));

      onAuthStateChanged(auth, (user) => {
          
          // --- 1. NUOVA LOGICA PER I PERMESSI ---
          const adminEmails = ["marcobolge@gmail.com", "admin@gmail.com"];
          const superAdminEmails = ["marcobolge@gmail.com"]; 
          
          isAdmin = user && adminEmails.includes(user.email);
          isSuperAdmin = user && superAdminEmails.includes(user.email);
          
          document.body.classList.toggle('user-admin', isAdmin);
          document.body.classList.toggle('super-admin', isSuperAdmin);
          // --------------------------------------
          
          const btnLogin = document.getElementById('btnLoginBtn');
          if(btnLogin) btnLogin.style.display = isAdmin ? 'none' : 'block'; 
          
          // --- 2. RESTO DELLA FUNZIONE ORIGINALE ---
          const btnAddTxt = document.getElementById('btnAddText');
          const btnSubmit = document.getElementById('btnSubmitSong');
          const infoProp = document.getElementById('proposalInfo');
          const propField = document.getElementById('proposerField');
          const prevCol = document.getElementById('previewContainerCol');
          const btnImportTxt = document.getElementById('importTxtBtn'); 

          if (isAdmin) {
              if(btnAddTxt) btnAddTxt.innerText = 'Aggiungi Canzone';
              if(btnSubmit) btnSubmit.innerText = 'Crea Subito';
              if(infoProp) infoProp.style.display = 'none';
              if(propField) propField.style.display = 'none';
              if(prevCol) prevCol.className = "col-md-7";
          } else {
              if(btnAddTxt) btnAddTxt.innerText = 'Proponi Canzone';
              if(btnSubmit) btnSubmit.innerText = 'Invia Proposta';
              if(infoProp) infoProp.style.display = 'block';
              if(propField) propField.style.display = 'block';
              if(prevCol) prevCol.className = "col-md-12";
          }

          // --- CONTROLLO VISIBILITÀ IMPORT TXT PER SUPERADMIN ---
          if (btnImportTxt) {
              if (isSuperAdmin) {
                  btnImportTxt.classList.remove('d-none');
                  btnImportTxt.classList.add('d-flex');
              } else {
                  btnImportTxt.classList.remove('d-flex');
                  btnImportTxt.classList.add('d-none');
              }
          }

          // Le proposte dopo le canzoni: al superadmin servono le canzoni già caricate per il conteggio
          loadData().then(() => { if (isAdmin) loadProposals(); handleStartupLink(); });
      });
  });
window.loadData = loadData;
async function loadData() {
    const reloadStart = performance.now();
    // Ricaricamenti successivi (dopo un salvataggio, un login...): frase random mentre arrivano i dati
    if (!isFirstLoad) {
        const ov = document.getElementById("loadingOverlay");
        if (ov) { ov.style.display = "flex"; startLoaderAnimation(); }
    }
    try {
        // Le tre letture partono insieme invece che una dopo l'altra
        const readCol = (name) => navigator.onLine ? getDocs(collection(db, name))
            : getDocsFromCache(collection(db, name)).catch(() => getDocs(collection(db, name)));
        const [secSnap, songSnap, setlistSnap] = await Promise.all([
            readCol("sections"),
            readCol("songs"),
            readCol("setlists")
        ]);
        allSections = [];
        secSnap.forEach(d => { const data = d.data(); data.name = String(data.name ?? ""); allSections.push({id: d.id, ...data}); });

        allSongs = [];
        songSnap.forEach(d => {
            const data = d.data();
            data.title = String(data.title ?? ""); // un documento senza titolo prima bloccava tutto il caricamento
            if(!data.title.startsWith("Info")) allSongs.push({id: d.id, ...data})
        });
        
        allSetlists = [];
        setlistSnap.forEach(d => allSetlists.push({id: d.id, ...d.data()}));
        allSetlists.forEach(sl => { sl.name = String(sl.name ?? ""); if (!Array.isArray(sl.songs)) sl.songs = []; });
        allSetlists.sort((a,b) => a.name.localeCompare(b.name));

        window.updateTotalSongsCounter();
        setTimeout(refreshTagsUi, 50);   // proposte di etichette: dopo aver mostrato la pagina

        allSections.sort((a, b) => {
            // Se order non esiste, mettilo in fondo (9999)
            const orderA = (a.order !== undefined && a.order !== null) ? a.order : 9999;
            const orderB = (b.order !== undefined && b.order !== null) ? b.order : 9999;
        
            // Se l'ordine è diverso, usa quello
            if (orderA !== orderB) {
                return orderA - orderB;
            }
            // Altrimenti (se hanno lo stesso ordine o nessuno dei due lo ha), usa l'alfabetico
            return a.name.localeCompare(b.name);
        });
        sectionOrder = allSections.map(s => s.name); 

        // --- INIZIO MODIFICA: BLOCCO IF AGGIORNATO ---
        const viewSetlists = document.getElementById('view-setlists');
        const viewManage = document.getElementById('view-manage-sections');

        if (viewSetlists && viewSetlists.classList.contains('active')) {
            window.renderSetlistsList();
            if(currentSetlistId) window.renderActiveSetlistSongs();
        } 
        else if (viewManage && viewManage.classList.contains('active')) {
            // SEI IN GESTIONE SEZIONI: NON FARE NULLA (Resta qui)
            window.renderManageSections();
        } 
        else if (!currentCategory) {
            window.renderDashboard(); 
        } 
        else {
            window.openList(currentCategory); 
        }

    } catch(e) { 
            console.error("Errore caricamento:", e);
            window.showToast("Errore caricamento: " + e.message, 'danger');
        } finally {
            const loader = document.getElementById("loadingOverlay");
            if(loader) {
                // Il tempo torna a 2000ms per dare il tempo alla scritta di finire
                // Scompare appena l'animazione ha finito di scrivere
                // Prima: +1,5 s DOPO l'arrivo dei dati. Ora: l'animazione dura al massimo 1,3 s dall'apertura,
                // e se i dati arrivano più tardi non si aggiunge altra attesa
                let displayDuration = isFirstLoad ? Math.max(0, 1300 - (performance.now() - APP_START))
                                                  : Math.max(0, 300 - (performance.now() - reloadStart)); // la frase resta leggibile
                
                setTimeout(() => {
                    loader.style.display = "none";
                    if(loaderInterval) clearTimeout(loaderInterval);
                    isFirstLoad = false; // Importante: ora i prossimi caricamenti useranno le frasi random
                }, displayDuration);
            }
        }
    }

async function loadProposals() {
    if(!isAdmin) return;
    const snap = await getDocs(collection(db, "proposals"));
    allProposals=[]; 
    snap.forEach(d=>allProposals.push({id:d.id, _isProposal: true, ...d.data()}));
    
    // Se è Superadmin, includi anche le canzoni già nel canzoniere che aspettano conferma
    if (isSuperAdmin) {
        const songsToReview = allSongs.filter(s => s.needsSuperAdminReview === true);
        songsToReview.forEach(s => allProposals.push({...s, _isSongReview: true}));
    }

    const b = document.querySelectorAll('#proposalsBadge');
    b.forEach(el => {
        if(allProposals.length>0){ el.innerText=allProposals.length; el.style.display='inline-block';}
        else{ el.style.display='none'; }
    });
}

window.renderDashboard = () => {
    // SE NON È IL PRIMO AVVIO: Mostra overlay e frase random (solo se NAV_DELAY_MS > 0)
    if (!isFirstLoad && NAV_DELAY_MS > 0) {
        document.getElementById("loadingOverlay").style.display = "flex";
        startLoaderAnimation(); 
    }

    // Se è il primo avvio, renderizziamo subito (tempo 0) sotto lo schermo nero.
    const waitTime = isFirstLoad ? 0 : NAV_DELAY_MS;

    setTimeout(() => {
        switchView('view-dashboard');
        document.getElementById('globalSearch').value="";
        
        const favC=document.getElementById("favoritesContainer");
        const favS=document.getElementById("favoritesSection");
        const favs=allSongs.filter(s=>favorites.includes(s.id));
        if(favs.length>0){
            favS.style.display='block';
            favC.innerHTML=favs.map(s=>`<button class="list-group-item list-group-item-action border-0 d-flex justify-content-between align-items-center" onclick="window.openEditor('${s.id}')"><div><i class="bi bi-star-fill text-warning me-2"></i> <strong>${escapeHtml(s.title)}</strong></div><small class="text-muted">${escapeHtml(s.author || '')}</small></button>`).join('');
        } else favS.style.display='none';

        const c = document.getElementById("categoriesContainer"); 
        
        if(allSections.length===0) {
            c.innerHTML=`<div class="text-center text-muted">Nessuna sezione presente.</div>`;
        } else {
            let htmlContent = ""; // <-- Prepariamo il testo
            
            allSections.forEach(sec => {
                const sectionSongs = allSongs.filter(s => s.category === sec.name);
                const count = sectionSongs.length;
                const bg = sec.coverUrl ? `background-image:url('${sec.coverUrl}')` : "";
                const ico = sec.coverUrl ? "" : `<i class="bi bi-music-note-beamed cat-icon"></i>`;
                
                let adminStatsHtml = "";
                
                if (isAdmin) {
                    let countGreen = 0;  
                    let countOrange = 0; 
                    let countRed = 0;    
                    
                    sectionSongs.forEach(s => {
                        const hasLyrics = s.lyrics && s.lyrics.trim().length > 5;
                        const hasChords = s.lyrics && s.lyrics.includes("[");
                        
                        if (hasLyrics && hasChords) countGreen++;
                        else if (hasLyrics) countOrange++;
                        else countRed++;
                    });
                    
                    adminStatsHtml = `
                        <div class="mt-2 d-flex justify-content-center gap-3 small border-top border-secondary pt-2">
                            <span title="Complete" class="text-white-50 d-flex align-items-center">
                                <span class="status-dot status-green m-0 me-1"></span>${countGreen}
                            </span>
                            <span title="Solo Testo (Mancano accordi)" class="text-white-50 d-flex align-items-center">
                                <span class="status-dot status-orange m-0 me-1"></span>${countOrange}
                            </span>
                            <span title="Vuote (Da compilare)" class="text-white-50 d-flex align-items-center">
                                <span class="status-dot status-red m-0 me-1"></span>${countRed}
                            </span>
                        </div>
                    `;
                }
                
                htmlContent += `
                <div class="col-md-4 col-sm-6">
                    <div class="category-card shadow-sm">
                        <div class="cat-cover" style="${bg}" onclick="window.openList('${jsArg(sec.name)}')">${ico}</div>
                        <div class="p-3 text-center" onclick="window.openList('${jsArg(sec.name)}')">
                            <h5 class="fw-bold mb-1 text-truncate">${escapeHtml(sec.name)}</h5>
                            <small class="text-muted">${count} canzoni</small>
                            ${adminStatsHtml}
                        </div>
                    </div>
                </div>`;
            });
            
            // Stampa a schermo tutto assieme
            c.innerHTML = htmlContent;
        }

        renderSearchFilters();
        if (activeTags.size) window.performGlobalSearch();

        // NASCONDI OVERLAY SOLO SE NON E' IL PRIMO AVVIO
        // (Al primo avvio ci pensa la funzione loadData dopo 3 secondi)
        if (!isFirstLoad) {
            document.getElementById("loadingOverlay").style.display = "none";
        }
    }, waitTime);
};
// --- RICERCA: titolo, autore e parole del testo (senza accenti né punteggiatura) ---
// Modalità: tutto / titolo / autore / testo. Ordine: titolo che inizia con la ricerca, titolo che la contiene,
// autore, poi testo (frase esatta prima delle parole sparse). Per il testo si vede la riga trovata.
let searchMode = (() => { try { return localStorage.getItem('searchMode') || 'all'; } catch (e) { return 'all'; } })();
const searchCache = new WeakMap();
function searchFields(s) {
    let c = searchCache.get(s);
    if (c && c.src === s.lyrics && c.t0 === s.title && c.a0 === s.author) return c;
    const lines = (s.lyrics || "").split("\n")
        .filter(l => !parseChordLine(l) && !parseBracketChordLine(l))           // le righe di soli accordi non sono testo
        .map(l => lineWithoutChords(l).replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
    const linesN = lines.map(robustNormalize);
    c = { src: s.lyrics, t0: s.title, a0: s.author, t: robustNormalize(s.title), a: robustNormalize(s.author || ""), lines, linesN, all: " " + linesN.join(" | ") + " " };
    searchCache.set(s, c);
    return c;
}
const ACCENTS = { a: "aàáâä", e: "eèéêë", i: "iìíîï", o: "oòóôö", u: "uùúûü", c: "cç", n: "nñ" };
// Evidenzia le parole cercate nel testo originale (accenti e apostrofi compresi)
function highlight(text, words) {
    const pats = words.filter(Boolean).map(w => [...w].map(ch => {
        const cls = ACCENTS[ch] ? `[${ACCENTS[ch]}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return cls;
    }).join("[^\\p{L}\\p{N}\\s]*"));
    if (!pats.length) return escapeHtml(text);
    const re = new RegExp(pats.join("|"), "giu");
    let out = "", last = 0, m;
    while ((m = re.exec(text)) !== null) {
        if (!m[0]) { re.lastIndex++; continue; }
        out += escapeHtml(text.slice(last, m.index)) + "<mark>" + escapeHtml(m[0]) + "</mark>";
        last = m.index + m[0].length;
    }
    return out + escapeHtml(text.slice(last));
}
function matchSong(s, q, words, mode) {
    const f = searchFields(s);
    const all = (str) => words.every(w => str.includes(w));
    if (mode === 'all' || mode === 'title') {
        if (f.t.startsWith(q)) return { score: 100, where: 'title' };
        if (f.t.includes(q)) return { score: 90, where: 'title' };
        if (all(f.t)) return { score: 80, where: 'title' };
    }
    if (mode === 'all' || mode === 'author') {
        if (f.a && f.a.includes(q)) return { score: 70, where: 'author' };
        if (f.a && all(f.a)) return { score: 60, where: 'author' };
    }
    if (mode === 'all' && all(f.t + " " + f.a)) return { score: 55, where: 'title' };
    if (mode === 'all' || mode === 'lyrics') {
        let idx = f.linesN.findIndex(l => l.includes(q));
        if (idx >= 0) return { score: 40, where: 'lyrics', line: f.lines[idx] };
        if (all(f.all)) {
            idx = f.linesN.findIndex(l => l.includes(words[0]));
            return { score: 30, where: 'lyrics', line: idx >= 0 ? f.lines[idx] : "" };
        }
    }
    return null;
}
// Riga trovata accorciata attorno alla parola cercata
function snippetAround(line, word) {
    if (line.length <= 90) return line;
    const pos = Math.max(0, robustNormalize(line).indexOf(word));
    const start = Math.max(0, pos - 30);
    return (start > 0 ? "…" : "") + line.slice(start, start + 90) + (start + 90 < line.length ? "…" : "");
}
window.setSearchMode = (mode) => {
    searchMode = mode;
    try { localStorage.setItem('searchMode', mode); } catch (e) {}
    document.querySelectorAll('#searchModes button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    const input = document.getElementById('globalSearch');
    if (input) {
        input.placeholder = { all: "Cerca titolo, autore o parole del testo...", title: "Cerca per titolo...", author: "Cerca per autore...", lyrics: "Cerca una frase del testo..." }[mode];
        if (input.value.trim()) window.performGlobalSearch();
    }
};
window.addEventListener('load', () => window.setSearchMode(searchMode));

window.performGlobalSearch = () => {
    // Ignora accenti e punteggiatura: "perche" trova "Perché"
    const q = robustNormalize(document.getElementById('globalSearch').value);
    if (!q && !activeTags.size) { window.renderDashboard(); return; }
    const words = q ? q.split(" ").filter(Boolean) : [];

    // Trova TUTTI i risultati, i migliori prima (solo tra le canzoni con le etichette scelte)
    const allRes = allSongs.filter(matchTags).map(s => ({ s, m: q ? matchSong(s, q, words, searchMode) : { score: 0, where: 'tags' } })).filter(x => x.m)
        .sort((x, y) => y.m.score - x.m.score || x.s.title.localeCompare(y.s.title));
    document.getElementById("favoritesSection").style.display = 'none';

    // Taglia l'array per mostrare solo i primi 30 risultati (sfogliando per etichetta: tutte)
    const maxShown = q ? 30 : 400;
    const res = allRes.slice(0, maxShown);

    let htmlContent = (activeTags.size ? `<div class="col-12 filters-summary">${allRes.length} canzoni con: ${[...activeTags].map(t => `<b>${escapeHtml(TAG_LABEL[t] || t)}</b>`).join(", ")}</div>` : "") + (res.length ? res.map(({ s, m }) => {
        let badgeHtml = "";
        
        // LOGICA BOLLINI ADMIN
        if (isAdmin) {
            const hasLyrics = s.lyrics && s.lyrics.trim().length > 5;
            const hasChords = s.lyrics && s.lyrics.includes("[");
            
            if (hasLyrics && hasChords) {
                badgeHtml = `<span class="status-dot status-green" title="Completo"></span>`;
            } else if (hasLyrics) {
                badgeHtml = `<span class="status-dot status-orange" title="Solo Testo"></span>`;
            } else {
                badgeHtml = `<span class="status-dot status-red" title="Vuoto"></span>`;
            }
        }

        // LOGICA BOLLINO TONALITÀ
        let transBadge = "";
        if (s.savedTranspose && s.savedTranspose !== 0) {
            const sign = s.savedTranspose > 0 ? "+" : "";
            transBadge = `<span class="badge bg-secondary bg-opacity-25 text-white border border-secondary ms-2" style="font-size: 0.75rem;">${sign}${s.savedTranspose}</span>`;
        }

        const titleHtml = m.where === 'title' ? highlight(s.title, words) : escapeHtml(s.title);
        const authorHtml = m.where === 'author' ? highlight(s.author || '', words) : escapeHtml(s.author || '');
        const snippet = m.where === 'lyrics' && m.line
            ? `<div class="search-snippet"><i class="bi bi-text-paragraph me-1"></i>${highlight(snippetAround(m.line, words[0]), words)}</div>` : "";

        return `<div class="col-12"><div class="card shadow-sm border-0" onclick="window.openEditor('${s.id}')" style="cursor:pointer">
            <div class="card-body d-flex justify-content-between align-items-center">
                <div class="search-hit" style="min-width:0">
                    <h6 class="fw-bold mb-0">${titleHtml} ${badgeHtml} ${transBadge}</h6>
                    <small>${authorHtml} <span class="badge bg-light text-dark ms-2">${escapeHtml(s.category)}</span></small>
                    ${snippet}
                </div>
                <i class="bi bi-chevron-right text-muted"></i>
            </div>
        </div></div>`;
    }).join('') : `<div class="text-center mt-4">Nessun risultato${q && searchMode !== 'all' ? ` cercando solo per ${({ title: "titolo", author: "autore", lyrics: "testo" })[searchMode]} — <a href="#" onclick="window.setSearchMode('all'); return false;">cerca ovunque</a>` : ""}${activeTags.size ? ` con questi filtri — <a href="#" onclick="window.clearTagFilters(); return false;">togli i filtri</a>` : ""}.</div>`);

    // Se ci sono più di 30 risultati, aggiungi un avviso alla fine della lista
    if (allRes.length > maxShown) {
        htmlContent += `
        <div class="col-12 text-center text-muted mt-3 mb-4 small">
            <i class="bi bi-info-circle me-1"></i> Trovate altre ${allRes.length - maxShown} canzoni. Continua a digitare per affinare la ricerca.
        </div>`;
    }

    document.getElementById("categoriesContainer").innerHTML = htmlContent;
};
window.openList = (cat) => {
    if (!isFirstLoad && NAV_DELAY_MS > 0) {
        document.getElementById("loadingOverlay").style.display = "flex";
        startLoaderAnimation();
    }
    
    const waitTime = isFirstLoad ? 0 : NAV_DELAY_MS;

    setTimeout(() => {
        currentSetlistId = null;
        currentCategory = cat; 
        switchView('view-list'); 
        
        const sectionSongs = allSongs.filter(s => s.category === cat);
        
        document.getElementById("listTitle").innerHTML = `
            ${escapeHtml(cat)} <span class="badge bg-primary rounded-pill ms-2" style="font-size: 0.5em; vertical-align: middle; opacity: 0.8;">
                ${sectionSongs.length}
            </span>`; 
            
        document.getElementById("sectionSearchBox").value = ""; 
        window.renderList(sectionSongs); 
        
        if (!isFirstLoad) {
            document.getElementById("loadingOverlay").style.display = "none";
        }
    }, waitTime);
};
window.filterSectionList = () => {
    const q = robustNormalize(document.getElementById("sectionSearchBox").value);
    window.renderList(allSongs.filter(s => s.category === currentCategory && robustNormalize(s.title + " " + (s.author || "")).includes(q)));
};

window.renderList = (songs, isAppending = false) => {
    const c = document.getElementById("songListContainer"); 
    
    // Se è il primo caricamento della lista (non stiamo premendo "Mostra altre")
    if (!isAppending) {
        currentRenderLimit = 30; // Resetta il limite a 30
        // Salva la lista ordinata nella variabile globale
        currentRenderList = [...songs].sort((a, b) => a.title.localeCompare(b.title));
        c.innerHTML = ""; // Svuota il contenitore
    }
    
    let htmlContent = ""; 
    
    // Prendiamo solo il blocco di canzoni da mostrare (es. da 0 a 30, o da 30 a 60)
    const songsToShow = currentRenderList.slice(
        isAppending ? currentRenderLimit - 30 : 0, 
        currentRenderLimit
    );
    
    songsToShow.forEach(s => {
        let badgeHtml = "";
        
        if (isAdmin) {
            const hasLyrics = s.lyrics && s.lyrics.trim().length > 5;
            const hasChords = s.lyrics && s.lyrics.includes("[");
            if (hasLyrics && hasChords) badgeHtml = `<span class="status-dot status-green" title="Completo"></span>`;
            else if (hasLyrics) badgeHtml = `<span class="status-dot status-orange" title="Solo Testo"></span>`;
            else badgeHtml = `<span class="status-dot status-red" title="Vuoto"></span>`;
        }

        let transBadge = "";
        if (s.savedTranspose && s.savedTranspose !== 0) {
            const sign = s.savedTranspose > 0 ? "+" : "";
            transBadge = `<span class="badge bg-secondary bg-opacity-25 text-white border border-secondary ms-2" style="font-size: 0.75rem;">${sign}${s.savedTranspose}</span>`;
        }

        htmlContent += `
            <button class="list-group-item list-group-item-action p-3 border-0 mb-1 rounded shadow-sm" onclick="window.openEditor('${s.id}')">
                <div class="d-flex w-100 justify-content-between align-items-center">
                    <div><h6 class="mb-1 fw-bold">${escapeHtml(s.title)} ${badgeHtml} ${transBadge}</h6></div>
                    <small class="text-muted">${escapeHtml(s.author || '')}</small>
                </div>
            </button>`;
    });

    // Inseriamo l'HTML generato
    if (!isAppending) {
        c.innerHTML = htmlContent;
    } else {
        // Se stiamo aggiungendo, rimuoviamo il vecchio bottone e accodiamo le nuove canzoni
        const oldBtn = document.getElementById("loadMoreBtn");
        if (oldBtn) oldBtn.remove();
        c.insertAdjacentHTML('beforeend', htmlContent);
    }

    // Se ci sono ancora canzoni nascoste, creiamo il pulsante per caricare le successive
    if (currentRenderLimit < currentRenderList.length) {
        const remaining = currentRenderList.length - currentRenderLimit;
        c.insertAdjacentHTML('beforeend', `
            <button id="loadMoreBtn" class="btn btn-outline-secondary w-100 my-3 fw-bold rounded shadow-sm" onclick="window.loadMoreSongs()">
                <i class="bi bi-chevron-down me-2"></i> Mostra altre ${remaining > 30 ? 30 : remaining} canzoni...
            </button>
        `);
    }
};

// Nuova funzione richiamata dal bottone "Mostra altre"
window.loadMoreSongs = () => {
    currentRenderLimit += 30;
    window.renderList(currentRenderList, true);
};
window.openEditor = (id) => {
    if (NAV_DELAY_MS > 0) document.getElementById("loadingOverlay").style.display = "flex";

    setTimeout(() => {
        currentSongId=id; 
        const s=allSongs.find(x=>x.id===id);
        if (!s) { document.getElementById("loadingOverlay").style.display = "none"; return showToast("Canzone non trovata", "warning"); }
        switchView('view-editor');
        window.scrollTo(0, 0);
        document.getElementById("editorTitle").innerText=s.title;
        document.getElementById("editorAuthor").innerText=s.author || ""; // prima: "undefined" se mancava l'autore
        
        let metaText = [];
        if(s.description) metaText.push(s.description);
        if(s.year) metaText.push(`(${s.year})`);
        document.getElementById("editorMeta").innerText = metaText.join(" - ");
        renderEditorTags(s);

        const editor = document.getElementById("lyricsEditor");
        editor.value = s.lyrics || "";
        hasUnsavedChanges = false; 
        editor.oninput = () => { hasUnsavedChanges = true; window.renderPreview(); };

        currentTranspose = s.savedTranspose || 0; 
        const sign = currentTranspose > 0 ? "+" : "";
        document.getElementById("toneDisplay").innerText = currentTranspose === 0 ? "0" : sign + currentTranspose;

        updateFavIcon(); 
        window.renderPreview();
        if (autoScrollInterval) window.toggleAutoScroll();

        // Se la canzone ha accordi/testo da sistemare, il bottone Auto-correggi diventa giallo
        const btnFix = document.getElementById("btnAutoFix");
        if (btnFix) {
            const needsFix = isAdmin && isAutoFixable(s, { typos: true });
            btnFix.classList.toggle("btn-warning", needsFix);
            btnFix.classList.toggle("btn-outline-dark", !needsFix);
        }

        document.getElementById("loadingOverlay").style.display = "none";
    }, NAV_DELAY_MS);
};

window.renderPreview = () => {
    const txt = document.getElementById("lyricsEditor").value;
    const div = document.getElementById("previewArea");
    div.style.fontSize = currentFontSize + 'px';
    const song = allSongs.find(x => x.id === currentSongId);
    const capo = capoFor(currentSongId, currentTranspose);
    div.innerHTML = (capo ? capoBannerHtml(capo) : "")
        + lyricsToHtml(txt, currentTranspose - capo, "", isAdmin ? suspiciousChords(txt, song && song.chordOk) : null, isAdmin);
    updateCapoUi(txt);
};

// Tocco su un accordo: diagramma per chitarra e ukulele; per l'admin anche il motivo della segnalazione
document.addEventListener("click", (e) => {
    const el = e.target.closest("#previewArea .chord-span, #performBody .chord-span, .snippet-chord");
    if (!el) return;
    const flagged = isAdmin && !!el.closest("#previewArea") && el.matches(".chord-suspect, .chord-unusual, .chord-typo, .chord-unknown");
    openChordSheet(el, flagged);
});

window.markChordOk = async (name, undo = false) => {
    const s = allSongs.find(x => x.id === currentSongId);
    if (!s || !isAdmin) return;
    try {
        await updateDoc(doc(db, "songs", s.id), { chordOk: undo ? arrayRemove(name) : arrayUnion(name) });
        const list = new Set(s.chordOk || []);
        if (undo) list.delete(name); else list.add(name);
        s.chordOk = [...list];
        window.renderPreview();
        if (!undo) notify(`${name} segnato come giusto in "${s.title}".`, "success", { actions: [{ label: "Annulla", primary: false, onClick: () => window.markChordOk(name, true) }] });
    } catch (err) {
        notify("Non sono riuscito a salvare: " + err.message, "danger");
    }
};

window.handleSongSubmission = async () => {
    // 1. RECUPERO DATI
    const t = document.getElementById("propTitle").value.trim() || document.getElementById("newSongTitle").value.trim();
    const a = document.getElementById("propAuthor").value.trim() || document.getElementById("newSongAuthor").value.trim(); 
    const c = document.getElementById("propCategory").value || document.getElementById("newSongCategorySelect").value; 
    const l = document.getElementById("propLyrics").value || document.getElementById("newSongLyrics").value; 
    const p = document.getElementById("propUser").value.trim() || document.getElementById("newSongProposer").value.trim();
    const d = document.getElementById("propDesc").value.trim() || document.getElementById("newSongDescription").value.trim();
    const y = document.getElementById("propYear").value || document.getElementById("newSongYear").value;

    if(!t) return showToast("Manca il Titolo!", 'warning');
    if(!isAdmin && !p) return showToast("Il tuo nome è obbligatorio", 'warning'); 

    // 2. CONTROLLO DUPLICATI ROBUSTO (Usa la nuova funzione robustNormalize)
    const normInputTitle = robustNormalize(t);
    // stesso titolo con un altro autore è un'altra canzone (es. due "Alleluia")
    const existingSong = allSongs.find(s => isSameSong(t, a, s.title, s.author));

    // Preparazione oggetto dati
    const songData = { 
        title: t, author: a, category: c, lyrics: l, description: d, year: y, 
        chords: window.extractChords(l), createdAt: Date.now(),
        needsSuperAdminReview: !isSuperAdmin
    };

    if (existingSong) {
        const dbHasLyrics = existingSong.lyrics && existingSong.lyrics.trim().length > 10;
        const inputHasLyrics = l && l.trim().length > 10;

        if (dbHasLyrics) {
            return showToast(`Esiste già "${existingSong.title}" ed è completa!`, 'danger');
        } 
        
        if (!inputHasLyrics) {
            return showToast(`"${existingSong.title}" esiste già e non stai aggiungendo testo!`, 'warning');
        }

        // --- CASO MERGE (Integrazione) ---
        if (isAdmin) {
            // Invece di confirm(), salviamo i dati e apriamo il modale
            pendingMergeData = {
                targetId: existingSong.id,
                newData: {
                    lyrics: l, 
                    chords: window.extractChords(l),
                    author: a || existingSong.author,
                    year: y || existingSong.year,
                    description: d || existingSong.description,
                    category: c,
                    needsSuperAdminReview: !isSuperAdmin
                }
            };

            // Riempiamo i testi del modale
            document.getElementById('dupSongTitle').innerText = t;
            document.getElementById('dupDbTitle').innerText = existingSong.title;
            document.getElementById('dupDbAuth').innerText = existingSong.author ? `(${existingSong.author})` : '';
            
            // Mostra il popup
            mDuplicateWarning.show();
            return; // STOP QUI, aspettiamo il click sul modale
        }
    }

    // --- SE NON E' DUPLICATO O SEI GUEST, PROCEDI NORMALE ---
    document.getElementById("loadingOverlay").style.display = "flex"; 

    try {
        if (isAdmin) {
            const r = await addDoc(collection(db,"songs"), {...songData, added:true}); 
            allSongs.push({ id: r.id, ...songData, added: true });
            window.updateTotalSongsCounter();
            showToast("Canzone Creata!", 'success'); 
            mAddSong.hide();
            window.openEditor(r.id); 
        } else { 
            await addDoc(collection(db,"proposals"), {...songData, proposer: p}); 
            // 2. INVIA LA MAIL TRAMITE GOOGLE SCRIPT
            fetch("https://script.google.com/macros/s/AKfycbwW9pUYWHmbztTCdmlIVQB0IUJUNP4NZffp16ebjErdnNQklubxe94nbRPM8jeNV7Np/exec", {
                method: "POST",
                headers: {
                    "Content-Type": "text/plain;charset=utf-8",
                },
                body: JSON.stringify({
                    titolo: t,
                    autore: p,
                    categoria: c
                })
            }).catch(err => console.error("Errore invio notifica:", err));
            showToast("Proposta inviata!", 'success'); 
            mAddSong.hide();
            window.goHome();
        }
    } catch(e) { 
        console.error(e); 
        showToast("Errore: " + e.message, 'danger');
    } finally {
        document.getElementById("loadingOverlay").style.display = "none";
        // Niente loadData() qui: la canzone nuova è già stata aggiunta ad allSongs,
        // ricaricare tutto il canzoniere costava N letture e riportava alla lista mentre eri nell'editor
    }
};

// Funzione chiamata dal tasto "Sì, Unisci" del nuovo modale
window.executeMerge = async () => {
    if (!pendingMergeData) return;

    mDuplicateWarning.hide();
    document.getElementById("loadingOverlay").style.display = "flex";

    try {
        // Esegui l'aggiornamento su Firestore
        recordHistory(allSongs.find(x => x.id === pendingMergeData.targetId), "unione");
        await updateDoc(doc(db, "songs", pendingMergeData.targetId), pendingMergeData.newData);
        
        // Aggiorna array locale
        const loc = allSongs.find(x => x.id === pendingMergeData.targetId);
        if(loc) { 
            Object.assign(loc, pendingMergeData.newData);
        }
        
        showToast("Canzone integrata con successo!", 'success');
        mAddSong.hide(); // Chiudi modale aggiunta se aperto
        window.openEditor(pendingMergeData.targetId); // Vai all'editor della canzone aggiornata

    } catch(e) {
        showToast("Errore merge: " + e.message, 'danger');
    } finally {
        document.getElementById("loadingOverlay").style.display = "none";
        pendingMergeData = null; // Reset
    }
};
window.openExportModal = () => {
    const list = document.getElementById("sectionOrderList"); list.innerHTML = "";
    sectionOrder = allSections.map(s=>s.name);
    sectionOrder.forEach((name, idx) => {
        list.innerHTML += `<div class="order-list-item"><span>${name}</span><div><button class="btn btn-sm btn-outline-secondary me-1" onclick="window.moveSection(${idx},-1)">⬆</button><button class="btn btn-sm btn-outline-secondary" onclick="window.moveSection(${idx},1)">⬇</button></div></div>`;
    });
    mExport.show();
};

/* ==========================================
   FUNZIONE PDF CORRETTA (DAL VECCHIO SCRIPT)
   ========================================== */
// script.js - Sostituisci la funzione esistente

window.generateFullPDF = async () => {
    // --- LETTURA OPZIONI UI ---
    const showChords = document.getElementById("pdfShowChords").checked;
    const isTwoColumns = document.getElementById("pdfTwoColumns").checked;
    const includeToc = document.getElementById("pdfShowToc").checked;
    const includePageNumbers = document.getElementById("pdfShowPageNumbers").checked;
    const fontSizeMode = document.getElementById("pdfFontSize").value;

    // --- CONFIGURAZIONE FONT SIZE ---
    let titleSize = 12;
    let metaSize = 9;
    let lyricSize = 9;
    let chordSize = 9;
    let lineHeight = 5;

    if (fontSizeMode === 'small') {
        titleSize = 11; lyricSize = 8; chordSize = 8; lineHeight = 4;
    } else if (fontSizeMode === 'large') {
        titleSize = 14; lyricSize = 11; chordSize = 11; lineHeight = 6;
    } else {
        // Normal (Default)
        titleSize = 12; lyricSize = 10; chordSize = 10; lineHeight = 5;
    }

    if(document.getElementById("loadingOverlay")) document.getElementById("loadingOverlay").style.display="flex";
    
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ format: 'a4', orientation: 'portrait', unit: 'mm' });
    const PAGE_WIDTH = 210;
    const PAGE_HEIGHT = 297;
    const MARGIN_TOP = 20;
    const MARGIN_BOTTOM = 280;
    const SIDE_MARGIN = 15;
    const GUTTER = 10;

    // --- 1. COPERTINA GLOBALE ---
    const coverInput = document.getElementById("globalCoverInput").files[0];
    if (coverInput) {
        try {
            const coverBase64 = await fileToBase64(coverInput);
            doc.addImage(coverBase64, 'JPEG', 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
        } catch(e) { console.error("Errore copertina", e); }
    } else {
        doc.setFillColor(0, 51, 102); 
        doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold"); doc.setFontSize(40);
        doc.text("CANZONIERE", PAGE_WIDTH/2, 120, {align: 'center'});
        doc.setFontSize(20);
        doc.text("SCOUT", PAGE_WIDTH/2, 135, {align: 'center'});
    }

    // --- 2. PREPARAZIONE DATI INDICE E FILTRO SEZIONI ---
    // Filtra solo le sezioni che hanno included == true (o undefined)
    const rawList = (typeof exportSectionOrder !== 'undefined' && exportSectionOrder.length > 0) 
                        ? exportSectionOrder 
                        : allSections;
    
    // Mantieni solo quelle incluse
    const finalSections = rawList.filter(s => s.included !== false);
    
    // Calcoliamo le pagine necessarie per l'indice solo se richiesto
    let tocData = []; 
    let tocPagesNeeded = 0;

    if (includeToc) {
        let totalTocItems = 0;
        for (const sec of finalSections) {
            const songs = allSongs.filter(s => s.category === sec.name);
            if (songs.length > 0) {
                totalTocItems++; // Titolo sezione
                totalTocItems += songs.length; // Canzoni
            }
        }
        tocPagesNeeded = Math.ceil(totalTocItems / 90); // Stima 90 righe per pagina
        for(let i=0; i < tocPagesNeeded; i++) doc.addPage(); 
    }

    // Parametri layout colonne
    const COL_WIDTH = isTwoColumns ? (PAGE_WIDTH - (SIDE_MARGIN * 2) - GUTTER) / 2 : (PAGE_WIDTH - (SIDE_MARGIN * 2));
    const COL_1_X = SIDE_MARGIN;
    const COL_2_X = isTwoColumns ? (SIDE_MARGIN + COL_WIDTH + GUTTER) : SIDE_MARGIN;

    let currentX = COL_1_X;
    let currentY = MARGIN_TOP;
    let currentCol = 1;

    const checkLimit = (heightNeeded) => {
        if (currentY + heightNeeded > MARGIN_BOTTOM) {
            if (isTwoColumns && currentCol === 1) {
                currentCol = 2;
                currentX = COL_2_X;
                currentY = MARGIN_TOP;
            } else {
                doc.addPage();
                currentCol = 1;
                currentX = COL_1_X;
                currentY = MARGIN_TOP;
            }
            return true;
        }
        return false;
    };

    // --- 3. LOOP PRINCIPALE CONTENUTO ---
    doc.addPage();
    currentCol = 1; currentX = COL_1_X; currentY = MARGIN_TOP;

    for (const sec of finalSections) {
        const songs = allSongs.filter(s => s.category === sec.name).sort((a,b)=>a.title.localeCompare(b.title));
        if (songs.length === 0) continue;

        let sectionCoverImg = exportSectionCovers[sec.id];
        if (!sectionCoverImg && sec.coverUrl) {
            sectionCoverImg = sec.coverUrl;
        }

        if (includeToc) {
            tocData.push({ type: 'section', text: sec.name.toUpperCase(), page: doc.internal.getCurrentPageInfo().pageNumber });
        }

        // LOGICA INTESTAZIONE SEZIONE
        if (sectionCoverImg) {
            // CASO A: Immagine presente
            if (doc.internal.getCurrentPageInfo().pageNumber > 1) {
                doc.addPage(); 
            }
            try {
                doc.addImage(sectionCoverImg, 'JPEG', 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
                doc.addPage();
                currentCol = 1; currentX = COL_1_X; currentY = MARGIN_TOP;
            } catch(e) { console.error("Errore img sezione", e); }
        } else {
            // CASO B: Nessuna immagine -> Genera Copertina Placeholder
            if (doc.internal.getCurrentPageInfo().pageNumber > 1) {
                doc.addPage();
            }
            doc.setFillColor(0, 51, 102); 
            doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, 'F'); 
            doc.setTextColor(255, 255, 255); 
            doc.setFont("helvetica", "bold"); 
            doc.setFontSize(36);
            
            const splitTitle = doc.splitTextToSize(sec.name.toUpperCase(), PAGE_WIDTH - 40);
            const textHeight = splitTitle.length * 15; 
            doc.text(splitTitle, PAGE_WIDTH/2, (PAGE_HEIGHT/2) - (textHeight/4), {align: 'center'});

            doc.addPage();
            doc.setTextColor(0, 0, 0); 
            currentCol = 1; currentX = COL_1_X; currentY = MARGIN_TOP;
        }

        // --- LOOP CANZONI ---
        // (Nota: questo ciclo deve essere DENTRO il ciclo delle sezioni)
        for (const s of songs) {
            
            // *** RIGA AGGIUNTA QUI SOTTO ***
            const songTrans = s.savedTranspose || 0; 
            // *******************************

            if (includeToc) {
                tocData.push({ type: 'song', text: s.title, subtext: s.author, page: doc.internal.getCurrentPageInfo().pageNumber });
            }

            checkLimit(25);

            // 1. Calcoliamo PRIMA quanto spazio occupa l'autore
            let authTxt = "";
            let authWidth = 0;
            if (s.author) {
                doc.setFont("helvetica", "italic"); 
                doc.setFontSize(metaSize);
                authTxt = s.year ? `${s.author} (${s.year})` : s.author;
                authWidth = doc.getTextWidth(authTxt);
            }

            // 2. Calcoliamo lo spazio effettivo rimasto per il titolo
            // Sottraiamo la larghezza autore + 3mm di spazio "cuscinetto"
            const maxTitleWidth = s.author ? (COL_WIDTH - authWidth - 3) : COL_WIDTH;

            // 3. Prepariamo e stampiamo il Titolo
            doc.setFont("helvetica", "bold"); 
            doc.setFontSize(titleSize); 
            doc.setTextColor(0, 51, 102);
            
            // Usiamo maxTitleWidth invece di COL_WIDTH per forzare l'a capo se serve
            const titleLines = doc.splitTextToSize(s.title.toUpperCase(), maxTitleWidth);
            doc.text(titleLines, currentX, currentY);

            // 4. Stampiamo l'Autore (Allineato all'ultima riga del titolo)
            if (authTxt) {
                doc.setFont("helvetica", "italic"); 
                doc.setFontSize(metaSize); 
                doc.setTextColor(100);
                
                // Calcoliamo la posizione Y dell'ultima riga del titolo
                // Così l'autore appare allineato in basso a destra rispetto al titolo
                const lineSpacing = lineHeight + 0.5;
                const lastLineY = currentY + ((titleLines.length - 1) * lineSpacing);
                
                doc.text(authTxt, currentX + COL_WIDTH, lastLineY, {align: 'right'}); 
            }

            // Aggiorniamo la Y per il prossimo elemento
            currentY += (titleLines.length * (lineHeight + 0.5));


            // Descrizione
            if (s.description) {
                doc.setFont("helvetica", "italic"); doc.setFontSize(metaSize - 1); doc.setTextColor(50);
                const noteWidth = COL_WIDTH - 4; 
                const splitNotes = doc.splitTextToSize(s.description, noteWidth);
                const blockHeight = (splitNotes.length * 3.5) + 4; 
                checkLimit(blockHeight);
                doc.setFillColor(240, 240, 240);
                doc.rect(currentX, currentY, COL_WIDTH, blockHeight, 'F');
                doc.text(splitNotes, currentX + 2, currentY + 3.5);
                currentY += blockHeight + 2; 
            } else {
                currentY += 2; 
            }

            // Linea separatrice
            doc.setDrawColor(200); doc.setLineWidth(0.2);
            doc.line(currentX, currentY - 1, currentX + COL_WIDTH, currentY - 1);
            currentY += 4; 
            
            // Testo e Accordi
            doc.setFont("helvetica", "normal"); doc.setFontSize(lyricSize); doc.setTextColor(0);
            const lines = (s.lyrics || "").split("\n");
            
            for (let l of lines) {
                l = l.replace(/\*\*|__/g, ''); 
                const parts = l.split(/(\[.*?\])/);
                const hasChords = parts.some(p => p.startsWith("["));
                const heightNeeded = (hasChords && showChords) ? (lineHeight * 2) : lineHeight;
                
                checkLimit(heightNeeded);
                let lineX = currentX;
                
                if (hasChords && showChords) { 
                    let lastChordEnd = 0; 
                    parts.forEach(p => {
                        if (p.startsWith("[")) {
                            let c = p.replace(/[\[\]]/g,'');
                            c = chordDisplay(c, songTrans); // annotazioni ([Chorus], [x2]) non trasposte
                            doc.setFont(undefined, 'bold'); doc.setFontSize(chordSize); doc.setTextColor(220, 53, 69);
                            if (lineX < lastChordEnd) lineX = lastChordEnd; // [Do][Sol]: non sovrapporre i due accordi
                            
                            const chordWidth = doc.getTextWidth(c);
                            // Se l'accordo sfora il margine destro, va a capo
                            if (lineX + chordWidth > currentX + COL_WIDTH && lineX > currentX) {
                                currentY += (lineHeight + 4);
                                checkLimit(lineHeight + 4);
                                lineX = currentX;
                                lastChordEnd = 0;
                            }
                            
                            doc.text(c, lineX, currentY);
                            lastChordEnd = lineX + chordWidth + 1; 
                        } else {
                            doc.setFont(undefined, 'normal'); doc.setFontSize(lyricSize); doc.setTextColor(0);
                            
                            // Splitta il testo parola per parola
                            let words = p.split(/(\s+)/); 
                            words.forEach(word => {
                                if (!word) return;
                                let wordWidth = doc.getTextWidth(word);
                                
                                // Se la singola parola sfora il limite destro della colonna
                                if (lineX + wordWidth > currentX + COL_WIDTH && lineX > currentX) {
                                    if (word.trim() === "") return; 
                                    
                                    currentY += (lineHeight + 4);
                                    checkLimit(lineHeight + 4);
                                    lineX = currentX;
                                    lastChordEnd = 0;
                                }
                                
                                doc.text(word, lineX, currentY + 4);
                                lineX += wordWidth;
                                if (lineX < lastChordEnd) lineX = lastChordEnd;
                            });
                        }
                    });
                    currentY += (lineHeight + 4); 
                } else {
                    const cleanLine = lineWithoutChords(l); // tiene (Rit.) (x2), toglie gli accordi
                    doc.setFont(undefined, 'normal'); doc.setFontSize(lyricSize); doc.setTextColor(0);
                    const splitText = doc.splitTextToSize(cleanLine, COL_WIDTH);
                    doc.text(splitText, lineX, currentY);
                    currentY += (splitText.length * lineHeight);
                }
            }
            currentY += 6; // Spazio tra canzoni
        }
    } // <--- CHIUSURA CORRETTA DEL CICLO SEZIONI

    // --- 4. STAMPA INDICE (Solo se richiesto) ---
    if (includeToc && tocPagesNeeded > 0 && tocData.length > 0) {
        let tocPageIdx = 2; // Pagina 1 è copertina
        doc.setPage(tocPageIdx); 
        
        doc.setTextColor(0, 51, 102); doc.setFont("helvetica", "bold"); doc.setFontSize(22);
        doc.text("INDICE", PAGE_WIDTH/2, 20, {align: 'center'});
        
        let tocY = 40;
        let tocCol = 1; 
        const TOC_COL_WIDTH = 80;
        const TOC_COL_1_X = 20;
        const TOC_COL_2_X = 115;
        
        tocData.forEach(item => {
            if(tocY > 270) {
                 if(tocCol === 1) { tocCol = 2; tocY = 40; } else { 
                     tocPageIdx++;
                     if (tocPageIdx <= 1 + tocPagesNeeded) {
                         doc.setPage(tocPageIdx);
                     } else {
                         doc.insertPage(tocPageIdx); doc.setPage(tocPageIdx);
                     }
                     tocCol = 1; tocY = 40;
                 }
            }
            let tx = tocCol === 1 ? TOC_COL_1_X : TOC_COL_2_X;
            
            if (item.type === 'section') {
                tocY += 5;
                doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(0);
                doc.text(item.text, tx, tocY);
                tocY += 5;
            } else {
                doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(50);
                let title = item.text;
                if (title.length > 35) title = title.substring(0, 32) + "...";
                doc.text(title, tx, tocY);
                doc.text(String(item.page), tx + TOC_COL_WIDTH, tocY, {align:'right'});
                tocY += 5;
            }
        });
    }

    // --- 5. NUMERAZIONE PAGINE (Solo se richiesto) ---
    if (includePageNumbers) {
        const totalPages = doc.internal.getNumberOfPages();
        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 && coverInput) continue; 
            doc.setPage(i);
            doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(150);
            doc.text(String(i), PAGE_WIDTH/2, 290, {align:'center'});
        }
    }

    doc.save("Canzoniere_Completo.pdf");
    if(document.getElementById("loadingOverlay")) document.getElementById("loadingOverlay").style.display="none"; 
    window.showToast("PDF Scaricato!", "success");
};
window.generateFullLatex = () => {
    if (!isAdmin) return;
    
    let l = `\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[a5paper]{geometry}\n\\usepackage{songs}\n\\begin{document}\n\\title{Canzoniere}\\maketitle\\tableofcontents\\newpage\n`;
    
    sectionOrder.forEach(secName => {
        l += `\\section{${latexEscape(secName)}}\n`;
        
        allSongs.filter(s => s.category === secName)
                .sort((a, b) => a.title.localeCompare(b.title))
                .forEach(s => {
                    // RECUPERA TONALITÀ SALVATA
                    const tr = s.savedTranspose || 0;

                    l += `\\beginsong{${latexEscape(s.title)}}[by={${latexEscape(s.author || '')}}]\n\\beginverse\n`;
                    
                    (s.lyrics || "").split("\n").forEach(line => {
                        // Accordi trasposti, annotazioni in corsivo, & % # _ protetti, **grassetto** e __corsivo__
                        l += latexLine(line, (p1) => chordDisplay(p1, tr)) + "\n";
                    });
                    
                    l += `\\endverse\n\\endsong\n`;
                });
    });
    
    l += `\\end{document}`;
    
    const b = new Blob([l], { type: 'text/plain' });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = "Canzoniere.tex";
    a.click();
};
// UTILS & EXTRAS
const fileToBase64 = file => new Promise((resolve, reject) => { const r = new FileReader(); r.readAsDataURL(file); r.onload = () => resolve(r.result); r.onerror = error => reject(error); });

// Le copertine delle sezioni finiscono DENTRO il documento Firestore e vengono scaricate a ogni apertura
// dell'app (e un documento Firestore non può superare 1 MB: una foto del telefono non ci sta nemmeno).
// Le ridimensiono a max 1200 px: per l'export PDF in A5 sono ancora ~200 dpi.
// Le PNG restano PNG (trasparenza intatta), le foto diventano JPEG.
const compressImageToDataUrl = (fileOrDataUrl, maxSide = 1200, quality = 0.82) => new Promise((resolve, reject) => {
    const isPng = typeof fileOrDataUrl === "string" ? fileOrDataUrl.startsWith("data:image/png") : fileOrDataUrl.type === "image/png";
    const img = new Image();
    img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(isPng ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    if (typeof fileOrDataUrl === "string") img.src = fileOrDataUrl;
    else fileToBase64(fileOrDataUrl).then(u => { img.src = u; }, reject);
});

window.openLoginModal=()=>mLogin.show();

function manageDynamicBackgrounds() {
    const bg = document.getElementById('dynamic-background');
    if (!bg) return;
    bg.style.display = 'block';

    const starsContainer = document.getElementById('night-stars-container');
    
    // Controlla la connessione internet all'avvio
    const isOnline = navigator.onLine; 

    // Applica le animazioni alle costellazioni principali SOLO se online
    if (isOnline) {
        document.querySelectorAll('.constellation-path, .c-star, .constellation-name').forEach(el => {
            el.classList.add('animated');
        });
    } else {
        // Se offline, mostra subito costellazioni senza animazioni CSS pesanti
        document.querySelectorAll('.constellation-path').forEach(el => {
            el.style.strokeDashoffset = '0';
        });
        document.querySelectorAll('.c-star, .constellation-name').forEach(el => {
            el.style.opacity = '1';
        });
    }

    // Genera centinaia di stelle realistiche (Via Lattea) solo se non sono già state create
    if (starsContainer && starsContainer.children.length === 0) {
        // Meno stelle se lo schermo è piccolo (telefono) per salvare la batteria e azzerare i lag
        const isMobile = window.innerWidth <= 768;
        const numStars = isMobile ? 60 : 350;
        
        for (let i = 0; i < numStars; i++) {
            const star = document.createElement('div');
            star.classList.add('real-star');
            
            // Se c'è internet, abilita il luccichio (twinkle)
            if (isOnline) {
                star.classList.add('real-star-animated');
                // Assegna una durata random per rendere il luccichio asincrono e naturale
                star.style.setProperty('--duration', (Math.random() * 3 + 2) + 's');
                star.style.animationDelay = (Math.random() * 5) + 's';
            }

            // Posizione casuale su tutto lo schermo
            star.style.left = Math.random() * 100 + 'vw';
            star.style.top = Math.random() * 100 + 'vh';

            // Dimensione casuale (le stelle reali variano molto in magnitudine)
            // Crea più stelle minuscole e poche stelle grandi
            const size = Math.random() > 0.9 ? (Math.random() * 1.5 + 1.5) : (Math.random() * 1 + 0.5);
            star.style.width = size + 'px';
            star.style.height = size + 'px';

            // Opacità casuale di base
            star.style.opacity = Math.random() * 0.8 + 0.2;
            
            // Leggera variazione di colore (azzurrognolo, bianco, giallino tenue)
            const colors = ['#ffffff', '#e6f0ff', '#fff4e6'];
            star.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];

            starsContainer.appendChild(star);
        }
    }
}
window.performLogin = async () => {
    if (document.activeElement) document.activeElement.blur();
    const emailField = document.getElementById('loginEmail');
    const passField = document.getElementById('loginPass');
    try {
        await signInWithEmailAndPassword(auth, emailField.value, passField.value);
        mLogin.hide();
        setTimeout(() => { if(document.getElementById('globalSearch')) document.getElementById('globalSearch').value=""; }, 500);
        emailField.value = ""; passField.value = "";
        showToast("Benvenuto!", 'success');
    } catch (e) { console.error(e); showToast("Errore login: controlla credenziali", 'danger'); }
};

window.logout=async()=>{await signOut(auth);window.location.reload();};
window.openAddSectionModal=()=>{document.getElementById("newSectionName").value="";mAddSection.show();};
window.createNewSection = async () => {
    const n = document.getElementById("newSectionName").value.trim();
    if (!n) return;
    await addDoc(collection(db, "sections"), { name: n, coverUrl: "" });
    mAddSection.hide(); showToast("Sezione creata"); loadData();
};
window.openSectionSettings=(id,name,url,e)=>{if(e)e.stopPropagation();const secObj=allSections.find(x=>x.id===id);if(url==null)url=secObj?secObj.coverUrl||"":"";if(secObj)name=secObj.name;editingSectionId=id;currentCategory=name;currentCoverUrl=url;document.getElementById("editSectionNameInput").value=name;document.getElementById("coverFileInput").value="";const img=document.getElementById("coverPreviewImg");img.src=url||"";img.style.display=url?'block':'none';mEditSection.show();};
window.previewCoverFile = () => {
    const fileInput = document.getElementById("coverFileInput");
    const f = fileInput.files[0];
    if (f) { const r = new FileReader(); r.onload = e => { const img = document.getElementById("coverPreviewImg"); img.src = e.target.result; img.style.display = 'block'; }; r.readAsDataURL(f); }
};
window.saveSectionSettings=async()=>{const n=document.getElementById("editSectionNameInput").value;const f=document.getElementById("coverFileInput").files[0];document.getElementById("loadingOverlay").style.display="flex";try{let u=currentCoverUrl;if(f)u=await compressImageToDataUrl(f);if(n!==currentCategory){const b=writeBatch(db);b.update(doc(db,"sections",editingSectionId),{name:n,coverUrl:u});allSongs.filter(s=>s.category===currentCategory).forEach(s=>b.update(doc(db,"songs",s.id),{category:n}));await b.commit();}else{await updateDoc(doc(db,"sections",editingSectionId),{coverUrl:u});}mEditSection.hide();showToast("Salvato");loadData();}catch(e){showToast(e.message,'danger');}finally{document.getElementById("loadingOverlay").style.display="none";}};
window.triggerDeleteSection = (id, name) => {
    if (!isSuperAdmin) return window.showToast("Non hai i permessi per eliminare.", "danger"); // NUOVA RIGA
    // 1. Controllo di sicurezza
    if (!id) return window.showToast("Errore: ID Sezione non valido", "danger");
    // ... resto del codice invariato

    // 2. Imposta le variabili
    editingSectionId = id;
    currentCategory = name;

    // 3. Rimuovi il focus dal pulsante
    if (document.activeElement) document.activeElement.blur();

    // 4. Avvia il modale di conferma
    window.confirmModal("Eliminare la sezione '" + name + "' e tutte le sue canzoni?", async () => {
        try {
            document.getElementById("loadingOverlay").style.display = "flex"; 
            
            // Cancella la sezione
            await deleteDoc(doc(db, "sections", editingSectionId));
            
            // Cancella le canzoni associate
            const b = writeBatch(db);
            const songsToDelete = allSongs.filter(s => s.category === currentCategory);
            songsToDelete.forEach(s => b.delete(doc(db, "songs", s.id)));
            await b.commit();

            // Reset interfaccia
            if(typeof mEditSection !== 'undefined') mEditSection.hide(); 
            currentCategory = null; 
            
            // MODIFICA QUI: Ricarica i dati ma NON tornare alla Home
            await loadData(); 
            // window.goHome(); <--- RIMOSSO
            window.renderManageSections(); // <--- AGGIUNTO: Ridisegna la lista gestione
            
            showToast("Sezione eliminata correttamente", "success");
        } catch(e) { 
            console.error(e);
            showToast("Errore eliminazione: " + e.message, 'danger'); 
        } finally { 
            document.getElementById("loadingOverlay").style.display = "none"; 
        }
    });
};
window.showAddModal=()=>{const s=document.getElementById("newSongCategorySelect");s.innerHTML="";allSections.forEach(sec=>s.innerHTML+=`<option value="${escapeHtml(sec.name)}">${escapeHtml(sec.name)}</option>`);document.getElementById("newSongTitle").value="";document.getElementById("newSongAuthor").value="";document.getElementById("newSongLyrics").value="";mAddSong.show();};
window.saveSong = async () => {
    const t = document.getElementById("lyricsEditor").value;
    const before = allSongs.find(x => x.id === currentSongId);
    if (before && (before.lyrics || "") !== t) recordHistory(before, "testo");
    try {
        // MODIFICA: Salviamo anche savedTranspose
        await updateDoc(doc(db,"songs",currentSongId), { 
            lyrics: t, 
            chords: window.extractChords(t),
            savedTranspose: currentTranspose // Salva la tonalità attuale (+2, -1, ecc)
        });
        
        // Aggiorniamo l'array locale
        const s = allSongs.find(x => x.id === currentSongId); 
        if(s) { 
            s.lyrics = t; 
            s.chords = window.extractChords(t); 
            s.savedTranspose = currentTranspose; // Aggiorna locale
        }
        
        hasUnsavedChanges = false; 
        showToast("Salvato con Tonalità " + (currentTranspose > 0 ? '+'+currentTranspose : currentTranspose), 'success');
        
        // Aggiorniamo la lista visuale per far apparire il bollino della tonalità se siamo tornati indietro
        if(currentCategory) window.renderList(allSongs.filter(song => song.category === currentCategory));
        
    } catch(e) { 
        showToast("Errore salvataggio: " + e.message, 'danger'); 
    }
};
window.deleteCurrentSong = () => {
    if (!isSuperAdmin) return window.showToast("Non hai i permessi per eliminare.", "danger");
    window.confirmModal('Eliminare definitivamente?', async () => {
        try {
            await deleteDoc(doc(db,"songs",currentSongId));
            allSongs = allSongs.filter(s => s.id !== currentSongId);
            
            window.updateTotalSongsCounter(); 

            if(favorites.includes(currentSongId)) { 
                favorites = favorites.filter(id => id !== currentSongId); 
                localStorage.setItem('scoutFavorites', JSON.stringify(favorites)); 
            }
            showToast("Canzone eliminata"); 
            window.goBackToList();
        } catch(e) { 
            showToast("Errore eliminazione: " + e.message, 'danger'); 
        }
    });
};

window.openSongMetadataModal = () => {
    const s = allSongs.find(x => x.id === currentSongId); if (!s) return;
    document.getElementById("editSongTitleInput").value = s.title || ""; document.getElementById("editSongAuthorInput").value = s.author || "";
    document.getElementById("editSongYearInput").value = s.year || ""; document.getElementById("editSongDescInput").value = s.description || "";
    const catSelect = document.getElementById("editSongCategorySelect"); catSelect.innerHTML = "";
    allSections.forEach(sec => { const opt = document.createElement("option"); opt.value = sec.name; opt.innerText = sec.name; if (sec.name === s.category) opt.selected = true; catSelect.appendChild(opt); });
    mEditSongMeta.show();
};
window.saveSongMetadata = async () => {
    const t = document.getElementById("editSongTitleInput").value; const a = document.getElementById("editSongAuthorInput").value;
    const y = document.getElementById("editSongYearInput").value; const d = document.getElementById("editSongDescInput").value;
    const newCategory = document.getElementById("editSongCategorySelect").value;
    if (!t) return showToast("Il titolo non può essere vuoto", "warning");
    if (checkTitleDuplicate(t, currentSongId, a)) return showToast(`Esiste già "${t}" dello stesso autore`, 'danger');
    document.getElementById("loadingOverlay").style.display = "flex";
    const before = allSongs.find(x => x.id === currentSongId);
    if (before && (before.title !== t || (before.author || "") !== a || (before.year || "") !== y || (before.description || "") !== d || before.category !== newCategory)) recordHistory(before, "dati");
    try {
        await updateDoc(doc(db, "songs", currentSongId), { title: t, author: a, year: y, description: d, category: newCategory });
        const s = allSongs.find(x => x.id === currentSongId); if(s) { s.title = t; s.author = a; s.year = y; s.description = d; s.category = newCategory; }
        mEditSongMeta.hide(); document.getElementById("editorTitle").innerText = t; document.getElementById("editorAuthor").innerText = a;
        let metaText = []; if(d) metaText.push(d); if(y) metaText.push(`(${y})`); document.getElementById("editorMeta").innerText = metaText.join(" - ");
        showToast("Dati aggiornati", "success");
    } catch (e) { showToast("Errore salvataggio: " + e.message, "danger"); } finally { document.getElementById("loadingOverlay").style.display = "none"; }
};
window.openProposalsView = () => {
    if (NAV_DELAY_MS > 0) document.getElementById("loadingOverlay").style.display = "flex";
    setTimeout(() => {
        window.switchView('view-proposals');
        const c = document.getElementById("proposalsContainer");
        c.innerHTML = "";
        if (allProposals.length === 0) c.innerHTML = "<div class='text-center mt-5 text-muted'>Nessuna proposta in attesa.</div>";
        
        allProposals.forEach(p => {
            let badge = "";
            let actions = "";
            let authorText = p.author || 'Sconosciuto';
            
            if (p._isSongReview) {
                // Layout per canzoni approvate dagli Admin (visto solo dal Superadmin)
                badge = `<span class="badge bg-info text-dark ms-2">Da confermare (Admin)</span>`;
                actions = `
                    <button class="btn btn-success btn-sm fw-bold" onclick="window.confirmAdminSong('${p.id}')" title="Conferma in via definitiva">
                        <i class="bi bi-check-lg"></i>
                    </button>
                    <button class="btn btn-outline-danger btn-sm" onclick="window.rejectAdminSong('${p.id}')" title="Rifiuta ed Elimina">
                        <i class="bi bi-trash"></i>
                    </button>
                `;
            } else {
                // Layout normale per proposte dei Guest
                actions = `
                    <button class="btn btn-warning btn-sm fw-bold" onclick="window.openProposalEditor('${p.id}')" title="Revisiona">
                        <i class="bi bi-pencil-square"></i> Revisiona
                    </button>
                    <button class="btn btn-outline-danger btn-sm" onclick="window.rejectProposal('${p.id}')" title="Rifiuta">
                        <i class="bi bi-trash"></i>
                    </button>
                `;
            }

            c.innerHTML += `
            <div class="card mb-3 shadow-sm border-secondary" style="background: #222;">
                <div class="card-body d-flex justify-content-between align-items-center">
                    <div class="overflow-hidden">
                        <h5 class="fw-bold mb-1 text-white">${escapeHtml(p.title)} ${badge}</h5>
                        <small class="text-muted d-block text-truncate">
                            ${escapeHtml(authorText)} &bull; ${escapeHtml(p.category)}
                        </small>
                        <small class="text-secondary fst-italic">Proposto da: ${escapeHtml(p.proposer || (p._isSongReview ? 'Admin' : 'Anonimo'))}</small>
                    </div>
                    <div class="d-flex gap-2 flex-shrink-0">
                        ${actions}
                    </div>
                </div>
            </div>`;
        });
        document.getElementById("loadingOverlay").style.display = "none";
    }, NAV_DELAY_MS);
};
window.acceptProposal=(id)=>window.confirmModal("Approvare?",async()=>{const p=allProposals.find(x=>x.id===id);await addDoc(collection(db,"songs"),{title:p.title,author:p.author,category:p.category,lyrics:p.lyrics,chords:window.extractChords(p.lyrics)});await deleteDoc(doc(db,"proposals",id));showToast("Approvata!",'success');await loadProposals();loadData();window.openProposalsView();});
window.rejectProposal=(id)=>window.confirmModal("Rifiutare?",async()=>{await deleteDoc(doc(db,"proposals",id));await loadProposals();window.openProposalsView();});
window.confirmAdminSong = async (id) => {
    document.getElementById("loadingOverlay").style.display = "flex";
    try {
        await updateDoc(doc(db, "songs", id), { needsSuperAdminReview: false });
        const s = allSongs.find(x => x.id === id);
        if (s) s.needsSuperAdminReview = false; // Aggiorna in memoria locale
        
        showToast("Canzone confermata definitivamente!", "success");
        await loadProposals();
        window.openProposalsView();
    } catch(e) {
        showToast("Errore: " + e.message, "danger");
    } finally {
        document.getElementById("loadingOverlay").style.display = "none";
    }
};

window.rejectAdminSong = (id) => {
    window.confirmModal("Vuoi eliminare questa canzone aggiunta da un admin?", async () => {
        document.getElementById("loadingOverlay").style.display = "flex";
        try {
            await deleteDoc(doc(db, "songs", id));
            allSongs = allSongs.filter(s => s.id !== id);
            window.updateTotalSongsCounter();
            
            showToast("Canzone eliminata!", "success");
            await loadProposals();
            window.openProposalsView();
        } catch(e) {
            showToast("Errore: " + e.message, "danger");
        } finally {
            document.getElementById("loadingOverlay").style.display = "none";
        }
    });
};

// Notifiche e conferme nello stile dell'app (ui.js) al posto dei toast di Bootstrap e di confirm() del browser
window.showToast = (m, t = 'info') => notify(m, t);
window.confirmModal = (m, c, opts = {}) => {
    const danger = opts.danger ?? /elimin|rifiut|cancell|sovrascriv/i.test(m);
    appConfirm(m, { title: opts.title || (danger ? "Attenzione" : "Conferma"), danger, okText: opts.okText || (danger ? "Sì, procedi" : "Conferma") })
        .then(ok => { if (ok) c(); });
};
window.notify = notify;
// --- GESTIONE CRONOLOGIA E TASTO INDIETRO ---
let isNavigatingBack = false;

// Imposta lo stato iniziale appena si carica la pagina
window.addEventListener('load', () => {
    history.replaceState({ view: 'view-dashboard' }, '', '#home');
});

// Ascolta il tasto indietro fisico del telefono
window.addEventListener('popstate', (event) => {
    // Tasto indietro in modalità esibizione: chiude solo quella
    if (perform && !(event.state && event.state.perform)) { window.closePerform(true); return; }
    closeAllSheets();
    // Tasto indietro del telefono dall'editor con modifiche non salvate: resto e chiedo
    const editorView = document.getElementById('view-editor');
    if (hasUnsavedChanges && editorView && editorView.classList.contains('active') && !(event.state && event.state.view === 'view-editor')) {
        history.pushState({ view: 'view-editor' }, '', '#view-editor');
        confirmLeaveEditor().then(ok => { if (ok) { hasUnsavedChanges = false; history.back(); } });
        return;
    }
    if (event.state && event.state.view) {
        isNavigatingBack = true; 
        
        // Pulizia variabili in base a dove stiamo tornando
        if (event.state.view === 'view-dashboard') {
            currentCategory = null;
            currentSongId = null;
        } else if (event.state.view === 'view-list') {
            currentSongId = null;
        }

        // Cambia la vista graficamente
        window.switchView(event.state.view);
        
        // Ricarica i dati necessari per la vista
        if (event.state.view === 'view-list' && currentCategory) {
            window.renderList(allSongs.filter(s => s.category === currentCategory));
        } else if (event.state.view === 'view-doctor') {
            refreshDoctor(); // dopo aver corretto una canzone la lista si aggiorna
        } else if (event.state.view === 'view-setlists') {
            if (currentSetlistId) {
                document.getElementById('activeSetlistDetail').style.display = 'block';
                document.getElementById('setlistsContainer').innerHTML = "";
                window.renderActiveSetlistSongs();
            } else {
                document.getElementById('activeSetlistDetail').style.display = 'none';
                window.renderSetlistsList();
            }
        }
    }
});

// Nuova funzione switchView che aggiorna la cronologia
window.switchView = (id) => {
    if (id !== 'view-editor' && autoScrollInterval) window.toggleAutoScroll();
    document.querySelectorAll('.view-screen').forEach(el => el.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    window.scrollTo(0, 0);
    
    // Se la chiamata non arriva dal tasto indietro, aggiungiamo una "pagina" alla cronologia
    if (!isNavigatingBack) {
        history.pushState({ view: id }, '', `#${id}`);
    }
    isNavigatingBack = false;
};

// Modifichiamo i tasti UI in modo che usino la cronologia del telefono
window.goHome = () => { 
    if (history.state && history.state.view !== 'view-dashboard') {
        history.back(); // Simula la pressione del tasto indietro
    } else {
        currentCategory = null; currentSongId = null; 
        const searchInput = document.getElementById('globalSearch'); 
        if(searchInput) searchInput.value = ""; 
        window.renderDashboard(); 
    }
};

const confirmLeaveEditor = () => appConfirm("Hai modifiche non salvate in questa canzone. Vuoi uscire senza salvare?",
    { title: "Modifiche non salvate", okText: "Esci senza salvare", cancelText: "Resta", danger: true });
window.goBackToList = () => { 
    if (hasUnsavedChanges) {
        confirmLeaveEditor().then(ok => { if (ok) { hasUnsavedChanges = false; history.back(); } });
        return;
    }
    history.back(); // Simula la pressione del tasto indietro del telefono
};
window.changeTone=(d)=>{currentTranspose+=d;document.getElementById("toneDisplay").innerText=currentTranspose>0?"+"+currentTranspose:String(currentTranspose);window.renderPreview();};
window.adjustFontSize=(d)=>{currentFontSize=Math.min(40,Math.max(8,currentFontSize+d));window.renderPreview();};
window.toggleChords=()=>document.getElementById('previewArea').classList.toggle('hide-chords');
window.toggleFavorite=()=>{if(favorites.includes(currentSongId))favorites=favorites.filter(id=>id!==currentSongId);else{favorites.push(currentSongId);showToast("Aggiunta ai preferiti",'success');}localStorage.setItem('scoutFavorites',JSON.stringify(favorites));updateFavIcon();};
function updateFavIcon(){document.getElementById('favIcon').className=favorites.includes(currentSongId)?"bi bi-star-fill":"bi bi-star";}
window.processTxtImport = () => {
    const fileInput = document.getElementById("txtImporter"); const file = fileInput.files[0]; if (!file) return;
    appConfirm(`Importare le canzoni da "${file.name}"?`, { title: "Importa da TXT", okText: "Importa" }).then(ok => {
    if (!ok) { fileInput.value = ""; return; }
    const reader = new FileReader();
    reader.onload = async (e) => {
        const text = e.target.result; const lines = text.split('\n'); document.getElementById("loadingOverlay").style.display = "flex";
        let batch = writeBatch(db); let operationCount = 0; let currentSectionName = "Generale"; const processedSections = new Set(allSections.map(s => s.name));
        try {
            for (let line of lines) {
                line = line.trim(); if (!line) continue;
                if (line.includes("SEZIONE:")) {
                    let secName = line.split("SEZIONE:")[1].replace(/=/g, '').trim(); secName = secName.charAt(0).toUpperCase() + secName.slice(1).toLowerCase(); currentSectionName = secName;
                    if (!processedSections.has(currentSectionName)) { batch.set(doc(collection(db, "sections")), { name: currentSectionName, coverUrl: "" }); processedSections.add(currentSectionName); operationCount++; }
                    continue;
                }
                const songMatch = line.match(/^(\d+)\.\s+(.*)/);
                if (songMatch) {
                    let rawContent = songMatch[2]; let title = rawContent; let author = "";
                    if (rawContent.includes("- Autore:")) { const split = rawContent.split("- Autore:"); title = split[0].trim(); author = split[1].trim(); }
                    batch.set(doc(collection(db, "songs")), { title: title, author: author, category: currentSectionName, lyrics: "", chords: [], added: true, year: "", description: "" }); operationCount++;
                }
                if (operationCount >= 450) { await batch.commit(); batch = writeBatch(db); operationCount = 0; } // un batch già inviato non si può riusare
            }
            if (operationCount > 0) await batch.commit(); showToast("Importazione completata!", "success"); loadData(); 
        } catch (error) { showToast("Errore import: " + error.message, "danger"); } finally { document.getElementById("loadingOverlay").style.display = "none"; fileInput.value = ""; }
    };
    reader.readAsText(file);
    });
};
const normalizeStr = (str) => str ? str.trim().toLowerCase() : "";
function checkTitleDuplicate(title, excludeId = null, author = "") { return allSongs.some(s => { if (excludeId && s.id === excludeId) return false; return isSameSong(title, author, s.title, s.author); }); }
window.openSetlistsView = () => { 
    if (NAV_DELAY_MS > 0) document.getElementById("loadingOverlay").style.display = "flex";
    setTimeout(() => {
        switchView('view-setlists'); 
        window.renderSetlistsList(); 
        document.getElementById('activeSetlistDetail').style.display = 'none'; 
        currentSetlistId = null; 
        document.getElementById("loadingOverlay").style.display = "none";
    }, NAV_DELAY_MS);
};
window.renderSetlistsList = () => {
    const c = document.getElementById("setlistsContainer"); c.innerHTML = "";
    if (allSetlists.length === 0) { c.innerHTML = `<div class="text-center text-muted p-3">Nessuna scaletta pubblica presente. Creane una!</div>`; return; }
    allSetlists.forEach(sl => { c.innerHTML += `<button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" onclick="window.openSetlistDetail('${sl.id}')"><div class="fw-bold"><i class="bi bi-folder2-open me-2 text-warning"></i>${escapeHtml(sl.name)}</div><span class="badge bg-secondary rounded-pill">${sl.songs.length}</span></button>`; });
};
// NUOVA FUNZIONE CREAZIONE SCALETTA (POPUP)
window.confirmCreateSetlist = async () => {
    const name = document.getElementById("newSetlistNameInput").value.trim();
    if (!name) return showToast("Inserisci un nome", "warning");
    
    mCreateSetlist.hide(); 
    document.getElementById("loadingOverlay").style.display = "flex";
    
    try { 
        const docRef = await addDoc(collection(db, "setlists"), { 
            name: name, 
            songs: [], 
            createdAt: Date.now() 
        });
        
        // --- SALVA PROPRIETÀ NEL BROWSER ---
        let mySetlists = JSON.parse(localStorage.getItem('mySetlists')) || [];
        mySetlists.push(docRef.id);
        localStorage.setItem('mySetlists', JSON.stringify(mySetlists));
        // -----------------------------------

        await loadData(); // Qui ricarichiamo per vedere la nuova scaletta
        showToast("Scaletta creata!", "success"); 
    } catch(e) { 
        showToast("Errore: " + e.message, 'danger'); 
    } finally { 
        document.getElementById("loadingOverlay").style.display = "none"; 
    }
};
window.openSetlistDetail = (id) => {
    if (!isFirstLoad && NAV_DELAY_MS > 0) {
        document.getElementById("loadingOverlay").style.display = "flex";
        startLoaderAnimation();
    }
    
    const waitTime = isFirstLoad ? 0 : NAV_DELAY_MS;

    setTimeout(() => {
        currentSetlistId = id;
        const sl = allSetlists.find(s => s.id === id);
        // Nota: se non trova la scaletta, nascondiamo comunque il loader per evitare blocchi
        if (!sl) { document.getElementById("loadingOverlay").style.display = "none"; return; }

        const mySetlists = JSON.parse(localStorage.getItem('mySetlists')) || [];
        const isOwner = mySetlists.includes(id);
        
        if (isOwner) { document.body.classList.add('is-owner'); } 
        else { document.body.classList.remove('is-owner'); }
        
        switchView('view-setlists'); 
        document.getElementById('setlistsContainer').innerHTML = "";
        document.getElementById('activeSetlistDetail').style.display = 'block';
        document.getElementById('activeSetlistTitle').innerText = sl.name;
        
        window.renderActiveSetlistSongs();
        
        if (!isFirstLoad) {
            document.getElementById("loadingOverlay").style.display = "none";
        }
    }, waitTime);
};
window.renderActiveSetlistSongs = () => {
    const sl = allSetlists.find(s => s.id === currentSetlistId); 
    if(!sl) return; 
    const c = document.getElementById("setlistSongsContainer"); 
    c.innerHTML = "";
    
    if(sl.songs.length === 0) { 
        document.getElementById('emptySetlistMsg').style.display = 'block'; 
        return; 
    }
    document.getElementById('emptySetlistMsg').style.display = 'none';

    sl.songs.forEach((item, idx) => {
        const sId = typeof item === 'string' ? item : item.id; 
        const savedTrans = typeof item === 'object' ? (item.trans || 0) : 0; 
        const song = allSongs.find(s => s.id === sId); 
        if(!song) return; 
        
        let snippetHtml = generateSnippetHtml(song.lyrics, savedTrans);
        
        // NOTA: Aggiunta classe 'setlist-item-controls' al div dei bottoni
        c.innerHTML += `
        <div class="list-group-item p-3" id="setlist-item-${idx}">
            <div class="d-flex justify-content-between align-items-start">
                <div class="text-truncate" style="cursor:pointer; flex-grow: 1;" onclick="document.getElementById('preview-box-${idx}').classList.toggle('d-none')">
                    <strong class="text-primary">${idx + 1}. ${escapeHtml(song.title)}</strong>
                    <div class="small text-muted">${escapeHtml(song.author || '')} 
                        <span class="badge bg-light text-dark border ms-2" id="badge-trans-${idx}" data-val="${savedTrans}">Tono: ${savedTrans > 0 ? '+'+savedTrans : savedTrans}</span>
                    </div>
                </div>
                
                <div class="btn-group btn-group-sm ms-2 setlist-item-controls">
                    <button class="btn btn-outline-secondary" onclick="window.moveSetlistSong(${idx}, -1)">⬆</button>
                    <button class="btn btn-outline-secondary" onclick="window.moveSetlistSong(${idx}, 1)">⬇</button>
                    <button class="btn btn-outline-danger" onclick="window.removeFromSetlist(${idx})"><i class="bi bi-trash"></i></button>
                </div>
            </div>
            
            <div id="preview-box-${idx}" class="mt-2 p-3 bg-white rounded d-none border shadow-sm">
                <div id="snippet-content-${idx}" class="mb-3" style="font-family: monospace; line-height: 1.8; white-space: pre-wrap; font-size: 0.95rem;">${snippetHtml}</div>
                
                <div class="d-flex align-items-center justify-content-between bg-light p-2 rounded">
                    <div class="d-flex align-items-center gap-2 setlist-item-controls">
                        <span class="small fw-bold text-uppercase">Cambia:</span>
                        <button class="btn btn-sm btn-outline-primary fw-bold" style="width:30px" onclick="window.changeSetlistPreviewTone(${idx}, '${sId}', -1)">-</button>
                        <button class="btn btn-sm btn-outline-primary fw-bold" style="width:30px" onclick="window.changeSetlistPreviewTone(${idx}, '${sId}', 1)">+</button>
                        <button class="btn btn-sm btn-success ms-2" onclick="window.saveSetlistSongTone(${idx})"><i class="bi bi-check-lg"></i> Salva</button>
                    </div>
                    <button class="btn btn-sm btn-outline-dark ms-auto" onclick="window.openEditor('${sId}')">Canzone Completa</button>
                </div>
            </div>
        </div>`;
    });
};
window.changeSetlistPreviewTone = (idx, songId, delta) => { const badge = document.getElementById(`badge-trans-${idx}`); const snippetDiv = document.getElementById(`snippet-content-${idx}`); let currentVal = parseInt(badge.getAttribute('data-val')); let newVal = currentVal + delta; badge.setAttribute('data-val', newVal); badge.innerText = `Tono: ${newVal > 0 ? '+' + newVal : newVal}`; badge.classList.remove('bg-light', 'text-dark'); badge.classList.add('bg-warning', 'text-dark'); const song = allSongs.find(s => s.id === songId); if (song) snippetDiv.innerHTML = generateSnippetHtml(song.lyrics, newVal); };
window.saveSetlistSongTone = async (idx) => { const sl = allSetlists.find(s => s.id === currentSetlistId); if(!sl) return; const badge = document.getElementById(`badge-trans-${idx}`); const finalVal = parseInt(badge.getAttribute('data-val')); const newSongs = [...sl.songs]; let item = newSongs[idx]; if (typeof item === 'string') item = { id: item, trans: 0 }; else item = { ...item }; item.trans = finalVal; newSongs[idx] = item; try { await updateDoc(doc(db, "setlists", currentSetlistId), { songs: newSongs }); } catch (e) { return showToast("Errore salvataggio: " + e.message, "danger"); } sl.songs = newSongs; badge.classList.remove('bg-warning'); badge.classList.add('bg-light'); showToast("Tonalità salvata!", "success"); };
function generateSnippetHtml(lyrics, transposeVal) {
    if (!lyrics) return "...";
    
    // Prende le prime 4 righe
    const lines = lyrics.split('\n').slice(0, 4);
    
    return lines.map(line => {
        // Stessa impaginazione dell'editor: accordi distanziati, annotazioni non trasposte
        const formattedLine = layoutLine(line, transposeVal).map(seg => {
            if (seg.kind === "chord") return `<span class="snippet-chord">${escapeHtml(seg.display)}</span>`;
            if (seg.kind === "note") return `<span class="chord-note">${escapeHtml(seg.text)}</span>`;
            return escapeHtml(seg.text);
        }).join("");
        
        // Avvolgiamo la riga
        return `<div class="snippet-line">${formattedLine || '&nbsp;'}</div>`;
    }).join(''); 
}
window.deleteActiveSetlist = () => window.confirmModal("Eliminare questa scaletta?", async () => { try { await deleteDoc(doc(db, "setlists", currentSetlistId)); await loadData(); window.openSetlistsView(); showToast("Scaletta eliminata"); } catch(e) { showToast("Errore eliminazione", "danger"); } });
async function updateSetlistSongs(setlistId, newSongsArray) { try { const localSl = allSetlists.find(s => s.id === setlistId); if(localSl) localSl.songs = newSongsArray; if(currentSetlistId === setlistId) window.renderActiveSetlistSongs(); await updateDoc(doc(db, "setlists", setlistId), { songs: newSongsArray }); } catch(e) { showToast("Errore sync", "danger"); await loadData(); } }
window.moveSetlistSong = (idx, dir) => { const sl = allSetlists.find(s => s.id === currentSetlistId); if (!sl) return; if (idx + dir < 0 || idx + dir >= sl.songs.length) return; const newSongs = [...sl.songs]; const temp = newSongs[idx]; newSongs[idx] = newSongs[idx + dir]; newSongs[idx + dir] = temp; updateSetlistSongs(currentSetlistId, newSongs); };
window.removeFromSetlist = (idx) => { const sl = allSetlists.find(s => s.id === currentSetlistId); if (!sl) return; const newSongs = [...sl.songs]; newSongs.splice(idx, 1); updateSetlistSongs(currentSetlistId, newSongs); };
window.openAddToSetlistModal = () => { const c = document.getElementById('setlistSelectorContainer'); c.innerHTML = ""; if (allSetlists.length === 0) c.innerHTML = "<div class='small text-muted text-center'>Nessuna scaletta.</div>"; else allSetlists.forEach(sl => { c.innerHTML += `<button class="list-group-item list-group-item-action py-2" onclick="window.addSongToSetlistId('${sl.id}')">${escapeHtml(sl.name)}</button>`; }); mAddToSetlist.show(); };
window.createNewSetlistFromModal = async () => { const name = await appPrompt("Come la chiamiamo?", "", { title: "Nuova scaletta", okText: "Crea", placeholder: "Es. Fuoco di bivacco" }); if(name) { try { const docRef = await addDoc(collection(db, "setlists"), { name: name, songs: [], createdAt: Date.now() }); try { const mine = JSON.parse(localStorage.getItem('mySetlists')) || []; mine.push(docRef.id); localStorage.setItem('mySetlists', JSON.stringify(mine)); } catch (err) {} await loadData(); window.addSongToSetlistId(docRef.id); } catch(e) { showToast("Errore"); } } };
window.addSongToSetlistId = async (setId) => { const sl = allSetlists.find(s => s.id === setId); if (sl) { const isPresent = sl.songs.some(item => { const id = typeof item === 'string' ? item : item.id; return id === currentSongId; }); if (isPresent) { showToast("Già presente", 'warning'); return; } try { const newSongEntry = { id: currentSongId, trans: 0 }; await updateDoc(doc(db, "setlists", setId), { songs: arrayUnion(newSongEntry) }); sl.songs.push(newSongEntry); showToast(`Aggiunta a "${sl.name}"`, 'success'); mAddToSetlist.hide(); } catch (e) { showToast("Errore", 'danger'); } } };
window.openSetlistExportModal = () => { document.getElementById('setlistCoverInputModal').value = ""; mExportSetlist.show(); };
window.confirmSetlistPDF = async () => {
    const sl = allSetlists.find(s => s.id === currentSetlistId);
    if(!sl || sl.songs.length === 0) return showToast("Scaletta vuota", "warning");

    // --- LETTURA OPZIONI ---
    const isTwoColumns = document.getElementById("setlistTwoColumns").checked;
    const showChords = document.getElementById("setlistShowChords").checked;
    const includeToc = document.getElementById("setlistShowToc").checked;
    const includePageNumbers = document.getElementById("setlistShowPageNumbers").checked;
    const fontSizeMode = document.getElementById("setlistFontSize").value;

    // Configurazione Font (Identica al PDF completo)
    let titleSize = 12, metaSize = 9, lyricSize = 9, chordSize = 9, lineHeight = 5;
    if (fontSizeMode === 'small') {
        titleSize = 11; lyricSize = 8; chordSize = 8; lineHeight = 4;
    } else if (fontSizeMode === 'large') {
        titleSize = 14; lyricSize = 11; chordSize = 11; lineHeight = 6;
    } else {
        titleSize = 12; lyricSize = 10; chordSize = 10; lineHeight = 5;
    }

    mExportSetlist.hide();
    document.getElementById("loadingOverlay").style.display = "flex";

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ format: 'a4', orientation: 'portrait', unit: 'mm' });

        const PAGE_WIDTH = 210;
        const PAGE_HEIGHT = 297;
        const MARGIN_TOP = 15;
        const MARGIN_BOTTOM = 280;
        const SIDE_MARGIN = 15;
        const GUTTER = 10;
        
        // Copertina
        const coverInput = document.getElementById('setlistCoverInputModal');
        let hasCover = false;
        if (coverInput && coverInput.files && coverInput.files[0]) {
            const coverBase64 = await fileToBase64(coverInput.files[0]);
            doc.addImage(coverBase64, 'JPEG', 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
            doc.setFillColor(255, 255, 255); doc.rect(0, 100, PAGE_WIDTH, 25, 'F');
            doc.setFont("helvetica", "bold"); doc.setFontSize(26); doc.setTextColor(0, 51, 102);
            doc.text(sl.name.toUpperCase(), PAGE_WIDTH/2, 117, {align: 'center'});
            hasCover = true;
        }

        // Indice (Opzionale)
        let tocData = [];
        if (includeToc) {
            if(hasCover) doc.addPage();
            else if(!hasCover) { /* Se non c'è copertina, l'indice è la pag 1, o si aggiunge dopo */ }
            
            // Se c'è copertina siamo a pag 2. Se no, siamo a pag 1.
            // Riserviamo una pagina per l'indice
            if(!hasCover) {
                // Se non c'è copertina, creiamo una pagina di titolo + indice
                doc.setFont("helvetica", "bold"); doc.setFontSize(22); doc.setTextColor(0, 51, 102);
                doc.text(sl.name.toUpperCase(), PAGE_WIDTH/2, 20, {align: 'center'});
                // Spazio per indice
            } else {
                 doc.addPage(); // Pagina dedicata indice
            }
        } else {
             // NO INDICE
             if(hasCover) doc.addPage();
             else {
                // Pagina 1: Titolo in alto
                doc.setFont("helvetica", "bold"); doc.setFontSize(22); doc.setTextColor(0, 51, 102);
                doc.text(sl.name.toUpperCase(), PAGE_WIDTH/2, 20, {align: 'center'});
             }
        }

        // Setup Colonne
        const COL_WIDTH = isTwoColumns ? (PAGE_WIDTH - (SIDE_MARGIN * 2) - GUTTER) / 2 : (PAGE_WIDTH - (SIDE_MARGIN * 2));
        const COL_1_X = SIDE_MARGIN;
        const COL_2_X = isTwoColumns ? (SIDE_MARGIN + COL_WIDTH + GUTTER) : SIDE_MARGIN;

        let currentX = COL_1_X;
        let currentY = MARGIN_TOP;
        let pageOneStartY = MARGIN_TOP; // SALVIAMO LA Y INIZIALE DELLA PAGINA 1
        
        if (!hasCover && !includeToc && doc.internal.getNumberOfPages() === 1) {
            currentY = 35;
            pageOneStartY = 35; // Aggiorniamo se c'è il titolo
        }
        
        let currentCol = 1;
        
        const checkLimit = (heightNeeded) => {
            if (currentY + heightNeeded > MARGIN_BOTTOM) {
                if (isTwoColumns && currentCol === 1) {
                    currentCol = 2;
                    currentX = COL_2_X;
                    // FIX: Controlliamo se siamo sulla pagina col titolo
                    const isTitlePage = (!hasCover && !includeToc && doc.internal.getNumberOfPages() === 1);
                    currentY = isTitlePage ? pageOneStartY : MARGIN_TOP;
                    // Fix: se siamo a pag 1 e c'è titolo, la colonna 2 deve partire dall'alto (MARGIN_TOP), non sotto il titolo
                } else {
                    doc.addPage();
                    currentCol = 1;
                    currentX = COL_1_X;
                    currentY = MARGIN_TOP;
                }
                return true;
            }
            return false;
        };

        // --- LOOP CANZONI ---
        for (const item of sl.songs) {
            const sId = typeof item === 'string' ? item : item.id;
            const sTrans = typeof item === 'object' ? (item.trans || 0) : 0;
            const s = allSongs.find(x => x.id === sId);
            if(!s) continue;
            
            if(includeToc) {
                tocData.push({ title: s.title, page: doc.internal.getCurrentPageInfo().pageNumber });
            }
            
            checkLimit(30);

            // Titolo
            doc.setFont("helvetica", "bold"); doc.setFontSize(titleSize); doc.setTextColor(0, 51, 102);
            const titleLines = doc.splitTextToSize((s.title || "").toUpperCase(), COL_WIDTH);
            doc.text(titleLines, currentX, currentY);
            currentY += (titleLines.length * (lineHeight));
            
            // Autore
            if(s.author) {
                doc.setFont("helvetica", "italic"); doc.setFontSize(metaSize); doc.setTextColor(100);
                const authTxt = s.year ? `${s.author} (${s.year})` : s.author;
                doc.text(authTxt, currentX + COL_WIDTH, currentY, {align: 'right'});
            }
            currentY += 2;

            // Descrizione
            if (s.description) {
                doc.setFont("helvetica", "italic"); doc.setFontSize(metaSize - 1); doc.setTextColor(50);
                const noteWidth = COL_WIDTH - 4; 
                const splitNotes = doc.splitTextToSize(s.description, noteWidth);
                const blockHeight = (splitNotes.length * 3.5) + 4;
                checkLimit(blockHeight);
                doc.setFillColor(245, 245, 245);
                doc.rect(currentX, currentY, COL_WIDTH, blockHeight, 'F');
                doc.text(splitNotes, currentX + 2, currentY + 3.5);
                currentY += blockHeight + 2;
            } else {
                currentY += 2; 
            }
            
            // Linea
            doc.setDrawColor(200); doc.setLineWidth(0.2);
            doc.line(currentX, currentY, currentX + COL_WIDTH, currentY);
            currentY += 4;

            // Testo
            doc.setFont("helvetica", "normal"); doc.setFontSize(lyricSize); doc.setTextColor(0);
            const lines = (s.lyrics || "").split("\n");
            
            for (let l of lines) {
                l = l.replace(/\*\*|__/g, '');
                const parts = l.split(/(\[.*?\])/);
                const hasChords = parts.some(p => p.startsWith("["));
                const heightNeeded = (hasChords && showChords) ? (lineHeight * 2) : lineHeight;
                
                checkLimit(heightNeeded);
                
                let lineX = currentX;

               if (hasChords && showChords) { 
                let lastChordEnd = 0; 
                parts.forEach(p => {
                    if (p.startsWith("[")) {
                        let c = p.replace(/[\[\]]/g,'');
                        c = chordDisplay(c, sTrans); // <-- Qui usiamo sTrans (annotazioni non trasposte)
                        doc.setFont(undefined, 'bold'); doc.setFontSize(chordSize); doc.setTextColor(220, 53, 69);
                        if (lineX < lastChordEnd) lineX = lastChordEnd; // [Do][Sol]: non sovrapporre i due accordi
                        
                        const chordWidth = doc.getTextWidth(c);
                        if (lineX + chordWidth > currentX + COL_WIDTH && lineX > currentX) {
                            currentY += (lineHeight + 4);
                            checkLimit(lineHeight + 4);
                            lineX = currentX;
                            lastChordEnd = 0;
                        }
                        
                        doc.text(c, lineX, currentY);
                        lastChordEnd = lineX + chordWidth + 1; 
                    } else {
                        doc.setFont(undefined, 'normal'); doc.setFontSize(lyricSize); doc.setTextColor(0);
                        
                        let words = p.split(/(\s+)/); 
                        words.forEach(word => {
                            if (!word) return;
                            let wordWidth = doc.getTextWidth(word);
                            
                            if (lineX + wordWidth > currentX + COL_WIDTH && lineX > currentX) {
                                if (word.trim() === "") return; 
                                
                                currentY += (lineHeight + 4);
                                checkLimit(lineHeight + 4);
                                lineX = currentX;
                                lastChordEnd = 0;
                            }
                            
                            doc.text(word, lineX, currentY + 4);
                            lineX += wordWidth;
                            if (lineX < lastChordEnd) lineX = lastChordEnd;
                        });
                    }
                });
                currentY += (lineHeight + 4); 
            } else {
                    const cleanLine = lineWithoutChords(l); // tiene (Rit.) (x2), toglie gli accordi
                    doc.setFont(undefined, 'normal'); doc.setFontSize(lyricSize); doc.setTextColor(0);
                    const splitText = doc.splitTextToSize(cleanLine, COL_WIDTH);
                    doc.text(splitText, lineX, currentY);
                    currentY += (splitText.length * lineHeight);
                }
            }
            currentY += 8; 
        }

        // --- STAMPA INDICE SCALETTA (Se richiesto) ---
        if (includeToc && tocData.length > 0) {
            // Torna indietro alla pagina dell'indice (Pagina 2 se c'è cover, Pagina 1 se no ma abbiamo fatto spazio?)
            // Per semplicità, in setlist, l'indice lo mettiamo alla fine o in una pagina nuova se richiesto specificamente,
            // Ma per farlo bene, usiamo insertPage(1) o (2).
            
            const indexPageNum = hasCover ? 2 : 1;
            doc.insertPage(indexPageNum);
            doc.setPage(indexPageNum);

            doc.setTextColor(0, 51, 102); doc.setFont("helvetica", "bold"); doc.setFontSize(22);
            doc.text("INDICE SCALETTA", PAGE_WIDTH/2, 20, {align: 'center'});
            
            let tocY = 40;
            doc.setFontSize(11);
            
            tocData.forEach(t => {
                if(tocY > 270) { doc.addPage(); tocY=20; }
                doc.setTextColor(0); doc.setFont("helvetica", "bold");
                doc.text(t.title, 20, tocY);
                // I numeri di pagina sono shiftati di +1 perché abbiamo inserito la pagina indice
                doc.setTextColor(100); doc.setFont("helvetica", "normal");
                // Attenzione: i numeri pagina salvati nel loop erano Pre-Insert. Quindi +1.
                doc.text(String(t.page + 1), 190, tocY, {align: 'right'});
                doc.setDrawColor(230); doc.line(20, tocY+2, 190, tocY+2);
                tocY += 8;
            });
        }

        // --- NUMERI PAGINA ---
        if (includePageNumbers) {
            const totalPages = doc.internal.getNumberOfPages();
            for (let i = 1; i <= totalPages; i++) {
                if (i === 1 && hasCover) continue;
                doc.setPage(i);
                doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(150);
                doc.text(String(i), PAGE_WIDTH/2, 290, {align:'center'});
            }
        }
        
        doc.save(`Scaletta_${sl.name.replace(/\s+/g, '_')}.pdf`);
    } catch (e) {
        console.error(e);
        showToast("Errore PDF: " + e.message, "danger");
    } finally {
        document.getElementById("loadingOverlay").style.display = "none";
    }
};
window.openSearchForSetlistModal = () => { document.getElementById("searchSetlistInput").value = ""; window.performSetlistSearch(); mSearchSetlist.show(); };
window.performSetlistSearch = () => {
    const q = robustNormalize(document.getElementById("searchSetlistInput").value);
    const c = document.getElementById("searchSetlistResults");
    
    let allRes;
    
    // Se è vuoto, prendi tutto ordinato. Altrimenti filtra per ricerca.
    if (q.trim() === "") {
        allRes = [...allSongs].sort((a,b) => a.title.localeCompare(b.title));
    } else {
        allRes = allSongs.filter(s => robustNormalize(s.title + " " + (s.author || "")).includes(q));
    }
    
    if (allRes.length === 0) { 
        c.innerHTML = "<div class='text-center text-muted p-2'>Nessun risultato</div>"; 
        return; 
    }
    
    // TAGLIAMO I RISULTATI A 30 (Mantiene il popup fluido e istantaneo)
    const res = allRes.slice(0, 30);
    
    const sl = allSetlists.find(x => x.id === currentSetlistId);
    
    // COSTRUIAMO LA STRINGA IN MEMORIA, NIENTE innerHTML NEL CICLO
    let htmlContent = "";
    
    res.forEach(s => {
        const isPresent = sl && sl.songs.some(item => (typeof item === 'string' ? item : item.id) === s.id);
        const btnClass = isPresent ? "btn-secondary disabled" : "btn-outline-primary";
        const icon = isPresent ? '<i class="bi bi-check2"></i>' : '<i class="bi bi-plus-lg"></i>';
        const action = isPresent ? "" : `onclick="window.addSongFromSearch('${s.id}')"`;
        
        htmlContent += `
        <div class="list-group-item list-group-item-action d-flex justify-content-between align-items-center">
            <div class="text-truncate" style="max-width: 80%;">
                <div class="fw-bold text-truncate">${escapeHtml(s.title)}</div>
                <small class="text-muted text-truncate">${escapeHtml(s.author || '')}</small>
            </div>
            <button class="btn btn-sm ${btnClass} rounded-circle" ${action} style="width: 32px; height: 32px; padding: 0;">${icon}</button>
        </div>`;
    });
    
    // Mostriamo un piccolo avviso alla fine della lista se ci sono canzoni tagliate fuori
    if (allRes.length > 30) {
        htmlContent += `
        <div class="text-center text-muted mt-2 small p-2">
            Altre ${allRes.length - 30} canzoni nascoste. Digita per cercare.
        </div>`;
    }
    
    // STAMPIAMO A SCHERMO UNA SOLA VOLTA!
    c.innerHTML = htmlContent;
};
window.addSongFromSearch = (songId) => { const sl = allSetlists.find(s => s.id === currentSetlistId); if(sl) { const isPresent = sl.songs.some(item => (typeof item === 'string' ? item : item.id) === songId); if(isPresent) return showToast("Già in scaletta", "info"); const newSongs = [...sl.songs, { id: songId, trans: 0 }]; updateSetlistSongs(currentSetlistId, newSongs); showToast("Aggiunta!", "success"); window.performSetlistSearch(); } };
window.insertFormatting = (tag) => { const textarea = document.getElementById("lyricsEditor"); const start = textarea.selectionStart; const end = textarea.selectionEnd; textarea.value = textarea.value.substring(0, start) + tag + textarea.value.substring(start, end) + tag + textarea.value.substring(end); textarea.selectionStart = start + tag.length; textarea.selectionEnd = end + tag.length; textarea.focus(); window.renderPreview(); };
// SCORRIMENTO AUTOMATICO con 10 velocità (pixel al secondo). Prima: 1 pixel ogni 40 ms (25 px/s) fisso.
// La velocità scelta resta salvata (anche per ogni canzone); lo schermo non si spegne mentre scorre.
const SCROLL_SPEEDS = [8, 12, 17, 24, 32, 42, 55, 72, 95, 125];
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
let scrollLevel = lsGet('scrollLevel', 6);
let scrollPaused = false, scrollAcc = 0, scrollLastTs = 0, wakeLock = null;

const setInteractingTrue = () => { isUserInteracting = true; };
const setInteractingFalse = () => { isUserInteracting = false; scrollLastTs = 0; };

function updateAutoScrollUi() {
    const bar = document.getElementById('autoScrollBar');
    const btn = document.getElementById('btnAutoScroll');
    const on = !!autoScrollInterval;
    if (bar) {
        bar.hidden = !on;
        bar.classList.toggle('paused', scrollPaused);
        document.getElementById('scrollSpeedLabel').textContent = scrollLevel;
        document.getElementById('scrollSpeedDots').innerHTML = SCROLL_SPEEDS.map((_, i) => i < scrollLevel ? '<b>•</b>' : '•').join('');
        document.getElementById('autoScrollPauseIcon').className = 'bi ' + (scrollPaused ? 'bi-play-fill' : 'bi-pause-fill');
    }
    if (btn) {
        btn.classList.toggle('btn-success', on);
        btn.classList.toggle('btn-outline-success', !on);
        btn.innerHTML = on ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-mouse3"></i>';
    }
}

async function keepScreenOn(on) {
    try {
        if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
        if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && autoScrollInterval) keepScreenOn(true); });

// Cosa scorre: la pagina, oppure il contenitore della modalità esibizione quando è aperta
let scrollContainer = null;
const scrollBox = () => scrollContainer || document.scrollingElement || document.documentElement;
// Bootstrap mette "scroll-behavior: smooth" su tutta la pagina: ogni piccolo spostamento partiva come
// animazione e quella dopo la interrompeva, quindi il testo andava a scatti (2px, 0, 2px, 0...) e tremava.
// Durante lo scorrimento automatico lo tolgo e sposto la pagina in modo continuo (anche frazioni di pixel).
let scrollPosF = null, savedScrollBehavior = null;
function setInstantScroll(on) {
    const el = document.documentElement;
    if (on && savedScrollBehavior === null) { savedScrollBehavior = el.style.scrollBehavior; el.style.scrollBehavior = "auto"; }
    if (!on && savedScrollBehavior !== null) { el.style.scrollBehavior = savedScrollBehavior; savedScrollBehavior = null; }
    if (scrollContainer) scrollContainer.style.scrollBehavior = "auto";
}

function autoScrollFrame(ts) {
    if (!autoScrollInterval) return;
    autoScrollInterval.raf = requestAnimationFrame(autoScrollFrame);
    if (scrollPaused || isUserInteracting) { scrollLastTs = 0; scrollPosF = null; return; }   // pausa mentre tocchi lo schermo
    if (!scrollLastTs) { scrollLastTs = ts; return; }
    const dt = Math.min(0.1, (ts - scrollLastTs) / 1000);
    scrollLastTs = ts;
    const box = scrollBox();
    const cur = box.scrollTop;
    // se la pagina è stata spostata a mano riparto da dove si trova adesso
    if (scrollPosF === null || Math.abs(cur - scrollPosF) > 3) scrollPosF = cur;
    if (cur + box.clientHeight >= box.scrollHeight - 2) {   // fine canzone
        autoScrollInternal(false);
        if (window.onAutoScrollEnd) window.onAutoScrollEnd(); else notify("Fine della canzone", "info", { duration: 2000 });
        return;
    }
    scrollPosF += SCROLL_SPEEDS[scrollLevel - 1] * dt;
    box.scrollTop = scrollPosF;
}

window.toggleAutoScroll = () => {
    if (autoScrollInterval) { 
        // --- STOP ---
        cancelAnimationFrame(autoScrollInterval.raf);
        autoScrollInterval = null;
        setInstantScroll(false);
        isUserInteracting = false;
        window.removeEventListener('mousedown', setInteractingTrue);
        window.removeEventListener('mouseup', setInteractingFalse);
        window.removeEventListener('touchstart', setInteractingTrue);
        window.removeEventListener('touchend', setInteractingFalse);
        keepScreenOn(false);
    } else {
        // --- START: velocità salvata per questa canzone, altrimenti l'ultima usata ---
        const perSong = lsGet('scrollLevels', {});
        const sid = scrollSongId();
        if (sid && perSong[sid]) scrollLevel = perSong[sid];
        isUserInteracting = false; scrollPaused = false; scrollAcc = 0; scrollLastTs = 0;
        window.addEventListener('mousedown', setInteractingTrue);
        window.addEventListener('mouseup', setInteractingFalse);
        window.addEventListener('touchstart', setInteractingTrue, {passive: true});
        window.addEventListener('touchend', setInteractingFalse);
        scrollPosF = null;
        setInstantScroll(true);
        autoScrollInterval = { raf: requestAnimationFrame(autoScrollFrame) };
        keepScreenOn(true);
    }
    updateAutoScrollUi();
    if (perform && !autoInternal) perform.auto = !!autoScrollInterval;
    updatePerformScrollBtn();
};

window.changeScrollSpeed = (delta) => {
    scrollLevel = Math.min(SCROLL_SPEEDS.length, Math.max(1, scrollLevel + delta));
    lsSet('scrollLevel', scrollLevel);
    const sid = scrollSongId();
    if (sid) { const perSong = lsGet('scrollLevels', {}); perSong[sid] = scrollLevel; lsSet('scrollLevels', perSong); }
    updateAutoScrollUi();
};

window.toggleAutoScrollPause = () => { scrollPaused = !scrollPaused; scrollLastTs = 0; updateAutoScrollUi(); };

window.handleSetlistBack = () => { const detail = document.getElementById('activeSetlistDetail'); if (detail.style.display === 'block') { detail.style.display = 'none'; currentSetlistId = null; window.renderSetlistsList(); } else { window.goHome(); } };
// --- FIX EXPORT MANCANTI ---
window.generateFullTxtList = () => {
    let text = "LISTA CANZONI - GRAN CANZONIERE\n\n";
    const sorted = [...allSongs].sort((a,b) => a.title.localeCompare(b.title));
    sorted.forEach(s => {
        text += `${s.title} (${s.author || 'Sconosciuto'}) - Cat: ${s.category}\n`;
    });
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "Lista_Canzoni.txt";
    a.click();
};

window.exportSinglePDF = () => {
    if(!isAdmin) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ format: 'a4', orientation: 'portrait', unit: 'mm' }); 
    const s = allSongs.find(x => x.id === currentSongId);
    const showChords = !document.getElementById('previewArea').classList.contains('hide-chords');
    doc.setTextColor(0, 51, 102); 
    doc.setFont("helvetica", "bold"); doc.setFontSize(22);
    doc.text(s.title, 20, 30);
    
    doc.setTextColor(100); 
    doc.setFont("helvetica", "italic"); doc.setFontSize(12);
    let info = s.author || "";
    if (s.year) info += ` (${s.year})`;
    doc.text(info, 20, 40);

    if(s.description) {
        doc.setFont("helvetica", "italic"); 
        doc.setFontSize(10); 
        doc.setTextColor(50);

        const maxW = 170; 
        const lines = doc.splitTextToSize(s.description, maxW - 4); 
        const blockH = (lines.length * 5) + 6; 
        
        doc.setFillColor(245, 245, 245);
        doc.rect(20, 45, maxW, blockH, 'F');
        
        doc.text(lines, 22, 50);
        
        doc.setDrawColor(200);
        doc.line(20, 45 + blockH + 5, 190, 45 + blockH + 5);
        
        var startY = 45 + blockH + 15; 
    } else {
        doc.setDrawColor(200);
        doc.line(20, 50, 190, 50);
        var startY = 60;
    }

    const txt = document.getElementById("lyricsEditor").value;
    let currentY = startY; 
    const MARGIN = 20;

    doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(0);

    const lines = txt.split("\n");
    
    for (let l of lines) {
        if (currentY > 270) { doc.addPage(); currentY = 20; }
        l = l.replace(/\*\*|__/g, ''); 
        
        const parts = l.split(/(\[.*?\])/);
        const hasChords = parts.some(p => p.startsWith("["));
        let lineX = MARGIN;

        if (hasChords && showChords) {
            let lastChordEnd = 0; 
            parts.forEach(p => {
                if(p.startsWith("[")) {
                    let c = chordDisplay(p.replace(/[\[\]]/g,''), currentTranspose);
                    doc.setTextColor(220, 53, 69); doc.setFont(undefined, 'bold');
                    if (lineX < lastChordEnd) lineX = lastChordEnd; // [Do][Sol]: non sovrapporre i due accordi
                    doc.text(c, lineX, currentY);
                    const chordWidth = doc.getTextWidth(c);
                    lastChordEnd = lineX + chordWidth + 1.5; 
                } else {
                    doc.setTextColor(0); doc.setFont(undefined, 'normal');
                    doc.text(p, lineX, currentY + 5);
                    const textWidth = doc.getTextWidth(p);
                    lineX += textWidth;
                    if (lineX < lastChordEnd) {
                        lineX = lastChordEnd;
                    }
                }
            });
            currentY += 10; 
        } else {
            doc.setTextColor(0); doc.setFont(undefined, 'normal');
            doc.text(lineWithoutChords(l), MARGIN, currentY); // prima, con gli accordi nascosti, stampava "[Do]testo"
            currentY += 7;
        }
    }
    doc.save(`${s.title}.pdf`);
};
window.exportSingleLatex = () => {
    // 1. Controllo sicurezza
    const s = allSongs.find(x => x.id === currentSongId);
    if (!s) return showToast("Nessuna canzone aperta.", "warning");

    // 2. Prendi il testo dall'editor (così esporti anche modifiche non salvate)
    const rawLyrics = document.getElementById("lyricsEditor").value;

    // 3. Costruzione documento LaTeX
    let l = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage[a4paper, margin=2cm]{geometry}
\\usepackage{songs}
\\noversenumbers
\\begin{document}
\\begin{songs}{}
`;

    // Metadati (Autore e Anno se presenti)
    let meta = [];
    if(s.author) meta.push(`by={${latexEscape(s.author)}}`);
    if(s.year) meta.push(`sr={${latexEscape(s.year)}}`);
    const metaStr = meta.length > 0 ? `[${meta.join(',')}]` : "";

    // Inizio Canzone
    l += `\\beginsong{${latexEscape(s.title)}}${metaStr}\n`;
    l += `\\beginverse\n`;

    // Processamento righe
    const lines = rawLyrics.split("\n");
    lines.forEach(line => {
        // A. Accordi: [Do] -> \[C] (il pacchetto songs lavora meglio con accordi in Inglese)
        //    Annotazioni ([Rit.], [x2]) in corsivo, refusi sicuri corretti
        // B. Formattazione: **grassetto** e __corsivo__; & % # _ protetti (prima rompevano il file)
        const processed = latexLine(line, (p1) => {
            const k = classifyBracket(p1);
            return normalizeChord(k.kind === "typo" ? k.suggestion : p1);
        });

        l += processed + "\n";
    });

    // Chiusura
    l += `\\endverse\n`;
    l += `\\endsong\n`;
    l += `\\end{songs}\n\\end{document}`;

    // 4. Download File
    try {
        const blob = new Blob([l], {type: 'text/plain'});
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        // Pulisce il nome del file da caratteri strani
        const safeName = s.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        a.download = `${safeName}.tex`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showToast("File LaTeX scaricato!", "success");
    } catch(e) {
        console.error(e);
        showToast("Errore download LaTeX", "danger");
    }
};

// Apre la vista e FORZA IL CARICAMENTO DATI
window.openManageSectionsView = async () => {
    switchView('view-manage-sections');
    // Mostra caricamento mentre recupera i dati freschi
    const container = document.getElementById("manageSectionsContainer");
    container.innerHTML = '<div class="text-center text-muted mt-5">Caricamento...</div>';
    
    await window.loadData(); // Recupera le sezioni dal DB
    window.renderManageSections();
};

window.renderManageSections = () => {
    const c = document.getElementById("manageSectionsContainer");
    c.innerHTML = "";
    
    // Ordina
    const sortedSections = [...allSections].sort((a, b) => {
        const orderA = (a.order !== undefined && a.order !== null) ? a.order : 9999;
        const orderB = (b.order !== undefined && b.order !== null) ? b.order : 9999;
        return orderA - orderB;
    });

    if (sortedSections.length === 0) {
        c.innerHTML = `<div class="text-center text-white py-5">Nessuna sezione trovata.</div>`;
        return;
    }

    sortedSections.forEach((sec, index) => {
        const bg = sec.coverUrl ? `background-image:url('${sec.coverUrl}')` : "";
        const songCount = allSongs.filter(s => s.category === sec.name).length;
        const isFirst = index === 0;
        const isLast = index === sortedSections.length - 1;
        
        // CORREZIONE QUI SOTTO: Escape del nome per evitare errori con gli apostrofi
        const safeName = jsArg(sec.name); 

        c.innerHTML += `
        <div class="card bg-dark border-secondary shadow-sm p-2 mb-2" style="border: 1px solid #444;">
            <div class="d-flex align-items-center gap-3">
                
                <div class="d-flex flex-column justify-content-center">
                    <button class="btn btn-sm btn-link text-white p-0 mb-1 ${isFirst ? 'disabled opacity-25' : ''}" 
                        onclick="window.moveSection('${sec.id}', -1)" style="line-height:1">
                        <i class="bi bi-caret-up-fill fs-5"></i>
                    </button>
                    <button class="btn btn-sm btn-link text-white p-0 ${isLast ? 'disabled opacity-25' : ''}" 
                        onclick="window.moveSection('${sec.id}', 1)" style="line-height:1">
                        <i class="bi bi-caret-down-fill fs-5"></i>
                    </button>
                </div>

                <div style="width: 60px; height: 60px; background-color: #333; background-size: cover; background-position: center; border-radius: 6px; ${bg}" 
                     class="d-flex align-items-center justify-content-center flex-shrink-0 border border-secondary">
                    ${sec.coverUrl ? '' : '<i class="bi bi-image text-white-50"></i>'}
                </div>

                <div class="flex-grow-1 overflow-hidden">
                    <h5 class="fw-bold mb-0 text-white text-truncate">${escapeHtml(sec.name)}</h5>
                    <small class="text-white-50" style="font-size: 0.85rem;">${songCount} canzoni</small>
                </div>

                <div class="d-flex gap-2">
                    <button class="btn btn-outline-light btn-sm" title="Modifica" onclick="window.openSectionSettings('${sec.id}','${safeName}',null, event)">
                        <i class="bi bi-pencil"></i>
                    </button>
                    ${isSuperAdmin ? `
                    <button class="btn btn-outline-danger btn-sm" title="Elimina" onclick="window.triggerDeleteSection('${sec.id}', '${safeName}')">
                        <i class="bi bi-trash"></i>
                    </button>` : ''}
                </div>
            </div>
        </div>`;
    });
};
window.moveSection = async (sectionId, direction) => {
    // 1. Ordina l'array locale ESATTAMENTE come lo vede l'utente a video
    allSections.sort((a, b) => {
        const orderA = (a.order !== undefined && a.order !== null) ? a.order : 9999;
        const orderB = (b.order !== undefined && b.order !== null) ? b.order : 9999;
        if (orderA !== orderB) return orderA - orderB;
        return a.name.localeCompare(b.name);
    });

    // 2. Trova l'indice
    const idx = allSections.findIndex(s => s.id === sectionId);
    if (idx === -1) return;

    // 3. Calcola il nuovo indice
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= allSections.length) return;

    // 4. Scambio
    const itemToMove = allSections[idx];
    const itemTarget = allSections[newIdx];
    allSections[idx] = itemTarget;
    allSections[newIdx] = itemToMove;

    // 5. Normalizzazione numeri
    allSections.forEach((sec, i) => {
        sec.order = i;
    });
    sectionOrder = allSections.map(s => s.name);

    // 6. Aggiornamento UI (CORRETTO QUI)
    if (document.getElementById('view-export') && document.getElementById('view-export').classList.contains('active')) {
        window.openExportView(); // <--- ORA E' CORRETTO
    } else {
        window.renderManageSections(); 
    }

    // 7. Salvataggio DB
    try {
        const batch = writeBatch(db);
        allSections.forEach(s => {
            const ref = doc(db, "sections", s.id);
            batch.update(ref, { order: s.order });
        });
        await batch.commit();
        console.log("Ordine ri-normalizzato e salvato.");
    } catch(e) {
        console.error("Errore salvataggio ordine:", e);
        showToast("Errore salvataggio ordine (controlla connessione)", "danger");
    }
};
// Funzione Creazione (invariata ma reinserita per sicurezza)
window.createNewSection = async () => {
    const n = document.getElementById("newSectionName").value.trim();
    const fileInput = document.getElementById("newSectionCoverInput");
    
    if (!n) return showToast("Manca il nome", "warning");

    if(document.getElementById("loadingOverlay")) document.getElementById("loadingOverlay").style.display = "flex";
    
    try {
        let coverUrl = "";
        if (fileInput.files.length > 0) {
            coverUrl = await compressImageToDataUrl(fileInput.files[0]);
        }

        // Calcola ordine (in fondo alla lista)
        const maxOrder = allSections.reduce((max, s) => Math.max(max, s.order || 0), 0);

        await addDoc(collection(db, "sections"), { 
            name: n, 
            coverUrl: coverUrl,
            order: maxOrder + 1
        });
        
        const modalEl = document.getElementById('addSectionModal');
        const modal = bootstrap.Modal.getInstance(modalEl);
        if(modal) modal.hide();

        showToast("Sezione creata!", "success");
        await window.loadData();
        window.renderManageSections();
    } catch (e) {
        console.error(e);
        showToast("Errore: " + e.message, "danger");
    } finally {
        if(document.getElementById("loadingOverlay")) document.getElementById("loadingOverlay").style.display = "none";
    }
};
window.openExportView = () => {
    if (NAV_DELAY_MS > 0) document.getElementById("loadingOverlay").style.display = "flex";
    setTimeout(() => {
        switchView('view-export');
        
        exportSectionCovers = {}; 
        document.getElementById("globalCoverInput").value = "";
        document.getElementById("exportPreviewImg").style.display = "none";
        document.getElementById("exportPreviewPlaceholder").style.display = "block";

        exportSectionOrder = [...allSections].map(s => ({...s, included: true})).sort((a, b) => {
            const orderA = (a.order !== undefined && a.order !== null) ? a.order : 9999;
            const orderB = (b.order !== undefined && b.order !== null) ? b.order : 9999;
            if (orderA !== orderB) return orderA - orderB;
            return a.name.localeCompare(b.name);
        });

        window.renderExportList();
        document.getElementById("loadingOverlay").style.display = "none";
    }, NAV_DELAY_MS);
};
window.createNewSetlistPrompt = () => {
    // Pulisce l'input
    const inp = document.getElementById("newSetlistNameInput");
    if(inp) inp.value = "";
    
    // Apre il modale (se inizializzato correttamente)
    if (mCreateSetlist) {
        mCreateSetlist.show();
    } else {
        // Fallback di sicurezza se il modale non è stato caricato per errori precedenti
        const el = document.getElementById('createSetlistModal');
        if(el) {
            mCreateSetlist = new bootstrap.Modal(el);
            mCreateSetlist.show();
        } else {
            console.error("Modale createSetlistModal non trovato nell'HTML");
        }
    }
};

// --- NUOVE FUNZIONI PER LA TAB PROPONI ---

window.openProposeView = () => {
    // 1. Resetta i campi (come prima)
    document.getElementById("propTitle").value = "";
    document.getElementById("propAuthor").value = "";
    document.getElementById("propLyrics").value = "";
    document.getElementById("propYear").value = "";
    document.getElementById("propDesc").value = "";
    document.getElementById("propUser").value = ""; 
    document.getElementById("propPreviewArea").innerHTML = "";

    // *** 2. NUOVO BLOCCO: CAMBIO INTERFACCIA SE ADMIN ***
    const titleEl = document.querySelector('#view-propose h4');
    // Selezioniamo il bottone in modo sicuro tramite il suo evento onclick
    const btnEl = document.querySelector('#view-propose button[onclick="window.handleSongSubmission()"]');

    if (isAdmin) {
        // MODALITÀ CAPO: Aggiunta diretta
        titleEl.innerHTML = '<i class="bi bi-plus-circle-fill text-warning me-2"></i>Nuova Canzone';
        btnEl.innerHTML = 'Crea Subito <i class="bi bi-check-lg ms-1"></i>';
        btnEl.className = "btn btn-warning btn-sm fw-bold shadow"; // Stile Giallo
    } else {
        // MODALITÀ GUEST: Proposta
        titleEl.innerText = 'Nuova Proposta';
        btnEl.innerHTML = 'Invia <i class="bi bi-send-fill ms-1"></i>';
        btnEl.className = "btn btn-primary btn-sm fw-bold"; // Stile Blu
    }
    // ****************************************************

    // 3. Popola le sezioni (come prima)
    const sel = document.getElementById("propCategory");
    sel.innerHTML = "";
    allSections.forEach(sec => {
        sel.innerHTML += `<option value="${escapeHtml(sec.name)}">${escapeHtml(sec.name)}</option>`;
    });

    // 4. Mostra la vista
    window.switchView('view-propose');
};
window.renderProposePreview = () => {
    const txt = document.getElementById("propLyrics").value;
    const div = document.getElementById("propPreviewArea");
    // Usa la stessa logica di rendering dell'editor principale
    div.innerHTML = lyricsToHtml(txt, 0);
};
// Variabile temporanea per sapere quale ID stiamo modificando
let currentReviewId = null;

// 1. APRE L'EDITOR DI REVISIONE
window.openProposalEditor = (id) => {
    currentReviewId = id;
    targetMergeSongId = null; // Reset

    const p = allProposals.find(x => x.id === id);
    if (!p) return;

    // Popola i campi
    document.getElementById("reviewTitle").value = p.title || "";
    document.getElementById("reviewAuthor").value = p.author || "";
    document.getElementById("reviewYear").value = p.year || "";
    document.getElementById("reviewDesc").value = p.description || "";
    document.getElementById("reviewProposer").value = p.proposer || "";
    document.getElementById("reviewLyrics").value = p.lyrics || "";

    // Popola select categorie
    const sel = document.getElementById("reviewCategory");
    sel.innerHTML = "";
    allSections.forEach(sec => {
        const opt = document.createElement("option");
        opt.value = sec.name; opt.innerText = sec.name;
        if (sec.name === p.category) opt.selected = true;
        sel.appendChild(opt);
    });

    // --- CONTROLLO DUPLICATO PER ADMIN ---
    // Cerca canzone esistente con stesso titolo e stesso autore (autori diversi = canzoni diverse)
    const duplicate = allSongs.find(s => isSameSong(p.title, p.author, s.title, s.author));
    
    // Gestione visuale dell'avviso (Creiamo/Aggiorniamo un div di alert nel modale)
    let alertBox = document.getElementById("proposalMergeAlert");
    if (!alertBox) {
        // Se non esiste nel HTML, crealo al volo sopra i campi
        alertBox = document.createElement("div");
        alertBox.id = "proposalMergeAlert";
        alertBox.className = "alert alert-warning mb-3 small shadow-sm border-warning";
        alertBox.style.display = "none";
        // Lo inseriamo all'inizio della colonna di sinistra del modale
        const modalBodyLeft = document.querySelector("#reviewProposalModal .col-lg-6");
        if(modalBodyLeft) modalBodyLeft.prepend(alertBox);
    }

    if (duplicate) {
        targetMergeSongId = duplicate.id; // Salviamo l'ID da sovrascrivere
        alertBox.innerHTML = `
            <i class="bi bi-exclamation-triangle-fill me-2"></i>
            <strong>ATTENZIONE:</strong> Esiste già una canzone chiamata <u>${escapeHtml(duplicate.title)}</u> nella sezione <b>${escapeHtml(duplicate.category)}</b>.<br>
            Se clicchi "Salva e Approva", il testo di questa proposta <strong>SOVRASCRIVERÀ</strong> quello della canzone esistente.
        `;
        alertBox.style.display = "block";
        alertBox.classList.remove('alert-success');
        alertBox.classList.add('alert-warning');
    } else {
        alertBox.style.display = "none";
    }
    // -------------------------------------

    window.renderReviewPreview();
    mReviewProposal.show();
};

// 2. RENDERIZZA L'ANTEPRIMA NEL MODALE (Simile all'editor principale)
window.renderReviewPreview = () => {
    const txt = document.getElementById("reviewLyrics").value;
    const div = document.getElementById("reviewPreviewArea");
    // Stessa logica dell'editor, accordi evidenziati in rosa
    div.innerHTML = lyricsToHtml(txt, 0, ' style="color: #ff85c0; font-weight:bold;"', suspiciousChords(txt), true);
};

// 3. SALVA E APPROVA (Crea canzone e cancella proposta)
window.saveAndApproveProposal = async () => {
    if (!currentReviewId) return;

    const t = document.getElementById("reviewTitle").value.trim();
    if (!t) return showToast("Titolo obbligatorio", "warning");

    const finalData = {
        title: t,
        author: document.getElementById("reviewAuthor").value.trim(),
        category: document.getElementById("reviewCategory").value,
        year: document.getElementById("reviewYear").value,
        description: document.getElementById("reviewDesc").value.trim(),
        lyrics: document.getElementById("reviewLyrics").value,
        chords: window.extractChords(document.getElementById("reviewLyrics").value),
        added: true,
        createdAt: Date.now(),
        needsSuperAdminReview: !isSuperAdmin
    };

    document.getElementById("loadingOverlay").style.display = "flex";
    mReviewProposal.hide();

    try {
        // --- LOGICA DI MERGE ---
        if (targetMergeSongId) {
            // SE C'ERA UN DUPLICATO RILEVATO: AGGIORNA QUELLO ESISTENTE
            recordHistory(allSongs.find(x => x.id === targetMergeSongId), "proposta approvata");
            await updateDoc(doc(db, "songs", targetMergeSongId), finalData);
            
            // Aggiorna array locale
            const localS = allSongs.find(x => x.id === targetMergeSongId);
            if(localS) Object.assign(localS, finalData); // Aggiorna l'oggetto in memoria
            
            showToast("Proposta unita alla canzone esistente!", "success");
        } else {
            // SE NON C'ERA DUPLICATO: CREA NUOVA
            const r = await addDoc(collection(db, "songs"), finalData);
            allSongs.push({ id: r.id, ...finalData });
            window.updateTotalSongsCounter();
            showToast("Nuova canzone creata!", "success");
        }

        // In entrambi i casi, cancella la proposta perché è stata processata
        await deleteDoc(doc(db, "proposals", currentReviewId));
        allProposals = allProposals.filter(p => p.id !== currentReviewId);
        
        window.openProposalsView();
        
    } catch (e) {
        console.error(e);
        showToast("Errore approvazione: " + e.message, "danger");
        mReviewProposal.show();
    } finally {
        document.getElementById("loadingOverlay").style.display = "none";
    }
};

// Renderizza la lista nella tab Export (senza toccare il DB)
window.renderExportList = () => {
    const list = document.getElementById("sectionOrderListExport"); 
    if(!list) return;
    
    list.innerHTML = "";
    
    exportSectionOrder.forEach((sec, idx) => {
        const hasDbCover = sec.coverUrl ? '<i class="bi bi-image text-success" title="Presente nel DB"></i>' : '<i class="bi bi-image text-muted" title="Nessuna"></i>';
        // Gestione stato incluso/escluso
        const isIncluded = sec.included !== false; // Default true
        const opacityClass = isIncluded ? "" : "opacity-50";
        const checkedAttr = isIncluded ? "checked" : "";
        
        list.innerHTML += `
        <div class="list-group-item bg-dark border-secondary text-white d-flex align-items-center justify-content-between p-2 mb-1 rounded ${opacityClass}" 
             onmouseenter="window.hoverSectionPreview('${sec.id}', '${jsArg(sec.name)}')">
            
            <div class="d-flex align-items-center gap-2 flex-grow-1" style="min-width:0;">
                <div class="form-check form-switch me-1">
                    <input class="form-check-input" type="checkbox" ${checkedAttr} onchange="window.toggleExportSection(${idx})">
                </div>

                <div class="d-flex flex-column">
                    <button class="btn btn-sm btn-link text-white py-0" onclick="window.moveExportSection(${idx}, -1)"><i class="bi bi-caret-up-fill"></i></button>
                    <button class="btn btn-sm btn-link text-white py-0" onclick="window.moveExportSection(${idx}, 1)"><i class="bi bi-caret-down-fill"></i></button>
                </div>
                
                <div class="text-truncate">
                    <div class="fw-bold small">${escapeHtml(sec.name)}</div>
                    <div class="d-flex align-items-center gap-1">
                        <small>${hasDbCover}</small>
                        <label class="btn btn-outline-secondary btn-xs py-0 px-1 border-0" style="font-size: 0.7rem;">
                            <i class="bi bi-upload"></i> Cambia
                            <input type="file" hidden accept="image/*" 
                                   data-sec-id="${sec.id}"
                                   onchange="window.updateExportPreview('section_custom', this, '${jsArg(sec.name)}')">
                        </label>
                    </div>
                </div>
            </div>
        </div>`;
    });
};

// Sposta elementi SOLO nell'array locale exportSectionOrder
window.moveExportSection = (index, direction) => {
    const newIndex = index + direction;

    // Controlli limiti array
    if (newIndex < 0 || newIndex >= exportSectionOrder.length) return;

    // Scambio elementi nell'array locale
    const temp = exportSectionOrder[index];
    exportSectionOrder[index] = exportSectionOrder[newIndex];
    exportSectionOrder[newIndex] = temp;

    // Ridisegna solo la lista visuale
    window.renderExportList();
};
// Aggiorna l'anteprima a sinistra quando si carica un file o si passa sopra una sezione
window.updateExportPreview = async (type, inputOrUrl, labelText) => {
    const img = document.getElementById("exportPreviewImg");
    const ph = document.getElementById("exportPreviewPlaceholder");
    const lbl = document.getElementById("exportPreviewLabel");
    
    let src = "";

    if (type === 'global') {
        // Copertina generale da input file
        if (inputOrUrl.files && inputOrUrl.files[0]) {
            src = await fileToBase64(inputOrUrl.files[0]);
            lbl.innerText = "Copertina Generale (Personalizzata)";
        } else {
            lbl.innerText = "Copertina Generale (Default)";
            ph.style.display = "block"; img.style.display = "none";
            return;
        }
    } else if (type === 'section_custom') {
        // Copertina sezione caricata al momento
        if (inputOrUrl.files && inputOrUrl.files[0]) {
            src = await fileToBase64(inputOrUrl.files[0]);
            // Salva nella variabile temporanea
            const sectionId = inputOrUrl.getAttribute('data-sec-id');
            exportSectionCovers[sectionId] = src;
            lbl.innerText = "Copertina Sezione: " + labelText + " (Nuova)";
        }
    } else if (type === 'section_db') {
        // Copertina sezione dal DB (al mouseover)
        src = inputOrUrl; // Qui inputOrUrl è l'URL base64
        lbl.innerText = "Copertina Sezione: " + labelText + " (App)";
    }

    if (src) {
        img.src = src;
        img.style.display = "block";
        ph.style.display = "none";
    } else {
        img.style.display = "none";
        ph.style.display = "block";
    }
};

// Funzione helper per gestire il mouseover sulla lista
window.hoverSectionPreview = (secId, secName) => {
    // Se c'è una custom caricata ora, mostra quella
    if (exportSectionCovers[secId]) {
        const img = document.getElementById("exportPreviewImg");
        img.src = exportSectionCovers[secId];
        img.style.display = "block";
        document.getElementById("exportPreviewPlaceholder").style.display = "none";
        document.getElementById("exportPreviewLabel").innerText = secName + " (Custom)";
    } 
    // Altrimenti se c'è quella del DB, mostra quella
    else {
        const sec = allSections.find(s => s.id === secId);
        if (sec && sec.coverUrl) {
            window.updateExportPreview('section_db', sec.coverUrl, secName);
        } else {
            // Nessuna copertina
            document.getElementById("exportPreviewImg").style.display = "none";
            document.getElementById("exportPreviewPlaceholder").style.display = "block";
            document.getElementById("exportPreviewLabel").innerText = secName + " (Nessuna)";
        }
    }
};

window.generateExcelList = () => {
    // 1. Ordina alfabeticamente
    const sorted = [...allSongs].sort((a,b) => a.title.localeCompare(b.title));
    
    // 2. Crea intestazione CSV (Usa ; come separatore per Excel Italiano)
    // \ufeff è il BOM per dire a Excel che è UTF-8 (corregge accenti)
    let csvContent = "\ufeffTitolo;Autore;Anno;Sezione\n";
    
    sorted.forEach(s => {
        // Pulisci i campi da eventuali punti e virgola che romperebbero il CSV
        const safeTitle = String(s.title ?? "").replace(/;/g, ",");
        const safeAuthor = String(s.author ?? "").replace(/;/g, ",");
        const safeYear = String(s.year ?? "").replace(/;/g, "");
        const safeCategory = String(s.category ?? "").replace(/;/g, ",");
        
        csvContent += `${safeTitle};${safeAuthor};${safeYear};${safeCategory}\n`;
    });

    // 3. Download
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "Inventario_Canzoniere.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.showToast("File Excel scaricato!", "success");
};

// AGGIUNGI QUESTA NUOVA FUNZIONE HELPER
window.toggleExportSection = (index) => {
    if (exportSectionOrder[index]) {
        exportSectionOrder[index].included = !exportSectionOrder[index].included;
        // Non serve riordinare, solo aggiornare la vista per lo stato checkbox/opacity
        window.renderExportList(); 
    }
};
// script.js - Aggiungi in fondo

/* ============================================================
   GESTIONE ANTEPRIMA DINAMICA EXPORT CON ETICHETTA AGGIORNATA
   ============================================================ */

window.showFormatPreview = (type) => {
    const container = document.getElementById("formatPreviewContainer");
    const img = document.getElementById("exportPreviewImg");
    const ph = document.getElementById("exportPreviewPlaceholder");
    const headerTitle = document.getElementById("previewHeaderTitle");
    const label = document.getElementById("exportPreviewLabel"); // <--- Elemento testo in basso
    
    // 1. Nascondi le copertine attuali
    if (img) img.style.display = "none";
    if (ph) ph.style.display = "none";
    
    // 2. Mostra il contenitore anteprima formati
    if (container) {
        container.classList.remove("d-none");
        container.classList.add("d-flex");
    }

    // 3. Aggiorna l'intestazione e l'etichetta in basso
    let labelText = "";
    let headerText = "Anteprima " + type.toUpperCase();

    switch(type) {
        case 'pdf':
            labelText = "Anteprima Documento PDF (A5)";
            break;
        case 'excel':
            labelText = "Anteprima Foglio Excel (.csv)";
            break;
        case 'txt':
            labelText = "Anteprima File di Testo (.txt)";
            break;
        case 'latex':
            labelText = "Anteprima Sorgente LaTeX (.tex)";
            break;
        default:
            labelText = "Anteprima Formato";
    }

    if (headerTitle) headerTitle.innerText = headerText;
    if (label) label.innerText = labelText; // <--- Qui aggiorniamo la scritta sotto

    let html = "";

    // --- ANTEPRIMA PDF (Reattiva alle impostazioni) ---
    if (type === 'pdf') {
        const isTwoCols = document.getElementById("pdfTwoColumns").checked;
        const showChords = document.getElementById("pdfShowChords").checked;

        // Simulazione stili
        const chordStyle = showChords ? 'color:#dc3545; font-weight:bold;' : 'display:none;';
        const colClass = isTwoCols ? 'col-6 border-end' : 'col-12';
        
        // Contenuto finto di una canzone
        const songContent = `
            <div class="mb-1 fw-bold text-primary" style="font-size:7px;">ALBACHIARA</div>
            <div class="mb-2 fst-italic text-muted" style="font-size:5px;">Vasco (1979)</div>
            <div style="font-size:5px; line-height:1.4;">
                <div><span style="${chordStyle}">[Do]</span> Respiri piano per non far rumore</div>
                <div><span style="${chordStyle}">[Sol]</span> Ti addormenti di sera</div>
                <div><span style="${chordStyle}">[Lam]</span> Ti risvegli col sole</div>
                <div class="mt-1"><span style="${chordStyle}">[Fa]</span> Sei chiara come un'alba</div>
                <div><span style="${chordStyle}">[Do]</span> Sei fresca come l'aria</div>
            </div>
        `;

        html = `
        <div class="bg-white text-dark shadow-sm position-relative overflow-hidden" style="width: 200px; height: 280px; font-size: 5px; border-radius: 2px;">
            <div class="position-absolute top-0 start-0 w-100 border-bottom d-flex justify-content-between px-2 py-1 bg-light" style="font-size:4px;">
                <span>Canzoniere Scout</span>
                <span>Pag. 12</span>
            </div>
            
            <div class="row g-0 p-3 mt-2 h-100">
                <div class="${colClass} p-1">
                    ${songContent}
                    <div class="mt-3">
                        <div class="mb-1 fw-bold text-primary" style="font-size:7px;">AZZURRO</div>
                        <div class="mb-1 fst-italic text-muted" style="font-size:5px;">Celentano</div>
                        <div style="font-size:5px;">Cerco l'estate tutto l'anno...</div>
                    </div>
                </div>
                ${isTwoCols ? `
                <div class="col-6 p-1 ps-2">
                    <div class="mb-1 fw-bold text-primary" style="font-size:7px;">CERTE NOTTI</div>
                    <div style="font-size:5px;">
                        <div><span style="${chordStyle}">[Mi]</span> Certe notti la macchina...</div>
                        <div><span style="${chordStyle}">[La]</span> è calda...</div>
                    </div>
                </div>` : ''}
            </div>
            
            <div class="position-absolute bottom-0 end-0 bg-danger text-white px-2 py-1 fw-bold" style="font-size:8px; border-top-left-radius:4px;">
                PDF ${isTwoCols ? '2 Col' : '1 Col'}
            </div>
        </div>`;
    } 
    
    // --- ANTEPRIMA EXCEL ---
    else if (type === 'excel') {
        html = `
        <div class="bg-white text-dark shadow-sm overflow-hidden border" style="width: 220px; height: 150px; font-size: 6px; border-radius: 4px;">
            <div class="bg-success text-white p-1 fw-bold d-flex align-items-center"><i class="bi bi-file-spreadsheet me-1"></i> Excel Export</div>
            <div class="d-flex bg-light border-bottom fw-bold" style="color:#000;">
                <div class="border-end px-1 w-25">A</div>
                <div class="border-end px-1 w-25">B</div>
                <div class="border-end px-1 w-25">C</div>
                <div class="px-1 w-25">D</div>
            </div>
            <div class="d-flex border-bottom" style="background:#e8f5e9;">
                <div class="border-end px-1 w-25 fw-bold">Titolo</div>
                <div class="border-end px-1 w-25 fw-bold">Autore</div>
                <div class="border-end px-1 w-25 fw-bold">Anno</div>
                <div class="px-1 w-25 fw-bold">Sezione</div>
            </div>
            <div class="d-flex border-bottom">
                <div class="border-end px-1 w-25">Albachiara</div>
                <div class="border-end px-1 w-25">Vasco</div>
                <div class="border-end px-1 w-25">1979</div>
                <div class="px-1 w-25">Fuoco</div>
            </div>
            <div class="d-flex border-bottom">
                <div class="border-end px-1 w-25">Azzurro</div>
                <div class="border-end px-1 w-25">Celentano</div>
                <div class="border-end px-1 w-25">1968</div>
                <div class="px-1 w-25">Vari</div>
            </div>
        </div>`;
    }
    
    // --- ANTEPRIMA TXT ---
    else if (type === 'txt') {
        html = `
        <div class="bg-dark text-white shadow-sm p-2 border border-secondary font-monospace" style="width: 200px; height: 160px; font-size: 6px; border-radius: 4px;">
            <div class="border-bottom border-secondary pb-1 mb-1 text-muted">Lista_Canzoni.txt</div>
            LISTA CANZONI - GRAN CANZONIERE<br><br>
            1. Albachiara (Vasco)<br>
            &nbsp;&nbsp;&nbsp;- Cat: Fuoco<br><br>
            2. Azzurro (Celentano)<br>
            &nbsp;&nbsp;&nbsp;- Cat: Vari<br><br>
            3. Certe Notti (Ligabue)<br>
            &nbsp;&nbsp;&nbsp;- Cat: Strada
        </div>`;
    }
    
    // --- ANTEPRIMA LATEX ---
    else if (type === 'latex') {
        html = `
        <div class="bg-dark text-warning p-2 shadow-sm border border-secondary font-monospace" style="width: 200px; height: 160px; font-size: 5px; border-radius: 4px; overflow:hidden;">
            <div class="text-white-50 border-bottom border-secondary pb-1 mb-1">Source Code (.tex)</div>
            <span class="text-info">\\documentclass</span>{article}<br>
            <span class="text-info">\\usepackage</span>{songs}<br>
            <span class="text-info">\\begin</span>{document}<br><br>
            <span class="text-secondary">% Inizio Canzoniere</span><br>
            <span class="text-info">\\section</span>{Fuoco di Bivacco}<br><br>
            <span class="text-info">\\beginsong</span>{Albachiara}[by={Vasco}]<br>
            <span class="text-info">\\beginverse</span><br>
            \\[C] Respire piano...<br>
            <span class="text-info">\\endverse</span><br>
            <span class="text-info">\\endsong</span>
        </div>`;
    }

    container.innerHTML = html;
};
window.resetFormatPreview = () => {
    /*const container = document.getElementById("formatPreviewContainer");
    const img = document.getElementById("exportPreviewImg");
    const ph = document.getElementById("exportPreviewPlaceholder");
    const headerTitle = document.getElementById("previewHeaderTitle");
    const label = document.getElementById("exportPreviewLabel");

    // 1. Nascondi il contenitore dei formati
    if(container) {
        container.classList.add("d-none");
        container.classList.remove("d-flex");
        container.innerHTML = "";
    }

    // 2. Ripristina il titolo
    if(headerTitle) headerTitle.innerText = "Anteprima Copertina";

    // 3. Logica intelligente per ripristinare l'immagine giusta
    // Se c'è un'immagine caricata nel tag img (che non sia vuota o l'url della pagina), mostrala
    if (img && img.src && img.src !== window.location.href && img.style.backgroundImage !== 'none' && img.getAttribute('src') !== "") {
        img.style.display = "block";
        if(ph) ph.style.display = "none";
    } else {
        // Altrimenti mostra il placeholder generico
        if(img) img.style.display = "none";
        if(ph) ph.style.display = "block";
    }
*/};

// --- PATCH GESTIONE ANTEPRIMA ---
// Sovrascriviamo updateExportPreview per gestire la visibilità del nuovo contenitore formati
const _originalUpdateExportPreview = window.updateExportPreview;

window.updateExportPreview = async (type, inputOrUrl, labelText) => {
    // 1. Chiama la logica originale per caricare l'immagine della copertina
    await _originalUpdateExportPreview(type, inputOrUrl, labelText);
    
    // 2. FORZA la chiusura dell'anteprima formati (PDF/Excel)
    // Questo serve perché se l'anteprima era rimasta bloccata su "PDF",
    // ora che stiamo toccando le copertine dobbiamo nasconderla.
    const container = document.getElementById("formatPreviewContainer");
    const title = document.getElementById("previewHeaderTitle");
    const img = document.getElementById("exportPreviewImg");
    const ph = document.getElementById("exportPreviewPlaceholder");
    
    if(container) {
        container.classList.add("d-none");
        container.classList.remove("d-flex");
    }
    
    // Ripristina il titolo corretto
    if(title) {
        // Se c'è un'immagine caricata
        if (img && img.style.display !== 'none') {
            title.innerText = "Copertina Selezionata";
        } else {
            title.innerText = "Anteprima Copertina";
        }
    }
};
const robustNormalize = (str) => {
    if (!str) return "";
    return str.toLowerCase()
              .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Toglie accenti
              .replace(/[^a-z0-9\s]/g, "") // Toglie punteggiatura speciale
              .replace(/\s+/g, " ") // Riduce spazi multipli a uno solo
              .trim();
};

// =====================================================================
// CONTROLLO CANZONI (solo admin): trova e corregge testi/accordi sbagliati
// Lavora su allSongs già in memoria, quindi la scansione non costa letture Firestore.
// =====================================================================
let doctorReport = null;
let doctorFilter = "typo";
const DOCTOR_MAX_ROWS = 200;

function refreshDoctor() {
    doctorReport = scanSongs(allSongs);
    renderSongDoctor();
}

window.openSongDoctorView = () => {
    if (!isAdmin) return;
    window.switchView('view-doctor');
    doctorReport = scanSongs(allSongs);
    if (!doctorReport[doctorFilter] || doctorReport[doctorFilter].length === 0) {
        const first = Object.keys(ISSUES).find(k => doctorReport[k].length > 0);
        if (first) doctorFilter = first;
    }
    renderSongDoctor();
};

window.setDoctorFilter = (code) => { doctorFilter = code; renderSongDoctor(); };

function renderSongDoctor() {
    const chips = document.getElementById("doctorChips");
    const list = document.getElementById("doctorList");
    if (!chips || !list || !doctorReport) return;

    chips.innerHTML = Object.entries(ISSUES).map(([code, info]) => {
        const n = doctorReport[code].length;
        const cls = code === doctorFilter ? "btn-warning" : (n ? "btn-outline-light" : "btn-outline-secondary");
        return `<button class="btn btn-sm ${cls}" onclick="window.setDoctorFilter('${code}')">${escapeHtml(info.label)} <span class="badge bg-dark ms-1">${n}</span></button>`;
    }).join("");

    if (!ISSUES[doctorFilter]) doctorFilter = Object.keys(ISSUES)[0];
    const info = ISSUES[doctorFilter];
    const items = doctorReport[doctorFilter].slice().sort((a, b) => (a.song.title || "").localeCompare(b.song.title || ""));
    let html = `<div class="small text-white-50 mb-2">${escapeHtml(info.hint)}</div>`;

    if (info.fixable && items.length) {
        const n = items.filter(x => isAutoFixable(x.song, info.opts)).length;
        html += `<button class="btn btn-success btn-sm fw-bold mb-3" onclick="window.batchAutoFix('${doctorFilter}')">
                    <i class="bi bi-magic me-1"></i> Correggi automaticamente tutte (${n})
                 </button>`;
    }

    if (!items.length) {
        html += `<div class="text-center text-muted mt-4">Nessuna canzone in questa categoria.</div>`;
    } else {
        html += items.slice(0, DOCTOR_MAX_ROWS).map(({ song, detail }) => `
            <button class="list-group-item list-group-item-action p-3 border-0 mb-1 rounded" onclick="window.openEditor('${song.id}')">
                <div class="d-flex justify-content-between align-items-center gap-2">
                    <div class="text-truncate"><strong>${escapeHtml(song.title)}</strong>
                        <small class="text-muted ms-1">${escapeHtml(song.category || "")}</small></div>
                    <small class="text-warning text-nowrap">${escapeHtml(detail)}</small>
                </div>
            </button>`).join("");
        if (items.length > DOCTOR_MAX_ROWS) {
            html += `<div class="text-center text-muted small my-3">Mostrate le prime ${DOCTOR_MAX_ROWS} di ${items.length}.</div>`;
        }
    }
    list.innerHTML = html;
    renderDoctorCovers();
}

// Peso delle copertine delle sezioni (scaricate a ogni apertura dell'app)
const HEAVY_COVER = 400000; // caratteri base64, circa 300 KB
const coversAlreadyCompressed = new Set(); // per non ricomprimere la stessa foto (perderebbe qualità a ogni giro)
const heavyCovers = () => allSections.filter(s => (s.coverUrl || "").startsWith("data:") && s.coverUrl.length > HEAVY_COVER && !coversAlreadyCompressed.has(s.id));
function renderDoctorCovers() {
    const box = document.getElementById("doctorCovers");
    if (!box) return;
    const total = allSections.reduce((t, s) => t + (s.coverUrl || "").length, 0);
    const heavy = heavyCovers();
    const kb = Math.round(total * 0.75 / 1024);
    box.innerHTML = `<i class="bi bi-image me-1"></i> Copertine sezioni: <strong>${kb} KB</strong> scaricati a ogni apertura` +
        (heavy.length ? ` <button class="btn btn-sm btn-outline-warning ms-2" onclick="window.compressSectionCovers()">Comprimi ${heavy.length === 1 ? "1 copertina pesante" : heavy.length + " copertine pesanti"}</button>` : ` <span class="text-success ms-1">ok</span>`);
}

window.compressSectionCovers = () => {
    const heavy = heavyCovers();
    if (!heavy.length) return;
    window.confirmModal(`Ridimensionare ${heavy.length} copertine (max 1200 px)? Si vedranno uguali, anche nell'export PDF, ma l'app si aprirà più in fretta.`, async () => {
        document.getElementById("loadingOverlay").style.display = "flex";
        try {
            for (const sec of heavy) {
                const small = await compressImageToDataUrl(sec.coverUrl);
                coversAlreadyCompressed.add(sec.id);
                if (small.length < sec.coverUrl.length * 0.9) {
                    await updateDoc(doc(db, "sections", sec.id), { coverUrl: small });
                    sec.coverUrl = small;
                }
            }
            showToast("Copertine compresse", "success");
        } catch (e) {
            showToast("Errore compressione: " + e.message, "danger");
        } finally {
            document.getElementById("loadingOverlay").style.display = "none";
            renderDoctorCovers();
        }
    });
};

// Bottone "Auto-correggi" nell'editor: corregge il testo aperto, NON salva (controlli l'anteprima e premi Salva)
window.autoFixCurrentSong = () => {
    const ta = document.getElementById("lyricsEditor");
    const { text, changes } = fixLyrics(ta.value, { typos: true });
    if (text === ta.value) {
        if (changes.review.length) return showToast("Da controllare a mano: riga " + changes.review.map(r => r.line).join(", "), "warning");
        return showToast("Niente da correggere in questa canzone", "info");
    }

    ta.focus();
    ta.select();
    // insertText mantiene Ctrl+Z per annullare; se il browser non lo supporta sostituisco il valore
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (e) { ok = false; }
    if (!ok || ta.value !== text) ta.value = text;

    hasUnsavedChanges = true;
    window.renderPreview();
    showToast(describeChanges(changes) + ". Controlla l'anteprima e premi Salva.", "success");
};

function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Backup completo: tutte le canzoni (testo, accordi e dati) in un file. Si ripristina con "Ripristina".
window.downloadFullBackup = () => {
    if (!isAdmin) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    downloadJson(allSongs.map(s => ({ id: s.id, title: s.title, author: s.author || "", category: s.category || "",
        year: s.year || "", description: s.description || "", savedTranspose: s.savedTranspose || 0, lyrics: s.lyrics || "" })),
        `backup-canzoniere-${stamp}.json`);
    showToast(`Backup di ${allSongs.length} canzoni scaricato`, "success");
};

// Scrive su Firestore a blocchi da 400 (il limite di un batch è 500)
async function writeLyricsInChunks(updates) {
    for (let i = 0; i < updates.length; i += 400) {
        const chunk = updates.slice(i, i + 400);
        recordHistoryBatch(chunk.map(u => allSongs.find(x => x.id === u.id)).filter((s, k) => s && (s.lyrics || "") !== chunk[k].lyrics), "correzione automatica");
        const b = writeBatch(db);
        chunk.forEach(u => b.update(doc(db, "songs", u.id), { lyrics: u.lyrics, chords: extractChords(u.lyrics) }));
        await b.commit();
        chunk.forEach(u => {
            const s = allSongs.find(x => x.id === u.id);
            if (s) { s.lyrics = u.lyrics; s.chords = extractChords(u.lyrics); }
        });
    }
}

window.batchAutoFix = (code) => {
    const opts = (ISSUES[code] && ISSUES[code].opts) || {};
    const targets = doctorReport[code].map(x => x.song).filter(s => isAutoFixable(s, opts));
    if (!targets.length) return showToast("Niente da correggere in automatico", "info");

    window.confirmModal(`Correggere automaticamente ${targets.length} canzoni? Prima viene scaricato un file di backup con i testi originali.`, async () => {
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
        downloadJson(targets.map(s => ({ id: s.id, title: s.title, lyrics: s.lyrics || "" })), `backup-testi-${stamp}.json`);

        document.getElementById("loadingOverlay").style.display = "flex";
        try {
            await writeLyricsInChunks(targets.map(s => ({ id: s.id, lyrics: fixLyrics(s.lyrics, opts).text })));
            showToast(`${targets.length === 1 ? "1 canzone corretta" : targets.length + " canzoni corrette"}. Il backup è nei download.`, "success");
        } catch (e) {
            showToast("Errore durante la correzione: " + e.message, "danger");
        } finally {
            document.getElementById("loadingOverlay").style.display = "none";
            refreshDoctor();
        }
    });
};

// Ripristino da un file di backup scaricato prima di una correzione automatica
window.restoreLyricsBackup = (input) => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        input.value = "";
        let data;
        try { data = JSON.parse(reader.result); } catch (e) { return showToast("File di backup non valido", "danger"); }
        const valid = Array.isArray(data)
            ? data.filter(x => x && typeof x.id === "string" && typeof x.lyrics === "string" && allSongs.some(s => s.id === x.id))
            : [];
        if (!valid.length) return showToast("Nessuna canzone del backup trovata nel canzoniere", "warning");

        window.confirmModal(`Ripristinare il testo originale di ${valid.length} canzoni?`, async () => {
            document.getElementById("loadingOverlay").style.display = "flex";
            try {
                await writeLyricsInChunks(valid.map(x => ({ id: x.id, lyrics: x.lyrics })));
                showToast(`${valid.length} canzoni ripristinate`, "success");
            } catch (e) {
                showToast("Errore ripristino: " + e.message, "danger");
            } finally {
                document.getElementById("loadingOverlay").style.display = "none";
                refreshDoctor();
            }
        });
    };
    reader.readAsText(file);
};

// =====================================================================================================
// NOVITÀ: diagrammi degli accordi, capotasto consigliato, modalità esibizione, scaletta condivisa
// (link, QR e diretta), etichette per momento e branca, cronologia delle modifiche, uso offline
// =====================================================================================================

const chordText = (el) => (el.textContent || "").replace(/[()\s]/g, "");
const fmtDate = (ms) => { try { return new Date(ms).toLocaleString("it-IT", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return String(ms); } };
const signed = (n) => (n > 0 ? "+" + n : String(n));

// --- DIAGRAMMI DEGLI ACCORDI -------------------------------------------------------------------------
let chordInstrument = lsGet('chordInstrument', 'guitar');

function chordFiguresHtml(name) {
    const uke = chordInstrument === 'uke';
    const list = uke ? ukuleleVoicings(name) : guitarVoicings(name);
    if (!list.length) return `<div class="text-muted small py-3">Non ho una diteggiatura per questo accordo.</div>`;
    return list.map(v => {
        const extra = v.barre ? `barrè al ${v.barre.fret}° tasto` : "";
        const cap = [v.label, extra && !/barr/.test(v.label || "") ? extra : ""].filter(Boolean).join(" · ");
        return `<figure class="chord-fig">${chordDiagramSvg(v, uke ? 4 : 6)}<figcaption>${escapeHtml(cap)}</figcaption></figure>`;
    }).join("");
}

function capoOfElement(el) {
    if (el.closest("#performBody") && perform) { const it = perform.list[perform.index]; return capoFor(it.id, it.trans || 0); }
    if (el.closest("#previewArea")) return capoFor(currentSongId, currentTranspose);
    return 0;
}

function openChordSheet(el, flagged) {
    const shown = chordText(el);
    const info = chordInfo(shown);
    let flagHtml = "", flagName = el.dataset.chord || shown;
    if (flagged) {
        if (el.classList.contains("chord-typo")) {
            flagHtml = `<div class="chord-flag warn"><i class="bi bi-pencil-square"></i><div>Nel testo c'è scritto <b>${escapeHtml(flagName)}</b>: quasi certamente è <b>${escapeHtml(el.dataset.fix || shown)}</b>. L'anteprima lo mostra già corretto; la bacchetta lo corregge nel testo.
                <div class="mt-2"><button class="app-btn app-btn-primary btn-sm" data-act="fix">Correggi con la bacchetta</button></div></div></div>`;
        } else if (el.classList.contains("chord-unknown")) {
            flagHtml = `<div class="chord-flag bad"><i class="bi bi-question-octagon"></i><div><b>${escapeHtml(flagName)}</b> non è un accordo né un'annotazione che riconosco: correggilo a mano nel testo.</div></div>`;
        } else {
            const likely = el.classList.contains("chord-suspect");
            flagHtml = `<div class="chord-flag ${likely ? "bad" : "warn"}"><i class="bi ${likely ? "bi-exclamation-triangle" : "bi-info-circle"}"></i><div>${escapeHtml(el.title || "Accordo fuori tonalità")}
                <div class="mt-2"><button class="app-btn app-btn-ghost btn-sm" data-act="ok">È giusto, non segnalarlo più</button></div></div></div>`;
        }
    }
    if (!info && !flagHtml) return;
    const capo = capoOfElement(el);
    const body = () => !info ? "" : `
        <div class="chord-sheet-notes">Note: <b>${info.notes.map(escapeHtml).join(" · ")}</b>${info.slash ? ` <span class="text-muted">· basso ${escapeHtml(info.bassName)}</span>` : ""}</div>
        <div class="chord-tabs" role="tablist">
            <button data-inst="guitar" class="${chordInstrument === 'guitar' ? 'active' : ''}"><i class="bi bi-music-note"></i> Chitarra</button>
            <button data-inst="uke" class="${chordInstrument === 'uke' ? 'active' : ''}"><i class="bi bi-music-note-beamed"></i> Ukulele</button>
        </div>
        <div class="chord-figs">${chordFiguresHtml(shown)}</div>
        ${capo ? `<div class="chord-sheet-capo"><i class="bi bi-sliders2-vertical"></i> Con il capotasto al ${capo}° tasto questa forma suona come <b>${escapeHtml(nicerName(transposeChord(normalizeChord(shown), capo)))}</b>.</div>` : ""}
        <div class="chord-legend">● dito sulla corda · ○ corda a vuoto · × corda da non suonare</div>`;
    const sheet = openSheet({ title: shown || flagName, html: flagHtml + `<div class="chord-sheet-main">${body()}</div>` });
    sheet.body.addEventListener("click", (ev) => {
        const tab = ev.target.closest("[data-inst]");
        if (tab) {
            chordInstrument = tab.dataset.inst;
            lsSet('chordInstrument', chordInstrument);
            sheet.body.querySelector(".chord-sheet-main").innerHTML = body();
            return;
        }
        const act = ev.target.closest("[data-act]");
        if (!act) return;
        sheet.close();
        if (act.dataset.act === "ok") window.markChordOk(flagName);
        if (act.dataset.act === "fix") window.autoFixCurrentSong();
    });
}

// --- CAPOTASTO --------------------------------------------------------------------------------------
// La scelta resta su questo telefono, canzone per canzone (ognuno ha la sua chitarra).
// Si salva il capotasto insieme alla tonalità in cui è stato scelto: se poi la canzone viene alzata o abbassata
// (col +/- o nella scaletta) il capotasto si sposta di altrettanti tasti e le forme da suonare restano le stesse.
const capoMap = () => lsGet('capoBySong', {});
function capoFor(id, trans) {
    const v = id ? capoMap()[id] : null;
    if (v === null || v === undefined) return 0;
    const c = typeof v === "number" ? v : v.c, t0 = typeof v === "number" ? (trans || 0) : (v.t || 0);
    if (!c) return 0;
    let d = (((trans ?? t0) - t0) % 12 + 12) % 12;
    if (d > 6) d -= 12;
    const k = c + d;
    return k >= 1 && k <= 9 ? k : 0;   // fuori dal manico: niente capotasto
}
const capoChosen = (id) => !!id && Object.prototype.hasOwnProperty.call(capoMap(), id);
function setCapo(id, n, trans) { if (!id) return; const m = capoMap(); m[id] = { c: n, t: trans || 0 }; lsSet('capoBySong', m); }
// Re# -> Mib, Sol# -> Lab, La# -> Sib (come si scrivono di solito)
const nicerName = (c) => String(c).replace(/(^|\/)(Re|Sol|La)#/g, (w, pre, n) => pre + ({ Re: "Mib", Sol: "Lab", La: "Sib" })[n]);

// Accordi della canzone come si vedono (già trasposti) e quante volte compaiono
function chordCounts(lyrics, transpose) {
    const counts = {};
    String(lyrics || "").split("\n").forEach(l => layoutLine(l, transpose).forEach(seg => {
        if (seg.kind !== "chord") return;
        const c = String(seg.display || "").replace(/[()\s]/g, "");
        if (c) counts[c] = (counts[c] || 0) + 1;
    }));
    return counts;
}

function capoBannerHtml(capo) {
    return `<div class="capo-banner"><i class="bi bi-sliders2-vertical"></i><span>Capotasto al <b>${capo}° tasto</b>: gli accordi sono le forme da suonare.</span><button type="button" onclick="window.openCapoSheet()">cambia</button></div>`;
}

let capoCache = { key: null, opts: null };
function capoOptionsFor(txt, transpose) {
    const key = transpose + "|" + txt;
    if (capoCache.key !== key) capoCache = { key, opts: capoOptions(chordCounts(txt, transpose)) };
    return capoCache.opts;
}

function updateCapoUi(txt) {
    const btn = document.getElementById("btnCapo"), label = document.getElementById("capoLabel");
    if (!btn || !label) return;
    const opts = capoOptionsFor(txt, currentTranspose);
    btn.hidden = !opts;
    if (!opts) return;
    const capo = capoFor(currentSongId, currentTranspose);
    const sug = !capoChosen(currentSongId) && opts.suggested ? opts.suggested : null;
    label.textContent = capo ? `Capo ${capo}` : sug ? `Capo ${sug.capo}?` : "Capo";
    btn.classList.toggle("capo-hint", !!sug);
    btn.classList.toggle("capo-on", !!capo);
    btn.title = capo ? `Capotasto al ${capo}° tasto` : sug ? `Consiglio: capotasto ${sug.capo} (accordi: ${sug.shapes.slice(0, 5).join(" ")})` : "Capotasto";
}

window.openCapoSheet = () => {
    const txt = document.getElementById("lyricsEditor").value;
    const opts = capoOptionsFor(txt, currentTranspose);
    if (!opts) return notify("Questa canzone non ha accordi.", "info");
    const capo = capoFor(currentSongId, currentTranspose);
    const best = opts.suggested ? opts.suggested.capo : 0;
    const rows = opts.options.map(o => {
        const badges = (o.capo === best ? `<span class="capo-badge best">${o.capo ? "consigliato" : "già il più facile"}</span>` : "")
            + (o.capo === capo ? `<span class="capo-badge now">in uso</span>` : "");
        return `<button type="button" class="capo-row ${o.capo === capo ? "active" : ""}" data-capo="${o.capo}">
            <div class="capo-row-head"><b>${o.capo ? `Capotasto ${o.capo}` : "Senza capotasto"}</b>${badges}
                <span class="capo-diff ${o.barre ? "hard" : "easy"}">${o.barre ? `${o.barre} con barrè` : "senza barrè"}</span></div>
            <div class="capo-shapes">${o.shapes.slice(0, 10).map(c => `<span>${escapeHtml(c)}</span>`).join("")}</div>
        </button>`;
    }).join("");
    const intro = opts.suggested
        ? `Con il <b>capotasto al ${opts.suggested.capo}° tasto</b> la canzone resta nella stessa tonalità ma suoni accordi più facili${opts.suggested.barre < opts.current.barre ? " (meno barrè)" : ""}.`
        : `Gli accordi sono già tra i più facili: il capotasto non serve.`;
    const sheet = openSheet({ title: "Capotasto", html: `<p class="small mb-2">${intro}</p>
        <p class="small text-muted">Tocca una riga: l'anteprima mostra gli accordi da suonare con quel capotasto. La scelta resta salvata su questo telefono.</p>
        <div class="capo-list">${rows}</div>` });
    sheet.body.addEventListener("click", (ev) => {
        const row = ev.target.closest("[data-capo]");
        if (!row) return;
        const n = +row.dataset.capo;
        setCapo(currentSongId, n, currentTranspose);
        sheet.close();
        window.renderPreview();
        notify(n ? `Capotasto al ${n}° tasto: ora vedi gli accordi da suonare.` : "Senza capotasto", "success", { duration: 2500 });
    });
};

// --- MODALITÀ ESIBIZIONE ------------------------------------------------------------------------------
// Schermo intero, testo grande, scorri verso sinistra per la canzone dopo (verso destra per quella prima),
// ogni canzone nella tonalità salvata nella scaletta. Se lo scorrimento automatico era acceso riparte da solo.
let perform = null;          // { list:[{id, trans, lyrics?}], index, setlistId, lead, follow, auto, unsub, live }
let autoInternal = false;    // stop/avvio fatti dall'app (fine canzone, cambio canzone): non contano come scelta
let performWake = null;
let performFontSize = lsGet('performFont', 22);
let performHideChords = lsGet('performHideChords', false);
const deviceId = (() => { let id = lsGet('deviceId', null); if (!id) { id = Math.random().toString(36).slice(2, 10); lsSet('deviceId', id); } return id; })();

const scrollSongId = () => (perform ? perform.list[perform.index].id : currentSongId);
function autoScrollInternal(on) {
    if (!!autoScrollInterval === on) return;
    autoInternal = true;
    try { window.toggleAutoScroll(); } finally { autoInternal = false; }
}
function updatePerformScrollBtn() {
    const b = document.getElementById("performScrollBtn");
    if (!b) return;
    b.classList.toggle("on", !!autoScrollInterval);
    b.innerHTML = autoScrollInterval ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-mouse3"></i>';
}

function keyOf(lyrics, trans) {
    try {
        const a = analyzeKey(lyrics || "");
        if (!a || a.fit < 0.6) return "";
        return transposeChord(normalizeChord(a.key), trans || 0);
    } catch (e) { return ""; }
}
const toPerformList = (songs) => (songs || []).map(it => typeof it === "string" ? { id: it, trans: 0 } : { id: it.id, trans: it.trans || 0 })
    .filter(it => allSongs.some(s => s.id === it.id));

async function performKeepAwake(on) {
    try {
        if (on && 'wakeLock' in navigator && !performWake) { performWake = await navigator.wakeLock.request('screen'); performWake.addEventListener('release', () => { performWake = null; }); }
        if (!on && performWake) { await performWake.release(); performWake = null; }
    } catch (e) { performWake = null; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && perform) performKeepAwake(true); });

function requestFs() {
    try { const el = document.documentElement; const p = el.requestFullscreen && el.requestFullscreen({ navigationUI: "hide" }); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}
function exitFs() {
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {}); } catch (e) {}
}

function renderPerform(keepScroll = false) {
    if (!perform) return;
    const it = perform.list[perform.index];
    const s = allSongs.find(x => x.id === it.id) || { title: "Canzone non trovata", author: "", lyrics: "" };
    const lyrics = it.lyrics ?? s.lyrics ?? "";
    const trans = it.trans || 0, capo = capoFor(it.id, trans);
    const next = perform.list[perform.index + 1], prev = perform.list[perform.index - 1];
    const songOf = (x) => x ? allSongs.find(y => y.id === x.id) : null;
    const nextSong = songOf(next), prevSong = songOf(prev);
    const nextKey = next && nextSong ? keyOf(nextSong.lyrics, next.trans) : "";

    const body = document.getElementById("performBody");
    const ratio = keepScroll && body.scrollHeight ? body.scrollTop / body.scrollHeight : 0;
    body.style.fontSize = performFontSize + "px";
    body.innerHTML = `<div class="perform-lyrics${performHideChords ? " hide-chords" : ""}">${lyricsToHtml(lyrics, trans - capo)}</div>
        <div class="perform-end">${next ? `<button type="button" onclick="window.performGo(1)">Prossima: <b>${escapeHtml(nextSong ? nextSong.title : "")}</b>${nextKey ? ` · ${escapeHtml(nextKey)}` : ""} <i class="bi bi-chevron-right"></i></button>`
            : perform.list.length > 1 ? "Fine della scaletta" : ""}</div>`;
    body.scrollTop = keepScroll ? ratio * body.scrollHeight : 0;

    const key = keyOf(lyrics, trans);
    document.getElementById("performTitle").textContent = s.title;
    document.getElementById("performSub").textContent = [
        s.author,
        key ? `Tonalità ${key}${trans ? ` (${signed(trans)})` : ""}` : trans ? `Tono ${signed(trans)}` : "",
        capo ? `Capo ${capo}` : "",
    ].filter(Boolean).join(" · ");
    const prevEl = document.getElementById("performPrev"), nextEl = document.getElementById("performNext");
    prevEl.textContent = prevSong ? prevSong.title : "";
    nextEl.textContent = nextSong ? nextSong.title + (nextKey ? ` · ${nextKey}` : "") : "";
    prevEl.parentElement.disabled = !prev;
    nextEl.parentElement.disabled = !next;
    document.getElementById("performPos").textContent = perform.list.length > 1 ? `${perform.index + 1} / ${perform.list.length}` : "";
    updateLiveUi();
    updatePerformScrollBtn();
}

function openPerform(list, index = 0, opts = {}) {
    if (!list.length) return notify("La scaletta è vuota.", "info");
    const wasScrolling = !!autoScrollInterval;
    if (wasScrolling) autoScrollInternal(false);
    closeAllSheets();
    perform = { list, index: Math.max(0, Math.min(index, list.length - 1)), setlistId: opts.setlistId || null,
                lead: false, follow: !!opts.follow, auto: wasScrolling, unsub: null, live: null, lastLiveAt: null, timer: null };
    document.getElementById("performView").hidden = false;
    document.body.classList.add("performing");
    scrollContainer = document.getElementById("performBody");
    window.onAutoScrollEnd = performAutoScrollEnd;
    renderPerform();
    history.pushState({ ...(history.state || {}), perform: true }, "", "#esibizione");
    if (!opts.noFullscreen) requestFs();
    performKeepAwake(true);
    if (perform.setlistId) watchLive();
    if (perform.auto) restartAutoScrollSoon(600);
}

window.openPerformSetlist = () => {
    const sl = allSetlists.find(s => s.id === currentSetlistId);
    if (!sl) return;
    openPerform(toPerformList(sl.songs), 0, { setlistId: sl.id });
};
window.openPerformSong = () => {
    if (!currentSongId) return;
    openPerform([{ id: currentSongId, trans: currentTranspose, lyrics: document.getElementById("lyricsEditor").value }], 0);
};

window.closePerform = (fromPop = false) => {
    if (!perform) return;
    if (!fromPop && history.state && history.state.perform) { history.back(); return; }   // il popstate richiama closePerform(true)
    clearTimeout(perform.timer);
    if (autoScrollInterval) autoScrollInternal(false);
    if (perform.lead) pushLive(false);
    if (perform.unsub) try { perform.unsub(); } catch (e) {}
    perform = null;
    scrollContainer = null;
    window.onAutoScrollEnd = null;
    closeAllSheets();
    document.getElementById("performView").hidden = true;
    document.body.classList.remove("performing");
    exitFs();
    performKeepAwake(false);
    updateAutoScrollUi();
};

function restartAutoScrollSoon(ms = 1200) {
    if (!perform) return;
    clearTimeout(perform.timer);
    perform.timer = setTimeout(() => { if (perform && perform.auto && !autoScrollInterval) autoScrollInternal(true); }, ms);
}

function performShow(i, dir = 0, fromLive = false) {
    if (!perform || i < 0 || i >= perform.list.length) return;
    if (autoScrollInterval) autoScrollInternal(false);
    perform.index = i;
    renderPerform();
    const body = document.getElementById("performBody");
    body.classList.remove("slide-next", "slide-prev");
    if (dir) { void body.offsetWidth; body.classList.add(dir > 0 ? "slide-next" : "slide-prev"); }
    if (perform.lead && !fromLive) pushLive(true);
    if (perform.auto) restartAutoScrollSoon();
}
window.performGo = (d) => { if (perform) performShow(perform.index + d, d); };

function performAutoScrollEnd() {
    if (!perform) return notify("Fine della canzone", "info", { duration: 2000 });
    const next = perform.list[perform.index + 1];
    const s = next ? allSongs.find(x => x.id === next.id) : null;
    if (s) notify(`Fine. Prossima: ${s.title}`, "info", { duration: 4000, actions: [{ label: "Vai", onClick: () => window.performGo(1) }] });
    else notify(perform.list.length > 1 ? "Fine della scaletta" : "Fine della canzone", "info", { duration: 2500 });
}

window.performFont = (d) => {
    performFontSize = Math.min(48, Math.max(14, performFontSize + d));
    lsSet('performFont', performFontSize);
    renderPerform(true);
};
window.performToggleChords = () => {
    performHideChords = !performHideChords;
    lsSet('performHideChords', performHideChords);
    renderPerform(true);
};

// Scorri col dito: verso sinistra = canzone dopo, verso destra = canzone prima
(() => {
    let x0 = null, y0 = 0, t0 = 0;
    document.addEventListener("touchstart", (e) => {
        if (!perform || !e.target.closest("#performBody") || e.touches.length !== 1) { x0 = null; return; }
        x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
    }, { passive: true });
    document.addEventListener("touchend", (e) => {
        if (!perform || x0 === null) return;
        const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
        x0 = null;
        if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy) && Date.now() - t0 < 900) window.performGo(dx < 0 ? 1 : -1);
    });
})();

// Tastiera e pedaliere bluetooth: frecce destra/sinistra cambiano canzone, Pagina giù / spazio scorrono
// (in fondo alla canzone passano alla successiva), Esc chiude
document.addEventListener("keydown", (e) => {
    if (!perform || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (document.querySelector(".app-sheet-overlay, .app-dialog-overlay")) return;
    if (/input|textarea|select/i.test((e.target && e.target.tagName) || "")) return;
    const body = document.getElementById("performBody");
    if (e.key === "ArrowRight") { e.preventDefault(); window.performGo(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); window.performGo(-1); }
    else if (e.key === "PageDown" || e.key === "ArrowDown" || e.key === " ") {
        e.preventDefault();
        if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) window.performGo(1);
        else body.scrollBy({ top: body.clientHeight * 0.8, behavior: "smooth" });
    } else if (e.key === "PageUp" || e.key === "ArrowUp") { e.preventDefault(); body.scrollBy({ top: -body.clientHeight * 0.8, behavior: "smooth" }); }
    else if (e.key === "Escape") { e.preventDefault(); window.closePerform(); }
});

// --- DIRETTA: chi guida cambia canzone, sui telefoni di chi segue cambia da sola -----------------------
function pushLive(on = true) {
    if (!perform || !perform.setlistId) return;
    const it = perform.list[perform.index];
    const live = { on, index: perform.index, songId: it ? it.id : null, at: Date.now(), by: deviceId };
    perform.live = live;
    updateDoc(doc(db, "setlists", perform.setlistId), { live }).catch(err => notify("Diretta non inviata: " + err.message, "warning"));
}

const liveActive = (l) => !!(l && l.on && Date.now() - (l.at || 0) < 6 * 3600 * 1000);

function jumpToLive(l) {
    if (!perform || !l) return;
    let idx = l.songId ? perform.list.findIndex(x => x.id === l.songId) : -1;
    if (idx < 0) idx = l.index;
    if (idx >= 0 && idx < perform.list.length && idx !== perform.index) performShow(idx, idx > perform.index ? 1 : -1, true);
}

function watchLive() {
    if (!perform || !perform.setlistId || perform.unsub) return;
    const id = perform.setlistId;
    try {
        perform.unsub = onSnapshot(doc(db, "setlists", id), (snap) => {
            if (!perform || perform.setlistId !== id) return;
            const data = snap.data ? snap.data() : null;
            if (!data) return;
            // scaletta modificata da un altro telefono: aggiorno l'elenco restando sulla stessa canzone
            if (Array.isArray(data.songs)) {
                const sl = allSetlists.find(x => x.id === id);
                if (sl) sl.songs = data.songs;
                const list = toPerformList(data.songs);
                const same = (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id && (x.trans || 0) === (b[i].trans || 0));
                if (list.length && !same(list, perform.list)) {
                    const curId = perform.list[perform.index].id;
                    perform.list = list;
                    const k = list.findIndex(x => x.id === curId);
                    perform.index = k >= 0 ? k : Math.min(perform.index, list.length - 1);
                    renderPerform(true);
                }
            }
            const l = data.live || null;
            if (!perform.lead) perform.live = l;
            if (perform.follow && liveActive(l) && l.by !== deviceId && l.at !== perform.lastLiveAt) {
                perform.lastLiveAt = l.at;
                jumpToLive(l);
            }
            updateLiveUi();
        }, (err) => console.warn("Diretta non disponibile:", err));
    } catch (e) { console.warn(e); }
}

function updateLiveUi() {
    const b = document.getElementById("performLiveBtn");
    if (!b) return;
    b.hidden = !perform || !perform.setlistId;
    if (!perform) return;
    const other = !perform.lead && liveActive(perform.live) && perform.live.by !== deviceId;
    b.className = "perform-btn live-btn" + (perform.lead ? " leading" : perform.follow ? " following" : other ? " available" : "");
    b.innerHTML = perform.lead ? '<i class="bi bi-broadcast"></i><span>In diretta</span>'
        : perform.follow ? `<i class="bi bi-people-fill"></i><span>${other ? "Segui" : "In attesa"}</span>`
        : other ? '<i class="bi bi-broadcast"></i><span>Segui</span>' : '<i class="bi bi-broadcast"></i>';
    b.title = perform.lead ? "Stai guidando: tocca per finire la diretta"
        : perform.follow ? "Segui chi guida: tocca per scorrere da solo"
        : other ? "Qualcuno sta guidando questa scaletta: tocca per seguirlo" : "Guida dal vivo: gli altri vedono la canzone che scegli tu";
}

window.togglePerformLive = () => {
    if (!perform || !perform.setlistId) return;
    if (perform.follow) {
        perform.follow = false;
        notify("Non segui più: scorri tu le canzoni.", "info", { duration: 2500 });
        return updateLiveUi();
    }
    if (!perform.lead && liveActive(perform.live) && perform.live.by !== deviceId) {
        perform.follow = true;
        perform.lastLiveAt = perform.live.at;
        jumpToLive(perform.live);
        notify("Segui la diretta: la canzone cambia quando la cambia chi guida.", "success", { duration: 3000 });
        return updateLiveUi();
    }
    perform.lead = !perform.lead;
    pushLive(perform.lead);
    if (perform.lead) notify("Sei in diretta: chi apre il link «dal vivo» della scaletta vede la canzone che scegli tu.", "success",
        { duration: 7000, actions: [{ label: "Mostra il QR", onClick: () => window.openShareSetlist(true) }] });
    else notify("Diretta finita", "info", { duration: 2000 });
    updateLiveUi();
};

// --- CONDIVIDI LA SCALETTA (link e QR code) -------------------------------------------------------------
async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
    try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
    } catch (e) { return false; }
}

window.openShareSetlist = (live = false) => {
    const sl = allSetlists.find(s => s.id === ((perform && perform.setlistId) || currentSetlistId));
    if (!sl) return;
    const link = (v) => `${location.origin}${location.pathname}?scaletta=${encodeURIComponent(sl.id)}${v ? "&vivo=1" : ""}`;
    const sheet = openSheet({ title: `Condividi «${sl.name}»`, html: `
        <button type="button" class="share-qr" data-act="zoom" title="Tocca per ingrandire"></button>
        <label class="share-live"><input type="checkbox" class="share-live-check" ${live ? "checked" : ""}>
            <span><b>Dal vivo</b>: sul telefono di chi apre il link la canzone cambia quando la cambi tu in modalità esibizione (tasto <i class="bi bi-broadcast"></i>).</span></label>
        <input class="share-link" readonly>
        <div class="d-flex gap-2 mt-2">
            <button type="button" class="app-btn app-btn-primary flex-fill" data-act="copy"><i class="bi bi-clipboard me-1"></i>Copia link</button>
            ${navigator.share ? `<button type="button" class="app-btn app-btn-ghost flex-fill" data-act="share"><i class="bi bi-share me-1"></i>Invia</button>` : ""}
        </div>
        <p class="small text-muted mt-3 mb-0">Gli altri inquadrano il QR con la fotocamera e vedono la scaletta con le tonalità salvate. Serve la rete a chi lo apre la prima volta.</p>` });
    const draw = () => {
        const l = link(sheet.body.querySelector(".share-live-check").checked);
        sheet.body.querySelector(".share-link").value = l;
        sheet.body.querySelector(".share-qr").innerHTML = qrSvg(l, 240);
    };
    draw();
    sheet.body.addEventListener("change", draw);
    sheet.body.addEventListener("click", async (ev) => {
        const act = ev.target.closest("[data-act]");
        if (!act) return;
        const l = sheet.body.querySelector(".share-link").value;
        if (act.dataset.act === "zoom") act.classList.toggle("big");
        if (act.dataset.act === "copy") { const ok = await copyText(l); notify(ok ? "Link copiato" : "Non riesco a copiare: tieni premuto sul link", ok ? "success" : "warning", { duration: 2500 }); }
        if (act.dataset.act === "share") { try { await navigator.share({ title: sl.name, text: `Scaletta «${sl.name}»`, url: l }); } catch (e) {} }
    });
};

// Link aperto da un QR: ?scaletta=ID (&vivo=1 per seguire la diretta)
const startupParams = new URLSearchParams(location.search);
let startupHandled = false;
function handleStartupLink() {
    if (startupHandled) return;
    if (document.readyState !== "complete") { window.addEventListener("load", () => setTimeout(handleStartupLink, 0), { once: true }); return; }
    startupHandled = true;
    const id = startupParams.get("scaletta");
    if (!id) return;
    try { history.replaceState(history.state, "", location.pathname + (location.hash || "#home")); } catch (e) {}
    const sl = allSetlists.find(s => s.id === id);
    if (!sl) return notify("Scaletta non trovata: forse è stata eliminata.", "warning");
    window.openSetlistDetail(id);
    if (startupParams.get("vivo") === "1") {
        setTimeout(() => {
            openPerform(toPerformList(sl.songs), 0, { setlistId: id, follow: true, noFullscreen: true });
            notify("Segui la scaletta dal vivo: la canzone cambia da sola. Tocca «Segui» in alto per scorrere da solo.", "info", { duration: 5000 });
        }, 60);
    }
}

// --- ETICHETTE (momento e branca) ----------------------------------------------------------------------
let activeTags = new Set();
let filtersOpen = false;
const tagLabel = (t) => TAG_LABEL[t] || t;
// Le proposte si calcolano una volta per canzone (finché non cambiano titolo, autore, sezione o testo)
const tagSuggCache = new WeakMap();
function cachedSuggestions(s) {
    const c = tagSuggCache.get(s);
    if (c && c.t === s.title && c.a === s.author && c.c === s.category && c.l === s.lyrics) return c.v;
    const v = suggestTags(s);
    tagSuggCache.set(s, { t: s.title, a: s.author, c: s.category, l: s.lyrics, v });
    return v;
}
const pendingTagSuggestions = (s) => {
    const cur = new Set(s.tags || []), no = new Set(s.tagsNo || []);
    return cachedSuggestions(s).filter(x => !cur.has(x.tag) && !no.has(x.tag));
};

function matchTags(s) {
    if (!activeTags.size) return true;
    const tags = new Set(s.tags || []);
    // stesso gruppo: basta una (Ingresso O Comunione); gruppi diversi: tutte (Comunione E E/G)
    return TAG_GROUPS.every(g => {
        const want = g.tags.map(([k]) => k).filter(k => activeTags.has(k));
        return !want.length || want.some(k => tags.has(k));
    });
}

function renderSearchFilters() {
    const box = document.getElementById("searchFilters");
    if (!box) return;
    const counts = {};
    allSongs.forEach(s => (s.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
    if (!Object.keys(counts).length && !activeTags.size) { box.innerHTML = ""; return; }
    let html = `<div class="filters-row">
        <button type="button" class="filters-toggle ${filtersOpen ? "open" : ""}" data-act="toggle"><i class="bi bi-funnel${activeTags.size ? "-fill" : ""} me-1"></i>Momento e branca <i class="bi bi-chevron-${filtersOpen ? "up" : "down"}"></i></button>
        ${[...activeTags].map(t => `<button type="button" class="tag-chip on" data-tag="${escapeHtml(t)}">${escapeHtml(tagLabel(t))} <i class="bi bi-x"></i></button>`).join("")}
        ${activeTags.size ? `<button type="button" class="filters-clear" data-act="clear">togli filtri</button>` : ""}</div>`;
    if (filtersOpen) {
        html += `<div class="filters-panel">` + TAG_GROUPS.map(g => {
            const tags = g.tags.filter(([k]) => counts[k] || activeTags.has(k));
            if (!tags.length) return "";
            return `<div class="filters-group"><span class="filters-label">${escapeHtml(g.label)}</span>${tags.map(([k, l]) =>
                `<button type="button" class="tag-chip ${activeTags.has(k) ? "on" : ""}" data-tag="${k}">${escapeHtml(l)} <small>${counts[k] || 0}</small></button>`).join("")}</div>`;
        }).join("") + `<div class="filters-hint">Nello stesso gruppo basta un'etichetta (Ingresso o Comunione); tra gruppi diversi servono tutte (Comunione e E/G).</div></div>`;
    }
    box.innerHTML = html;
}
window.clearTagFilters = () => { activeTags.clear(); renderSearchFilters(); window.performGlobalSearch(); };
document.addEventListener("click", (e) => {
    if (!e.target.closest("#searchFilters")) return;
    const act = e.target.closest("[data-act]"), chip = e.target.closest("[data-tag]");
    if (act && act.dataset.act === "toggle") { filtersOpen = !filtersOpen; return renderSearchFilters(); }
    if (act && act.dataset.act === "clear") activeTags.clear();
    else if (chip) { const t = chip.dataset.tag; if (activeTags.has(t)) activeTags.delete(t); else activeTags.add(t); }
    else return;
    renderSearchFilters();
    window.performGlobalSearch();
});

function renderEditorTags(s) {
    const box = document.getElementById("editorTags");
    if (!box) return;
    const tags = (s && s.tags) || [];
    const pend = isAdmin && s ? pendingTagSuggestions(s) : [];
    box.innerHTML = tags.map(t => `<button type="button" class="tag-chip small on" data-filter-tag="${escapeHtml(t)}" title="Cerca le canzoni con questa etichetta">${escapeHtml(tagLabel(t))}</button>`).join("")
        + (isAdmin ? `<button type="button" class="tag-chip small add" onclick="window.openSongTagsSheet()"><i class="bi bi-tag"></i> ${tags.length ? "Modifica" : "Etichette"}${pend.length ? ` <span class="tag-dot">${pend.length}</span>` : ""}</button>` : "");
}
document.addEventListener("click", (e) => {
    const chip = e.target.closest("#editorTags [data-filter-tag]");
    if (!chip) return;
    const go = () => { hasUnsavedChanges = false; activeTags = new Set([chip.dataset.filterTag]); filtersOpen = false; window.renderDashboard(); };
    if (hasUnsavedChanges) confirmLeaveEditor().then(ok => { if (ok) go(); }); else go();
});

// Salva le etichette di una canzone (subito sullo schermo, poi sul database)
async function saveSongTags(s, tags, extra = {}) {
    const before = { tags: s.tags, tagsNo: s.tagsNo };
    const data = { tags: ALL_TAGS.filter(t => tags.includes(t)), ...extra };
    Object.assign(s, data);
    refreshTagsUi();
    try { await updateDoc(doc(db, "songs", s.id), data); return true; }
    catch (err) { Object.assign(s, before); refreshTagsUi(); notify("Etichette non salvate: " + err.message, "danger"); return false; }
}

window.openSongTagsSheet = (id = currentSongId) => {
    const s = allSongs.find(x => x.id === id);
    if (!s || !isAdmin) return;
    const sel = new Set(s.tags || []);
    const sugg = new Map(cachedSuggestions(s).map(x => [x.tag, x]));
    const draw = () => TAG_GROUPS.map(g => `<div class="tags-group"><div class="tags-group-label">${escapeHtml(g.label)}</div>${g.tags.map(([k, l]) => {
        const sg = sugg.get(k), proposed = sg && !sel.has(k);
        return `<button type="button" class="tag-chip ${sel.has(k) ? "on" : ""} ${proposed ? "suggested" : ""}" data-tag="${k}"${sg ? ` title="${escapeHtml("Proposta: " + sg.why)}"` : ""}>${escapeHtml(l)}${proposed ? ' <i class="bi bi-stars"></i>' : ""}</button>`;
    }).join("")}</div>`).join("");
    const why = [...sugg.values()].map(x => `<li><b>${escapeHtml(tagLabel(x.tag))}</b>${x.sure ? "" : " (probabile)"} — ${escapeHtml(x.why)}</li>`).join("");
    const sheet = openSheet({ title: `Etichette · ${s.title}`, html: `
        <p class="small text-muted mb-2">Tocca per aggiungere o togliere. <i class="bi bi-stars"></i> = proposta automatica.</p>
        <div class="tags-editor">${draw()}</div>
        ${why ? `<details class="tags-why"><summary>Perché queste proposte</summary><ul>${why}</ul></details>` : ""}
        <div class="d-flex gap-2 mt-3">
            ${sugg.size ? `<button type="button" class="app-btn app-btn-ghost" data-act="sugg"><i class="bi bi-stars me-1"></i>Aggiungi le proposte</button>` : ""}
            <button type="button" class="app-btn app-btn-primary ms-auto" data-act="save">Salva</button>
        </div>` });
    sheet.body.addEventListener("click", async (ev) => {
        const chip = ev.target.closest("[data-tag]"), act = ev.target.closest("[data-act]");
        if (chip) { const t = chip.dataset.tag; if (sel.has(t)) sel.delete(t); else sel.add(t); }
        else if (act && act.dataset.act === "sugg") sugg.forEach((_, t) => sel.add(t));
        else if (act && act.dataset.act === "save") {
            // le proposte lasciate fuori non vengono più riproposte
            const no = new Set(s.tagsNo || []);
            sugg.forEach((_, t) => { if (!sel.has(t)) no.add(t); else no.delete(t); });
            if (await saveSongTags(s, [...sel], { tagsNo: [...no] })) { sheet.close(); notify("Etichette salvate", "success", { duration: 2000 }); }
            return;
        } else return;
        sheet.body.querySelector(".tags-editor").innerHTML = draw();
    });
};

function refreshTagsUi() {
    if (isAdmin) {
        const n = allSongs.filter(s => pendingTagSuggestions(s).length).length;
        const badge = document.getElementById("tagsBadge");
        if (badge) { badge.textContent = n; badge.style.display = n ? "inline-block" : "none"; }
    }
    const view = document.querySelector(".view-screen.active");
    if (view && view.id === "view-tags") renderTagsView();
    if (view && view.id === "view-editor") renderEditorTags(allSongs.find(x => x.id === currentSongId));
    if (view && view.id === "view-dashboard") renderSearchFilters();
}

// Pagina admin "Etichette canzoni": proposte automatiche da accettare in blocco o una per una
let tagsFilter = "pending", tagsLimit = 40;
window.openTagsView = () => {
    if (!isAdmin) return;
    switchView("view-tags");
    tagsLimit = 40;
    document.getElementById("tagsToolbar").innerHTML = `
        <div class="tags-summary" id="tagsSummary"></div>
        <div class="tags-filterbar">
            <div class="search-modes m-0" id="tagsFilterBtns">
                <button data-f="pending">Con proposte</button><button data-f="none">Senza etichette</button><button data-f="all">Tutte</button>
            </div>
            <input type="search" id="tagsSearch" class="form-control form-control-sm" placeholder="Cerca titolo, autore o sezione...">
        </div>`;
    document.getElementById("tagsSearch").oninput = debounce(() => { tagsLimit = 40; renderTagsView(); }, 200);
    renderTagsView();
};

function renderTagsView() {
    const pend = new Map(allSongs.map(s => [s.id, pendingTagSuggestions(s)]));
    const sure = allSongs.map(s => ({ s, add: pend.get(s.id).filter(x => x.sure) })).filter(x => x.add.length);
    const sureN = sure.reduce((n, x) => n + x.add.length, 0);
    const allN = allSongs.reduce((n, s) => n + pend.get(s.id).length, 0);
    const withPend = allSongs.filter(s => pend.get(s.id).length).length;
    const untagged = allSongs.filter(s => !(s.tags || []).length).length;
    const summary = document.getElementById("tagsSummary");
    if (summary) summary.innerHTML = `
        <div class="small mb-2"><b>${withPend}</b> canzoni con proposte · <b>${untagged}</b> senza etichette · ${allSongs.length} in tutto.
            Le proposte <span class="tag-chip small suggested sure">sicure</span> vengono da sezione, titolo o autore; le <span class="tag-chip small suggested">probabili</span> dalle parole del testo.</div>
        <div class="d-flex flex-wrap gap-2">
            <button class="btn btn-success btn-sm fw-bold" onclick="window.acceptTagSuggestions(true)" ${sureN ? "" : "disabled"}><i class="bi bi-check2-all me-1"></i>Accetta le ${sureN} proposte sicure (${sure.length} canzoni)</button>
            <button class="btn btn-outline-light btn-sm" onclick="window.acceptTagSuggestions(false)" ${allN > sureN ? "" : "disabled"}>Accetta anche le probabili (${allN})</button>
        </div>`;
    document.querySelectorAll("#tagsFilterBtns button").forEach(b => b.classList.toggle("active", b.dataset.f === tagsFilter));
    const q = robustNormalize((document.getElementById("tagsSearch") || {}).value || "");
    const list = allSongs.filter(s => tagsFilter === "all" || (tagsFilter === "pending" ? pend.get(s.id).length : !(s.tags || []).length))
        .filter(s => !q || robustNormalize(`${s.title} ${s.author || ""} ${s.category || ""}`).includes(q))
        .sort((a, b) => a.title.localeCompare(b.title));
    const box = document.getElementById("tagsList");
    if (!list.length) { box.innerHTML = `<div class="text-center text-muted mt-4">${tagsFilter === "pending" ? "Nessuna proposta da controllare." : "Nessuna canzone."}</div>`; return; }
    box.innerHTML = list.slice(0, tagsLimit).map(s => {
        const p = pend.get(s.id);
        return `<div class="tags-card" data-id="${s.id}">
            <div class="d-flex justify-content-between align-items-start gap-2">
                <div style="min-width:0"><b>${escapeHtml(s.title)}</b> <small class="text-muted">${escapeHtml(s.author || "")}</small>
                    <span class="badge bg-light text-dark ms-1">${escapeHtml(s.category || "")}</span></div>
                <button class="btn btn-sm btn-outline-secondary py-0" data-act="edit" title="Tutte le etichette"><i class="bi bi-pencil"></i></button>
            </div>
            <div class="tags-row">${(s.tags || []).map(t => `<button type="button" class="tag-chip small on" data-remove="${t}" title="Togli">${escapeHtml(tagLabel(t))} <i class="bi bi-x"></i></button>`).join("") || `<span class="text-muted small">nessuna etichetta</span>`}</div>
            ${p.length ? `<div class="tags-row">${p.map(x => `<span class="tag-sugg"><button type="button" class="tag-chip small suggested ${x.sure ? "sure" : ""}" data-add="${x.tag}" title="${escapeHtml(x.why)}"><i class="bi bi-plus"></i> ${escapeHtml(tagLabel(x.tag))}</button><button type="button" class="tag-no" data-no="${x.tag}" title="Non è giusta: non proporla più"><i class="bi bi-x"></i></button></span>`).join("")}
                <button type="button" class="btn btn-sm btn-success py-0 ms-auto" data-act="accept">Accetta</button><button type="button" class="btn btn-sm btn-outline-secondary py-0" data-act="reject">Scarta</button></div>
                <div class="tags-reasons">${p.map(x => `${escapeHtml(tagLabel(x.tag))}: ${escapeHtml(x.why)}`).join(" · ")}</div>` : ""}
        </div>`;
    }).join("") + (list.length > tagsLimit ? `<button class="btn btn-outline-secondary w-100 my-2" data-act="more">Mostra altre ${Math.min(40, list.length - tagsLimit)}...</button>` : "");
}

document.addEventListener("click", (e) => {
    const fb = e.target.closest("#tagsFilterBtns [data-f]");
    if (fb) { tagsFilter = fb.dataset.f; tagsLimit = 40; return renderTagsView(); }
    if (!e.target.closest("#tagsList")) return;
    if (e.target.closest("[data-act='more']")) { tagsLimit += 40; return renderTagsView(); }
    const card = e.target.closest(".tags-card");
    const s = card && allSongs.find(x => x.id === card.dataset.id);
    if (!s) return;
    const el = e.target.closest("[data-add], [data-remove], [data-no], [data-act]");
    if (!el) return;
    const tags = new Set(s.tags || []), no = new Set(s.tagsNo || []);
    const p = pendingTagSuggestions(s);
    if (el.dataset.add) tags.add(el.dataset.add);
    else if (el.dataset.remove) { tags.delete(el.dataset.remove); no.add(el.dataset.remove); }
    else if (el.dataset.no) no.add(el.dataset.no);
    else if (el.dataset.act === "accept") p.forEach(x => tags.add(x.tag));
    else if (el.dataset.act === "reject") p.forEach(x => no.add(x.tag));
    else if (el.dataset.act === "edit") return window.openSongTagsSheet(s.id);
    saveSongTags(s, [...tags], { tagsNo: [...no] });
});

async function writeTagsInChunks(updates) {
    for (let i = 0; i < updates.length; i += 400) {
        const chunk = updates.slice(i, i + 400);
        const b = writeBatch(db);
        chunk.forEach(u => b.update(doc(db, "songs", u.id), { tags: u.tags }));
        await b.commit();
        chunk.forEach(u => { const s = allSongs.find(x => x.id === u.id); if (s) s.tags = u.tags; });
    }
}

window.acceptTagSuggestions = async (onlySure) => {
    const changes = allSongs.map(s => ({ s, add: pendingTagSuggestions(s).filter(x => !onlySure || x.sure).map(x => x.tag) })).filter(x => x.add.length);
    if (!changes.length) return;
    const n = changes.reduce((t, x) => t + x.add.length, 0);
    const ok = await appConfirm(onlySure
        ? `Aggiungo ${n} etichette a ${changes.length} canzoni. Sono quelle sicure: vengono dalla sezione, dal titolo o dall'autore (es. sezione «Bans» → Bans). Potrai sempre toglierle.`
        : `Aggiungo tutte le ${n} etichette proposte a ${changes.length} canzoni, anche quelle dedotte dalle parole del testo (meno sicure). Potrai sempre toglierle.`,
        { title: onlySure ? "Accetta proposte sicure" : "Accetta tutte le proposte", okText: "Accetta" });
    if (!ok) return;
    const before = changes.map(({ s }) => ({ id: s.id, tags: [...(s.tags || [])] }));
    document.getElementById("loadingOverlay").style.display = "flex";
    try {
        await writeTagsInChunks(changes.map(({ s, add }) => ({ id: s.id, tags: ALL_TAGS.filter(t => (s.tags || []).includes(t) || add.includes(t)) })));
        notify(`Etichette aggiunte a ${changes.length} canzoni`, "success", { duration: 8000, actions: [{ label: "Annulla", primary: false,
            onClick: () => writeTagsInChunks(before).then(() => { refreshTagsUi(); notify("Annullato", "info", { duration: 2000 }); }).catch(err => notify("Errore: " + err.message, "danger")) }] });
    } catch (err) {
        notify("Errore salvataggio etichette: " + err.message, "danger");
    } finally {
        document.getElementById("loadingOverlay").style.display = "none";
        refreshTagsUi();
    }
};

// --- CRONOLOGIA DELLE MODIFICHE -------------------------------------------------------------------------
// Prima di ogni modifica la versione precedente viene copiata in songs/{id}/history.
// Non blocca mai il salvataggio: se il database non lo permette avvisa l'admin una volta sola.
let historyWarned = false;
const HISTORY_RULES = `match /songs/{songId}/history/{versionId} {\n  allow read, create: if request.auth != null;\n}`;
function historySnapshot(s, reason) {
    return { title: s.title || "", author: s.author || "", category: s.category || "", lyrics: s.lyrics || "",
             year: s.year || "", description: s.description || "", savedTranspose: s.savedTranspose || 0,
             savedAt: Date.now(), by: (auth.currentUser && auth.currentUser.email) || (isAdmin ? "admin" : "ospite"), reason: reason || "" };
}
function historyError(err) {
    console.warn("Cronologia non salvata:", err);
    if (historyWarned || !isAdmin) return;
    historyWarned = true;
    if (err && /permission/i.test(`${err.code || ""} ${err.message || ""}`))
        notify("La modifica è salvata, ma la cronologia no: nelle regole di Firestore manca il permesso per songs/{id}/history.", "warning", { duration: 12000,
            actions: [{ label: "Copia la regola", onClick: () => copyText(HISTORY_RULES).then(() => notify("Regola copiata: incollala nelle regole di Firestore", "success")) }] });
}
function recordHistory(s, reason) {
    if (!s || !s.id) return;
    try { addDoc(collection(db, "songs", s.id, "history"), historySnapshot(s, reason)).catch(historyError); } catch (e) { historyError(e); }
}
function recordHistoryBatch(songs, reason) {
    if (!songs.length) return;
    try {
        const b = writeBatch(db);
        songs.forEach(s => b.set(doc(collection(db, "songs", s.id, "history")), historySnapshot(s, reason)));
        b.commit().catch(historyError);
    } catch (e) { historyError(e); }
}

// Differenze riga per riga (sottosequenza comune più lunga)
function diffLines(a, b) {
    const A = String(a || "").split("\n"), B = String(b || "").split("\n");
    if (A.length * B.length > 600000) return [...A.map(l => ["-", l]), ...B.map(l => ["+", l])];
    const n = A.length, m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (A[i] === B[j]) { out.push([" ", A[i]]); i++; j++; }
        else if (L[i + 1][j] >= L[i][j + 1]) out.push(["-", A[i++]]);
        else out.push(["+", B[j++]]);
    }
    while (i < n) out.push(["-", A[i++]]);
    while (j < m) out.push(["+", B[j++]]);
    return out;
}
function diffHtml(ops) {
    const keep = ops.map((o, k) => o[0] !== " " || ops.slice(Math.max(0, k - 1), k + 2).some(x => x[0] !== " "));
    let html = "", skipped = 0;
    ops.forEach((o, k) => {
        if (!keep[k]) { skipped++; return; }
        if (skipped) { html += `<div class="diff-skip">… ${skipped} righe uguali …</div>`; skipped = 0; }
        html += `<div class="diff-line ${o[0] === "-" ? "old" : o[0] === "+" ? "new" : ""}"><span>${o[0] === "-" ? "−" : o[0] === "+" ? "+" : " "}</span>${escapeHtml(o[1]) || "&nbsp;"}</div>`;
    });
    if (skipped) html += `<div class="diff-skip">… ${skipped} righe uguali …</div>`;
    return html;
}

window.openHistory = async () => {
    const s = allSongs.find(x => x.id === currentSongId);
    if (!s || !isAdmin) return;
    const sheet = openSheet({ title: `Cronologia · ${s.title}`, wide: true,
        html: `<div class="text-center text-muted py-4"><span class="spinner-border spinner-border-sm me-2"></span>Carico le versioni...</div>` });
    const versions = [];
    try {
        const snap = await getDocs(query(collection(db, "songs", s.id, "history"), orderBy("savedAt", "desc"), limit(30)));
        snap.forEach(d => versions.push({ id: d.id, ...d.data() }));
    } catch (err) {
        const perm = /permission/i.test(`${err.code || ""} ${err.message || ""}`);
        sheet.body.innerHTML = perm
            ? `<p>Il database non permette ancora di leggere la cronologia. Nella console di Firebase, in <b>Firestore → Regole</b>, aggiungi dentro <code>match /databases/{database}/documents</code>:</p><pre class="rules-snippet">${escapeHtml(HISTORY_RULES)}</pre><button class="app-btn app-btn-primary" data-act="copyrules">Copia la regola</button>`
            : `<p class="text-danger">Non riesco a leggere la cronologia: ${escapeHtml(err.message)}</p>`;
        sheet.body.addEventListener("click", (ev) => { if (ev.target.closest("[data-act='copyrules']")) copyText(HISTORY_RULES).then(() => notify("Regola copiata", "success")); });
        return;
    }
    if (!versions.length) {
        sheet.body.innerHTML = `<p class="mb-0">Nessuna versione precedente salvata. Da ora, ogni volta che qualcuno modifica questa canzone, la versione di prima resta qui e si può ripristinare.</p>`;
        return;
    }
    const REASONS = { testo: "testo", dati: "titolo/autore/sezione", unione: "unione", "proposta approvata": "proposta approvata", "correzione automatica": "correzione automatica", "prima del ripristino": "prima di un ripristino" };
    sheet.body.innerHTML = `<p class="small text-muted">Versioni precedenti, le più recenti prima. Tocca una versione per vedere cosa cambia rispetto a adesso:
        <span class="diff-line old d-inline-block px-1">com'era</span> <span class="diff-line new d-inline-block px-1">com'è adesso</span></p>` +
        versions.map((v, k) => {
            const ops = diffLines(v.lyrics, s.lyrics);
            const minus = ops.filter(o => o[0] === "-").length, plus = ops.filter(o => o[0] === "+").length;
            const meta = [["title", "titolo"], ["author", "autore"], ["category", "sezione"]].filter(([f]) => (v[f] || "") !== (s[f] || "")).map(([, l]) => l);
            const sum = (minus || plus ? `<span class="text-danger">−${minus}</span> <span class="text-success">+${plus}</span> righe` : "testo uguale") + (meta.length ? ` · ${meta.join(", ")}` : "");
            return `<div class="hist-item" data-k="${k}">
                <button type="button" class="hist-head" data-act="open"><div><b>${escapeHtml(fmtDate(v.savedAt))}</b> <small class="text-muted">${escapeHtml(v.by || "")}${v.reason ? " · " + escapeHtml(REASONS[v.reason] || v.reason) : ""}</small></div><small>${sum}</small></button>
                <div class="hist-body" hidden></div></div>`;
        }).join("");
    sheet.body.addEventListener("click", async (ev) => {
        const item = ev.target.closest(".hist-item");
        if (!item) return;
        const v = versions[+item.dataset.k];
        const act = ev.target.closest("[data-act]");
        if (act && act.dataset.act === "open") {
            const body = item.querySelector(".hist-body");
            if (body.hidden && !body.innerHTML) {
                const meta = [["title", "Titolo"], ["author", "Autore"], ["category", "Sezione"]].filter(([f]) => (v[f] || "") !== (s[f] || ""))
                    .map(([f, l]) => `<div class="small">${l}: <span class="diff-line old d-inline-block px-1">${escapeHtml(v[f] || "—")}</span> → <span class="diff-line new d-inline-block px-1">${escapeHtml(s[f] || "—")}</span></div>`).join("");
                const ops = diffLines(v.lyrics, s.lyrics);
                body.innerHTML = meta + (ops.some(o => o[0] !== " ") ? `<div class="diff-box">${diffHtml(ops)}</div>` : `<div class="small text-muted my-2">Il testo è uguale a quello di adesso.</div>`)
                    + `<button type="button" class="app-btn app-btn-primary mt-2" data-act="restore"><i class="bi bi-arrow-counterclockwise me-1"></i>Ripristina questa versione</button>`;
            }
            body.hidden = !body.hidden;
        }
        if (act && act.dataset.act === "restore") {
            if (await restoreVersion(s, v)) sheet.close();
        }
    });
};

async function restoreVersion(s, v) {
    if (hasUnsavedChanges && currentSongId === s.id) {
        const go = await appConfirm("Hai modifiche non salvate nell'editor: ripristinando una versione le perdi. Continuo?", { title: "Modifiche non salvate", danger: true, okText: "Continua" });
        if (!go) return false;
    }
    const ok = await appConfirm(`Ripristino la versione del ${fmtDate(v.savedAt)}? Quella di adesso resta nella cronologia, quindi puoi sempre tornare indietro.`,
        { title: "Ripristina versione", okText: "Ripristina", icon: "bi-arrow-counterclockwise" });
    if (!ok) return false;
    const lyrics = v.lyrics || "";
    const data = { lyrics, chords: extractChords(lyrics), title: v.title || s.title, author: v.author || "",
                   category: allSections.some(x => x.name === v.category) ? v.category : s.category, year: v.year || "", description: v.description || "" };
    recordHistory(s, "prima del ripristino");
    try {
        await updateDoc(doc(db, "songs", s.id), data);
    } catch (err) { notify("Ripristino non riuscito: " + err.message, "danger"); return false; }
    Object.assign(s, data);
    if (currentSongId === s.id) {
        document.getElementById("editorTitle").innerText = s.title;
        document.getElementById("editorAuthor").innerText = s.author || "";
        document.getElementById("editorMeta").innerText = [s.description, s.year ? `(${s.year})` : ""].filter(Boolean).join(" - ");
        document.getElementById("lyricsEditor").value = lyrics;
        hasUnsavedChanges = false;
        renderEditorTags(s);
        window.renderPreview();
    }
    notify("Versione ripristinata", "success");
    return true;
}

// --- USO OFFLINE ------------------------------------------------------------------------------------------
function updateOnlineUi() {
    const off = !navigator.onLine;
    const b = document.getElementById("offlineBadge");
    if (b) b.hidden = !off;
    document.body.classList.toggle("is-offline", off);
    const ready = document.getElementById("offlineReadyBadge");
    if (ready) ready.hidden = !lsGet('offlineReadyAt', 0);
}
window.addEventListener("offline", () => { updateOnlineUi(); notify("Sei offline: usi le canzoni salvate sul telefono.", "warning", { duration: 4000 }); });
window.addEventListener("online", () => { updateOnlineUi(); notify("Di nuovo online", "success", { duration: 2500 }); });
updateOnlineUi();

// Domanda al service worker (la parte dell'app che salva i file sul telefono)
async function swRequest(msg, timeout = 4000) {
    if (!("serviceWorker" in navigator)) return null;
    let reg = null;
    try { reg = await navigator.serviceWorker.getRegistration(); } catch (e) {}
    const target = navigator.serviceWorker.controller || (reg && reg.active);
    if (!target) return null;   // nessun service worker (anteprima, navigazione anonima...): niente attese
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), timeout);
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
        try { target.postMessage(msg, [ch.port2]); } catch (e) { clearTimeout(t); resolve(null); }
    });
}

window.openOfflineSheet = async () => {
    const sheet = openSheet({ title: "Uso offline", html: `<div class="offline-sheet"><div class="text-center text-muted py-3"><span class="spinner-border spinner-border-sm"></span></div></div>` });
    const draw = (st, busy = false) => {
        const online = navigator.onLine, readyAt = lsGet('offlineReadyAt', 0);
        const libsOk = st && st.libs === st.libsTotal;
        const row = (ok, icon, title, text) => `<div class="offline-row ${ok === true ? "ok" : ok === false ? "ko" : ""}"><i class="bi ${icon}"></i><div><b>${title}</b><div class="small">${text}</div></div></div>`;
        sheet.body.querySelector(".offline-sheet").innerHTML =
            row(online, online ? "bi-wifi" : "bi-wifi-off", online ? "Sei online" : "Sei offline", online ? "Puoi scaricare tutto adesso." : "Stai usando quello che è salvato sul telefono.")
            + row(persistenceOn, "bi-music-note-list", `${allSongs.length} canzoni sul telefono`, persistenceOn
                ? "Si salvano da sole ogni volta che apri l'app con la rete (anche sezioni e scalette)."
                : "Questo browser non le salva (succede in navigazione anonima): senza rete non le vedresti.")
            + row(st ? libsOk : null, "bi-phone", "App e librerie", st ? (libsOk ? "Salvate: l'app si apre anche senza rete." : `Salvate ${st.libs} su ${st.libsTotal}: premi «Scarica tutto» con la rete.`)
                : "Non verificabile: apri l'app dal sito (non in anteprima) o aggiungila alla schermata Home.")
            + `<p class="small text-muted mt-3">${readyAt ? `Ultimo download completo: ${escapeHtml(fmtDate(readyAt))}.` : "Non hai ancora fatto il download completo."}
               Prima di un campo senza rete premilo una volta, con la rete: salva le canzoni aggiornate, l'app, le icone e le copertine.</p>
               <button type="button" class="app-btn app-btn-primary w-100" data-act="download" ${!online || busy ? "disabled" : ""}>
               ${busy ? '<span class="spinner-border spinner-border-sm me-2"></span>Scarico...' : '<i class="bi bi-cloud-arrow-down me-1"></i>Scarica tutto per l\'uso offline'}</button>`;
    };
    draw(await swRequest({ type: "status" }, 2500));
    sheet.body.addEventListener("click", async (ev) => {
        if (!ev.target.closest("[data-act='download']")) return;
        draw(null, true);
        const res = await downloadAllOffline();
        draw(await swRequest({ type: "status" }, 2500));
        if (res.ok) notify(`Pronto per l'uso offline: ${allSongs.length} canzoni${res.files ? ` e ${res.files} file dell'app` : ""}.`, "success");
        else notify(res.error || "Download non completo: riprova con una connessione migliore.", "warning");
    });
};

async function downloadAllOffline() {
    if (!navigator.onLine) return { ok: false, error: "Sei offline: serve la rete per scaricare." };
    try {
        // 1. canzoni, sezioni e scalette aggiornate (finiscono nella copia sul telefono)
        await Promise.all(["songs", "sections", "setlists"].map(n => getDocs(collection(db, n))));
    } catch (err) { return { ok: false, error: "Canzoni non scaricate: " + err.message }; }
    // 2. file dell'app, librerie, icone e copertine con un indirizzo web
    const hosts = /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|www\.gstatic\.com|fonts\.(gstatic|googleapis)\.com/;
    const urls = new Set();
    try { performance.getEntriesByType("resource").forEach(e => { if (hosts.test(e.name)) urls.add(e.name); }); } catch (e) {}
    allSections.forEach(s => { if (/^https?:/.test(s.coverUrl || "")) urls.add(s.coverUrl); });
    const res = await swRequest({ type: "precache", urls: [...urls] }, 60000);
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
    lsSet('offlineReadyAt', Date.now());
    updateOnlineUi();
    return { ok: true, files: res ? res.ok : 0 };
}
