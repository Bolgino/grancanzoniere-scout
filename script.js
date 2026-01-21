import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getFirestore, collection, getDocs, doc, updateDoc, addDoc, deleteDoc, writeBatch, arrayUnion, arrayRemove, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, setPersistence, inMemoryPersistence } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { extractChords, normalizeChord, transposeChord } from "./music-utils.js";

// --- 1. FUNZIONI DI UTILITÀ ---
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
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
let hasUnsavedChanges = false;
let allSongs=[], allSections=[], allProposals=[], allSetlists = [];
let currentCategory=null, currentSongId=null, currentTranspose=0, currentFontSize=16;
let editingSectionId=null, currentCoverUrl="", sectionOrder=[];
let favorites = JSON.parse(localStorage.getItem('scoutFavorites')) || [];
let currentSetlistId = null;
let autoScrollInterval = null;
let exportSectionOrder = [];
let exportSectionCovers = {};
let targetMergeSongId = null;
let mDuplicateWarning; // Variabile per il modale
let pendingMergeData = null; // Dove salviamo i dati in attesa di conferma
// Loader phrases
const loaderPhrases = [
    "Allineo gli astri...", "Accordo la chitarra...", "Scaldo le corde vocali...",
    "Cerco il Nord...", "Preparo il fuoco...", "Consulto la mappa..."
];
let loaderInterval;

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

function startLoaderAnimation() {
    const textEl = document.getElementById('loaderText');
    if(!textEl) return;
    let i = 0;
    const changeText = () => {
        textEl.style.opacity = 0; 
        setTimeout(() => {
            textEl.innerText = loaderPhrases[i];
            textEl.style.opacity = 1; 
            i = (i + 1) % loaderPhrases.length;
        }, 200); 
    };
    textEl.innerText = loaderPhrases[0];
    i = 1;
    loaderInterval = setInterval(changeText, 1500);
}

// AVVIO PERSISTENZA E DATI
enableIndexedDbPersistence(db)
  .catch((err) => {
      console.warn("Persistenza offline non attiva:", err.code);
  })
  .finally(() => {
      setPersistence(auth, inMemoryPersistence)
        .then(() => console.log("Sessione In Memory"))
        .catch((error) => console.error("Errore auth:", error));

      onAuthStateChanged(auth, (user) => {
          isAdmin = !!user;
          document.body.classList.toggle('user-admin', isAdmin);
          
          const btnLogin = document.getElementById('btnLoginBtn');
          if(btnLogin) btnLogin.style.display = isAdmin ? 'none' : 'block'; // Block per riempire larghezza menu
          
          const btnAddTxt = document.getElementById('btnAddText');
          const btnSubmit = document.getElementById('btnSubmitSong');
          const infoProp = document.getElementById('proposalInfo');
          const propField = document.getElementById('proposerField');
          const prevCol = document.getElementById('previewContainerCol');

          if (isAdmin) {
              if(btnAddTxt) btnAddTxt.innerText = 'Aggiungi Canzone';
              if(btnSubmit) btnSubmit.innerText = 'Crea Subito';
              if(infoProp) infoProp.style.display = 'none';
              if(propField) propField.style.display = 'none';
              if(prevCol) prevCol.className = "col-md-7";
              loadProposals();
          } else {
              if(btnAddTxt) btnAddTxt.innerText = 'Proponi Canzone';
              if(btnSubmit) btnSubmit.innerText = 'Invia Proposta';
              if(infoProp) infoProp.style.display = 'block';
              if(propField) propField.style.display = 'block';
              if(prevCol) prevCol.className = "col-md-12";
          }
          loadData();
      });
  });
window.loadData = loadData;
async function loadData() {
    try {
        const secSnap = await getDocs(collection(db, "sections"));
        allSections = [];
        secSnap.forEach(d => allSections.push({id: d.id, ...d.data()}));
        
        const songSnap = await getDocs(collection(db, "songs"));
        allSongs = [];
        songSnap.forEach(d => {
            if(!d.data().title.startsWith("Info")) allSongs.push({id: d.id, ...d.data()})
        });
        
        const setlistSnap = await getDocs(collection(db, "setlists"));
        allSetlists = [];
        setlistSnap.forEach(d => allSetlists.push({id: d.id, ...d.data()}));
        allSetlists.sort((a,b) => a.name.localeCompare(b.name));

        const countEl = document.getElementById("totalSongsCount");
        if(countEl) countEl.innerText = allSongs.length;

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
        if(loader) loader.style.display = "none";
        if(loaderInterval) clearInterval(loaderInterval);
    }
}

async function loadProposals() {
    if(!isAdmin) return;
    const snap = await getDocs(collection(db, "proposals"));
    allProposals=[]; snap.forEach(d=>allProposals.push({id:d.id,...d.data()}));
    const b = document.querySelectorAll('#proposalsBadge');
    b.forEach(el => {
        if(allProposals.length>0){ el.innerText=allProposals.length; el.style.display='inline-block';}
        else{ el.style.display='none'; }
    });
}

window.renderDashboard = () => {
    switchView('view-dashboard');
    document.getElementById('globalSearch').value="";
    
    const favC=document.getElementById("favoritesContainer");
    const favS=document.getElementById("favoritesSection");
    const favs=allSongs.filter(s=>favorites.includes(s.id));
    if(favs.length>0){
        favS.style.display='block';
        favC.innerHTML=favs.map(s=>`<button class="list-group-item list-group-item-action border-0 d-flex justify-content-between align-items-center" onclick="window.openEditor('${s.id}')"><div><i class="bi bi-star-fill text-warning me-2"></i> <strong>${s.title}</strong></div><small class="text-muted">${s.author}</small></button>`).join('');
    } else favS.style.display='none';

    const c=document.getElementById("categoriesContainer"); c.innerHTML="";
    if(allSections.length===0) c.innerHTML=`<div class="text-center text-muted">Nessuna sezione presente.</div>`;
    
    allSections.forEach(sec => {
        const count=allSongs.filter(s=>s.category===sec.name).length;
        const bg=sec.coverUrl ? `background-image:url('${sec.coverUrl}')` : "";
        const ico=sec.coverUrl ? "" : `<i class="bi bi-music-note-beamed cat-icon"></i>`;
        
        c.innerHTML+=`<div class="col-md-4 col-sm-6"><div class="category-card shadow-sm"><div class="cat-cover" style="${bg}" onclick="window.openList('${sec.name}')">${ico}</div><div class="p-3 text-center" onclick="window.openList('${sec.name}')"><h5 class="fw-bold mb-1 text-truncate">${sec.name}</h5><small class="text-muted">${count} canzoni</small></div></div></div>`;
    });
};

window.performGlobalSearch = () => {
    const q = document.getElementById('globalSearch').value.toLowerCase();
    if (!q) { window.renderDashboard(); return; }
    
    const res = allSongs.filter(s => s.title.toLowerCase().includes(q) || (s.author && s.author.toLowerCase().includes(q)));
    document.getElementById("favoritesSection").style.display = 'none';
    
    document.getElementById("categoriesContainer").innerHTML = res.length ? res.map(s => {
        let badgeHtml = "";
        
        // LOGICA BOLLINI ADMIN (Esistente)
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

        // --- NUOVO: LOGICA BOLLINO TONALITÀ ---
        let transBadge = "";
        if (s.savedTranspose && s.savedTranspose !== 0) {
            const sign = s.savedTranspose > 0 ? "+" : "";
            transBadge = `<span class="badge bg-secondary bg-opacity-25 text-white border border-secondary ms-2" style="font-size: 0.75rem;">${sign}${s.savedTranspose}</span>`;
        }
        // --------------------------------------

        return `<div class="col-12"><div class="card shadow-sm border-0" onclick="window.openEditor('${s.id}')" style="cursor:pointer">
            <div class="card-body d-flex justify-content-between align-items-center">
                <div>
                    <h6 class="fw-bold mb-0">${s.title} ${badgeHtml} ${transBadge}</h6>
                    <small>${s.author} <span class="badge bg-light text-dark ms-2">${s.category}</span></small>
                </div>
                <i class="bi bi-chevron-right text-muted"></i>
            </div>
        </div></div>`;
    }).join('') : `<div class="text-center mt-4">Nessun risultato.</div>`;
};
window.openList = (cat) => {
    currentSetlistId = null;
    currentCategory=cat; switchView('view-list'); document.getElementById("listTitle").innerText=cat; document.getElementById("sectionSearchBox").value=""; 
    window.renderList(allSongs.filter(s=>s.category===cat)); 
};

window.filterSectionList = () => {
    const q=document.getElementById("sectionSearchBox").value.toLowerCase();
    window.renderList(allSongs.filter(s=>s.category===currentCategory && (s.title.toLowerCase().includes(q) || (s.author&&s.author.toLowerCase().includes(q)))));
};

window.renderList = (songs) => {
    const c = document.getElementById("songListContainer"); 
    c.innerHTML = "";
    songs.sort((a, b) => a.title.localeCompare(b.title));
    
    songs.forEach(s => {
        let badgeHtml = "";
        
        // --- LOGICA BOLLINI ESISTENTE ---
        if (isAdmin) {
            const hasLyrics = s.lyrics && s.lyrics.trim().length > 5;
            const hasChords = s.lyrics && s.lyrics.includes("[");
            if (hasLyrics && hasChords) badgeHtml = `<span class="status-dot status-green" title="Completo"></span>`;
            else if (hasLyrics) badgeHtml = `<span class="status-dot status-orange" title="Solo Testo"></span>`;
            else badgeHtml = `<span class="status-dot status-red" title="Vuoto"></span>`;
        }

        // --- NUOVO: BADGE TONALITÀ SALVATA ---
        let transBadge = "";
        if (s.savedTranspose && s.savedTranspose !== 0) {
            const sign = s.savedTranspose > 0 ? "+" : "";
            // Mostra un piccolo badge grigio chiaro con la tonalità
            transBadge = `<span class="badge bg-secondary bg-opacity-25 text-white border border-secondary ms-2" style="font-size: 0.75rem;">${sign}${s.savedTranspose}</span>`;
        }

        c.innerHTML += `
            <button class="list-group-item list-group-item-action p-3 border-0 mb-1 rounded shadow-sm" onclick="window.openEditor('${s.id}')">
                <div class="d-flex w-100 justify-content-between align-items-center">
                    <div><h6 class="mb-1 fw-bold">${s.title} ${badgeHtml} ${transBadge}</h6></div>
                    <small class="text-muted">${s.author || ''}</small>
                </div>
            </button>`;
    });
};
window.openEditor = (id) => {
    currentSongId=id; 
    const s=allSongs.find(x=>x.id===id);
    switchView('view-editor');
    document.getElementById("editorTitle").innerText=s.title;
    document.getElementById("editorAuthor").innerText=s.author;
    
    let metaText = [];
    if(s.description) metaText.push(s.description);
    if(s.year) metaText.push(`(${s.year})`);
    document.getElementById("editorMeta").innerText = metaText.join(" - ");

    const editor = document.getElementById("lyricsEditor");
    editor.value = s.lyrics || "";
    hasUnsavedChanges = false; 
    editor.oninput = () => { hasUnsavedChanges = true; window.renderPreview(); };

    // MODIFICA: Carica la tonalità salvata o metti 0 se non esiste
    currentTranspose = s.savedTranspose || 0; 
    const sign = currentTranspose > 0 ? "+" : "";
    document.getElementById("toneDisplay").innerText = currentTranspose === 0 ? "0" : sign + currentTranspose;

    updateFavIcon(); 
    window.renderPreview(); // Renderizzerà con la tonalità caricata
    if (autoScrollInterval) window.toggleAutoScroll();
};

window.renderPreview = () => {
    const txt = document.getElementById("lyricsEditor").value;
    const div = document.getElementById("previewArea"); 
    div.innerHTML = ""; 
    div.style.fontSize = currentFontSize + 'px';
    
    txt.split("\n").forEach(l => {
        let formattedLine = l.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                             .replace(/__(.*?)__/g, '<i>$1</i>');
        let pl = formattedLine.replace(/\[(.*?)\]/g, (m, p1) => 
            `<span class="chord-span">${transposeChord(normalizeChord(p1), currentTranspose)}</span>`
        );
        div.innerHTML += `<div>${pl || '&nbsp;'}</div>`;
    });
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
    const existingSong = allSongs.find(s => robustNormalize(s.title) === normInputTitle);

    // Preparazione oggetto dati
    const songData = { 
        title: t, author: a, category: c, lyrics: l, description: d, year: y, 
        chords: window.extractChords(l), createdAt: Date.now()
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
                    category: c
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
            showToast("Canzone Creata!", 'success'); 
            mAddSong.hide();
            window.openEditor(r.id); 
        } else { 
            await addDoc(collection(db,"proposals"), {...songData, proposer: p}); 
            showToast("Proposta inviata!", 'success'); 
            mAddSong.hide();
            window.goHome();
        }
    } catch(e) { 
        console.error(e); 
        showToast("Errore: " + e.message, 'danger');
    } finally { 
        document.getElementById("loadingOverlay").style.display = "none"; 
        loadData(); 
    }
};

// Funzione chiamata dal tasto "Sì, Unisci" del nuovo modale
window.executeMerge = async () => {
    if (!pendingMergeData) return;

    mDuplicateWarning.hide();
    document.getElementById("loadingOverlay").style.display = "flex";

    try {
        // Esegui l'aggiornamento su Firestore
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
                            c = transposeChord(normalizeChord(c), songTrans);
                            doc.setFont(undefined, 'bold'); doc.setFontSize(chordSize); doc.setTextColor(220, 53, 69);
                            doc.text(c, lineX, currentY);
                            const chordWidth = doc.getTextWidth(c);
                            lastChordEnd = lineX + chordWidth + 1; 
                        } else {
                            doc.setFont(undefined, 'normal'); doc.setFontSize(lyricSize); doc.setTextColor(0);
                            doc.text(p, lineX, currentY + 4);
                            const textWidth = doc.getTextWidth(p);
                            lineX += textWidth;
                            if (lineX < lastChordEnd) lineX = lastChordEnd;
                        }
                    });
                    currentY += (lineHeight + 4); 
                } else {
                    const cleanLine = l.replace(/\[.*?\]/g, ''); 
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
        l += `\\section{${secName}}\n`;
        
        allSongs.filter(s => s.category === secName)
                .sort((a, b) => a.title.localeCompare(b.title))
                .forEach(s => {
                    // RECUPERA TONALITÀ SALVATA
                    const tr = s.savedTranspose || 0;

                    l += `\\beginsong{${s.title}}[by={${s.author || ''}}]\n\\beginverse\n`;
                    
                    (s.lyrics || "").split("\n").forEach(line => {
                        // APPLICA TRASPOSIZIONE AGLI ACCORDI
                        let processedLine = line.replace(/\[(.*?)\]/g, (m, p1) => {
                            // Normalizza e poi Trasponi
                            const transposed = transposeChord(normalizeChord(p1), tr);
                            return `\\[${transposed}]`;
                        });
                        l += processedLine + "\n";
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

window.openLoginModal=()=>mLogin.show();

function manageDynamicBackgrounds() {
    const bg = document.getElementById('dynamic-background');
    if(bg) bg.style.display = 'block';
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
window.openSectionSettings=(id,name,url,e)=>{e.stopPropagation();editingSectionId=id;currentCategory=name;currentCoverUrl=url;document.getElementById("editSectionNameInput").value=name;document.getElementById("coverFileInput").value="";const img=document.getElementById("coverPreviewImg");img.src=url||"";img.style.display=url?'block':'none';mEditSection.show();};
window.previewCoverFile = () => {
    const fileInput = document.getElementById("coverFileInput");
    const f = fileInput.files[0];
    if (f) { const r = new FileReader(); r.onload = e => { const img = document.getElementById("coverPreviewImg"); img.src = e.target.result; img.style.display = 'block'; }; r.readAsDataURL(f); }
};
window.saveSectionSettings=async()=>{const n=document.getElementById("editSectionNameInput").value;const f=document.getElementById("coverFileInput").files[0];document.getElementById("loadingOverlay").style.display="flex";try{let u=currentCoverUrl;if(f)u=await fileToBase64(f);if(n!==currentCategory){const b=writeBatch(db);b.update(doc(db,"sections",editingSectionId),{name:n,coverUrl:u});allSongs.filter(s=>s.category===currentCategory).forEach(s=>b.update(doc(db,"songs",s.id),{category:n}));await b.commit();}else{await updateDoc(doc(db,"sections",editingSectionId),{coverUrl:u});}mEditSection.hide();showToast("Salvato");loadData();}catch(e){showToast(e.message,'danger');}finally{document.getElementById("loadingOverlay").style.display="none";}};
window.triggerDeleteSection = (id, name) => {
    // 1. Controllo di sicurezza
    if (!id) return window.showToast("Errore: ID Sezione non valido", "danger");

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
window.showAddModal=()=>{const s=document.getElementById("newSongCategorySelect");s.innerHTML="";allSections.forEach(sec=>s.innerHTML+=`<option value="${sec.name}">${sec.name}</option>`);document.getElementById("newSongTitle").value="";document.getElementById("newSongAuthor").value="";document.getElementById("newSongLyrics").value="";mAddSong.show();};
window.saveSong = async () => {
    const t = document.getElementById("lyricsEditor").value;
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
window.deleteCurrentSong = () => window.confirmModal('Eliminare definitivamente?', async () => {
    try {
        await deleteDoc(doc(db,"songs",currentSongId));
        allSongs = allSongs.filter(s => s.id !== currentSongId);
        if(favorites.includes(currentSongId)) { favorites = favorites.filter(id => id !== currentSongId); localStorage.setItem('scoutFavorites', JSON.stringify(favorites)); }
        showToast("Canzone eliminata"); window.goBackToList();
    } catch(e) { showToast("Errore eliminazione: " + e.message, 'danger'); }
});
window.openSongMetadataModal = () => {
    const s = allSongs.find(x => x.id === currentSongId); if (!s) return;
    document.getElementById("editSongTitleInput").value = s.title; document.getElementById("editSongAuthorInput").value = s.author;
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
    if (checkTitleDuplicate(t, currentSongId)) return showToast(`Attenzione: esiste già "${t}"`, 'danger');
    document.getElementById("loadingOverlay").style.display = "flex";
    try {
        await updateDoc(doc(db, "songs", currentSongId), { title: t, author: a, year: y, description: d, category: newCategory });
        const s = allSongs.find(x => x.id === currentSongId); if(s) { s.title = t; s.author = a; s.year = y; s.description = d; s.category = newCategory; }
        mEditSongMeta.hide(); document.getElementById("editorTitle").innerText = t; document.getElementById("editorAuthor").innerText = a;
        let metaText = []; if(d) metaText.push(d); if(y) metaText.push(`(${y})`); document.getElementById("editorMeta").innerText = metaText.join(" - ");
        showToast("Dati aggiornati", "success");
    } catch (e) { showToast("Errore salvataggio: " + e.message, "danger"); } finally { document.getElementById("loadingOverlay").style.display = "none"; }
};
window.openProposalsView = () => {
    window.switchView('view-proposals');
    const c = document.getElementById("proposalsContainer");
    c.innerHTML = "";
    if (allProposals.length === 0) c.innerHTML = "<div class='text-center mt-5 text-muted'>Nessuna proposta in attesa.</div>";
    
    allProposals.forEach(p => {
        // NOTA: Ho cambiato l'onclick del tasto verde da window.acceptProposal a window.openProposalEditor
        c.innerHTML += `
        <div class="card mb-3 shadow-sm border-secondary" style="background: #222;">
            <div class="card-body d-flex justify-content-between align-items-center">
                <div class="overflow-hidden">
                    <h5 class="fw-bold mb-1 text-white">${p.title}</h5>
                    <small class="text-muted d-block text-truncate">
                        ${p.author || 'Sconosciuto'} &bull; ${p.category}
                    </small>
                    <small class="text-secondary fst-italic">Proposto da: ${p.proposer || 'Anonimo'}</small>
                </div>
                <div class="d-flex gap-2 flex-shrink-0">
                    <button class="btn btn-warning btn-sm fw-bold" onclick="window.openProposalEditor('${p.id}')" title="Revisiona">
                        <i class="bi bi-pencil-square"></i> Revisiona
                    </button>
                    <button class="btn btn-outline-danger btn-sm" onclick="window.rejectProposal('${p.id}')" title="Rifiuta">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>
        </div>`;
    });
};
window.acceptProposal=(id)=>window.confirmModal("Approvare?",async()=>{const p=allProposals.find(x=>x.id===id);await addDoc(collection(db,"songs"),{title:p.title,author:p.author,category:p.category,lyrics:p.lyrics,chords:window.extractChords(p.lyrics)});await deleteDoc(doc(db,"proposals",id));showToast("Approvata!",'success');await loadProposals();loadData();window.openProposalsView();});
window.rejectProposal=(id)=>window.confirmModal("Rifiutare?",async()=>{await deleteDoc(doc(db,"proposals",id));await loadProposals();window.openProposalsView();});
window.showToast=(m,t='info')=>{const el=document.createElement('div');el.className=`toast align-items-center text-white bg-${t} border-0`;el.innerHTML=`<div class="d-flex"><div class="toast-body">${m}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;document.getElementById('toastContainer').appendChild(el);new bootstrap.Toast(el).show();};
window.confirmModal=(m,c)=>{document.getElementById('confirmMessage').innerText=m;document.getElementById('confirmBtnAction').onclick=()=>{c();mConfirm.hide();};mConfirm.show();};
window.switchView=(id)=>{document.querySelectorAll('.view-screen').forEach(el=>el.classList.remove('active'));document.getElementById(id).classList.add('active');window.scrollTo(0,0);};
window.goHome = () => { currentCategory = null; currentSongId = null; const searchInput = document.getElementById('globalSearch'); if(searchInput) searchInput.value = ""; window.renderDashboard(); };
window.goBackToList = () => { if (hasUnsavedChanges && !confirm("Modifiche non salvate. Uscire?")) return; if (currentSetlistId) { switchView('view-setlists'); document.getElementById('setlistsContainer').innerHTML = ""; document.getElementById('activeSetlistDetail').style.display = 'block'; window.renderActiveSetlistSongs(); } else if (currentCategory) { window.openList(currentCategory); } else { window.goHome(); } };
window.changeTone=(d)=>{currentTranspose+=d;document.getElementById("toneDisplay").innerText=currentTranspose;window.renderPreview();};
window.adjustFontSize=(d)=>{currentFontSize+=d;window.renderPreview();};
window.toggleChords=()=>document.getElementById('previewArea').classList.toggle('hide-chords');
window.toggleFavorite=()=>{if(favorites.includes(currentSongId))favorites=favorites.filter(id=>id!==currentSongId);else{favorites.push(currentSongId);showToast("Aggiunta ai preferiti",'success');}localStorage.setItem('scoutFavorites',JSON.stringify(favorites));updateFavIcon();};
function updateFavIcon(){document.getElementById('favIcon').className=favorites.includes(currentSongId)?"bi bi-star-fill":"bi bi-star";}
window.processTxtImport = () => {
    const fileInput = document.getElementById("txtImporter"); const file = fileInput.files[0]; if (!file) return;
    if (!confirm("Importare da TXT? (Admin)")) { fileInput.value = ""; return; }
    const reader = new FileReader();
    reader.onload = async (e) => {
        const text = e.target.result; const lines = text.split('\n'); document.getElementById("loadingOverlay").style.display = "flex";
        const batch = writeBatch(db); let operationCount = 0; let currentSectionName = "Generale"; const processedSections = new Set(allSections.map(s => s.name));
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
                if (operationCount >= 450) { await batch.commit(); operationCount = 0; }
            }
            if (operationCount > 0) await batch.commit(); showToast("Importazione completata!", "success"); loadData(); 
        } catch (error) { showToast("Errore import: " + error.message, "danger"); } finally { document.getElementById("loadingOverlay").style.display = "none"; fileInput.value = ""; }
    };
    reader.readAsText(file);
};
const normalizeStr = (str) => str ? str.trim().toLowerCase() : "";
function checkTitleDuplicate(title, excludeId = null) { const cleanTitle = normalizeStr(title); return allSongs.some(s => { if (excludeId && s.id === excludeId) return false; return normalizeStr(s.title) === cleanTitle; }); }
window.openSetlistsView = () => { switchView('view-setlists'); window.renderSetlistsList(); document.getElementById('activeSetlistDetail').style.display = 'none'; currentSetlistId = null; };
window.renderSetlistsList = () => {
    const c = document.getElementById("setlistsContainer"); c.innerHTML = "";
    if (allSetlists.length === 0) { c.innerHTML = `<div class="text-center text-muted p-3">Nessuna scaletta pubblica presente. Creane una!</div>`; return; }
    allSetlists.forEach(sl => { c.innerHTML += `<button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" onclick="window.openSetlistDetail('${sl.id}')"><div class="fw-bold"><i class="bi bi-folder2-open me-2 text-warning"></i>${sl.name}</div><span class="badge bg-secondary rounded-pill">${sl.songs.length}</span></button>`; });
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
    currentSetlistId = id;
    const sl = allSetlists.find(s => s.id === id);
    if (!sl) return;

    // --- CONTROLLO: CHI SEI? ---
    const mySetlists = JSON.parse(localStorage.getItem('mySetlists')) || [];
    const isOwner = mySetlists.includes(id);
    
    // Aggiungi classe al body: il CSS farà mostrare/nascondere i tasti
    if (isOwner) {
        document.body.classList.add('is-owner');
    } else {
        document.body.classList.remove('is-owner');
    }
    
    switchView('view-setlists'); 
    document.getElementById('setlistsContainer').innerHTML = "";
    document.getElementById('activeSetlistDetail').style.display = 'block';
    document.getElementById('activeSetlistTitle').innerText = sl.name;
    
    window.renderActiveSetlistSongs();
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
                    <strong class="text-primary">${idx + 1}. ${song.title}</strong>
                    <div class="small text-muted">${song.author || ''} 
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
window.saveSetlistSongTone = async (idx) => { const sl = allSetlists.find(s => s.id === currentSetlistId); if(!sl) return; const badge = document.getElementById(`badge-trans-${idx}`); const finalVal = parseInt(badge.getAttribute('data-val')); const newSongs = [...sl.songs]; let item = newSongs[idx]; if (typeof item === 'string') item = { id: item, trans: 0 }; else item = { ...item }; item.trans = finalVal; newSongs[idx] = item; await updateDoc(doc(db, "setlists", currentSetlistId), { songs: newSongs }); sl.songs = newSongs; badge.classList.remove('bg-warning'); badge.classList.add('bg-light'); showToast("Tonalità salvata!", "success"); };
function generateSnippetHtml(lyrics, transposeVal) {
    if (!lyrics) return "...";
    
    // Prende le prime 4 righe
    const lines = lyrics.split('\n').slice(0, 4);
    
    return lines.map(line => {
        // Logica per posizionare l'accordo
        // Usiamo uno span vuoto prima dell'accordo per ancorarlo alla posizione giusta
        const formattedLine = line.replace(/\[(.*?)\]/g, (match, p1) => {
            const originalChord = normalizeChord(p1);
            const newChord = transposeChord(originalChord, transposeVal);
            // La classe .snippet-chord ora lo sposterà in alto col CSS
            return `<span class="snippet-chord">${newChord}</span>`;
        });
        
        // Avvolgiamo la riga
        return `<div class="snippet-line">${formattedLine || '&nbsp;'}</div>`;
    }).join(''); 
}
window.deleteActiveSetlist = () => window.confirmModal("Eliminare questa scaletta?", async () => { try { await deleteDoc(doc(db, "setlists", currentSetlistId)); await loadData(); window.openSetlistsView(); showToast("Scaletta eliminata"); } catch(e) { showToast("Errore eliminazione", "danger"); } });
async function updateSetlistSongs(setlistId, newSongsArray) { try { const localSl = allSetlists.find(s => s.id === setlistId); if(localSl) localSl.songs = newSongsArray; if(currentSetlistId === setlistId) window.renderActiveSetlistSongs(); await updateDoc(doc(db, "setlists", setlistId), { songs: newSongsArray }); } catch(e) { showToast("Errore sync", "danger"); await loadData(); } }
window.moveSetlistSong = (idx, dir) => { const sl = allSetlists.find(s => s.id === currentSetlistId); if (!sl) return; if (idx + dir < 0 || idx + dir >= sl.songs.length) return; const newSongs = [...sl.songs]; const temp = newSongs[idx]; newSongs[idx] = newSongs[idx + dir]; newSongs[idx + dir] = temp; updateSetlistSongs(currentSetlistId, newSongs); };
window.removeFromSetlist = (idx) => { const sl = allSetlists.find(s => s.id === currentSetlistId); if (!sl) return; const newSongs = [...sl.songs]; newSongs.splice(idx, 1); updateSetlistSongs(currentSetlistId, newSongs); };
window.openAddToSetlistModal = () => { const c = document.getElementById('setlistSelectorContainer'); c.innerHTML = ""; if (allSetlists.length === 0) c.innerHTML = "<div class='small text-muted text-center'>Nessuna scaletta.</div>"; else allSetlists.forEach(sl => { c.innerHTML += `<button class="list-group-item list-group-item-action py-2" onclick="window.addSongToSetlistId('${sl.id}')">${sl.name}</button>`; }); mAddToSetlist.show(); };
window.createNewSetlistFromModal = async () => { const name = prompt("Nome nuova scaletta:"); if(name) { try { const docRef = await addDoc(collection(db, "setlists"), { name: name, songs: [], createdAt: Date.now() }); await loadData(); window.addSongToSetlistId(docRef.id); } catch(e) { showToast("Errore"); } } };
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
        // Se siamo a pagina 1 e non c'è copertina e non c'è indice, dobbiamo scendere sotto il titolo
        if (!hasCover && !includeToc && doc.internal.getNumberOfPages() === 1) currentY = 35;
        
        let currentCol = 1;
        
        const checkLimit = (heightNeeded) => {
            if (currentY + heightNeeded > MARGIN_BOTTOM) {
                if (isTwoColumns && currentCol === 1) {
                    currentCol = 2;
                    currentX = COL_2_X;
                    currentY = MARGIN_TOP;
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
                            c = transposeChord(normalizeChord(c), sTrans); 
                            doc.setFont(undefined, 'bold'); doc.setFontSize(chordSize); doc.setTextColor(220, 53, 69);
                            doc.text(c, lineX, currentY);
                            const chordWidth = doc.getTextWidth(c);
                            lastChordEnd = lineX + chordWidth + 1;
                        } else {
                            doc.setFont(undefined, 'normal'); doc.setFontSize(lyricSize); doc.setTextColor(0);
                            doc.text(p, lineX, currentY + 4);
                            const textWidth = doc.getTextWidth(p);
                            lineX += textWidth;
                            if (lineX < lastChordEnd) lineX = lastChordEnd;
                        }
                    });
                    currentY += (lineHeight + 4); 
                } else {
                    const cleanLine = l.replace(/\[.*?\]/g, ''); 
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
window.performSetlistSearch = () => { const q = document.getElementById("searchSetlistInput").value.toLowerCase(); const c = document.getElementById("searchSetlistResults"); c.innerHTML = ""; let res; if (q.trim() === "") res = allSongs.sort((a,b) => a.title.localeCompare(b.title)); else res = allSongs.filter(s => s.title.toLowerCase().includes(q) || (s.author && s.author.toLowerCase().includes(q))); if(res.length === 0) { c.innerHTML = "<div class='text-center text-muted p-2'>Nessun risultato</div>"; return; } const sl = allSetlists.find(x => x.id === currentSetlistId); res.forEach(s => { const isPresent = sl && sl.songs.some(item => (typeof item === 'string' ? item : item.id) === s.id); const btnClass = isPresent ? "btn-secondary disabled" : "btn-outline-primary"; const icon = isPresent ? '<i class="bi bi-check2"></i>' : '<i class="bi bi-plus-lg"></i>'; const action = isPresent ? "" : `onclick="window.addSongFromSearch('${s.id}')"`; c.innerHTML += `<div class="list-group-item list-group-item-action d-flex justify-content-between align-items-center"><div class="text-truncate" style="max-width: 80%;"><div class="fw-bold text-truncate">${s.title}</div><small class="text-muted text-truncate">${s.author || ''}</small></div><button class="btn btn-sm ${btnClass} rounded-circle" ${action} style="width: 32px; height: 32px; padding: 0;">${icon}</button></div>`; }); };
window.addSongFromSearch = (songId) => { const sl = allSetlists.find(s => s.id === currentSetlistId); if(sl) { const isPresent = sl.songs.some(item => (typeof item === 'string' ? item : item.id) === songId); if(isPresent) return showToast("Già in scaletta", "info"); const newSongs = [...sl.songs, { id: songId, trans: 0 }]; updateSetlistSongs(currentSetlistId, newSongs); showToast("Aggiunta!", "success"); window.performSetlistSearch(); } };
window.insertFormatting = (tag) => { const textarea = document.getElementById("lyricsEditor"); const start = textarea.selectionStart; const end = textarea.selectionEnd; textarea.value = textarea.value.substring(0, start) + tag + textarea.value.substring(start, end) + tag + textarea.value.substring(end); textarea.selectionStart = start + tag.length; textarea.selectionEnd = end + tag.length; textarea.focus(); window.renderPreview(); };
window.toggleAutoScroll = () => {
    const area = document.getElementById('previewArea');
    const btn = document.getElementById('btnAutoScroll');
    
    const setInteractingTrue = () => { isUserInteracting = true; };
    const setInteractingFalse = () => { isUserInteracting = false; };

    if (autoScrollInterval) { 
        // --- STOP SCROLL ---
        clearInterval(autoScrollInterval);
        autoScrollInterval = null;
        isUserInteracting = false;
        
        if(btn) {
            btn.classList.replace('btn-success', 'btn-outline-success');
            btn.innerHTML = '<i class="bi bi-mouse3"></i>';
        }

        // Rimuovi listener per pulizia
        area.removeEventListener('mousedown', setInteractingTrue);
        area.removeEventListener('mouseup', setInteractingFalse);
        area.removeEventListener('touchstart', setInteractingTrue);
        area.removeEventListener('touchend', setInteractingFalse);
    } else {
        // --- START SCROLL ---
        // Abbiamo RIMOSSO il controllo sulla lunghezza. Parte sempre.
        
        if(btn) {
            btn.classList.replace('btn-outline-success', 'btn-success');
            btn.innerHTML = '<i class="bi bi-pause-fill"></i>';
        }

        // Listener per fermare lo scroll se l'utente tocca lo schermo
        area.addEventListener('mousedown', setInteractingTrue);
        area.addEventListener('mouseup', setInteractingFalse);
        area.addEventListener('touchstart', setInteractingTrue, {passive: true});
        area.addEventListener('touchend', setInteractingFalse);

        autoScrollInterval = setInterval(() => {
            if (isUserInteracting) return; // Pausa se l'utente tocca
            
            // Logica fine pagina: controlla se siamo arrivati in fondo
            // Usiamo una tolleranza di 2px per sicurezza
            if (Math.ceil(area.scrollTop + area.clientHeight) >= area.scrollHeight - 2) {
                window.toggleAutoScroll(); // Ferma tutto quando arriva in fondo
                return;
            }
            area.scrollTop += 1; 
        }, 50); // Velocità
    }
};
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
                    let c = transposeChord(normalizeChord(p.replace(/[\[\]]/g,'')), currentTranspose);
                    doc.setTextColor(220, 53, 69); doc.setFont(undefined, 'bold');
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
            doc.text(l, MARGIN, currentY);
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
    if(s.author) meta.push(`by={${s.author}}`);
    if(s.year) meta.push(`sr={${s.year}}`);
    const metaStr = meta.length > 0 ? `[${meta.join(',')}]` : "";

    // Inizio Canzone
    l += `\\beginsong{${s.title}}${metaStr}\n`;
    l += `\\beginverse\n`;

    // Processamento righe
    const lines = rawLyrics.split("\n");
    lines.forEach(line => {
        // A. Gestione Accordi: [Do] -> \[C] 
        // Il pacchetto songs lavora meglio con accordi in Inglese (normalizeChord)
        let processed = line.replace(/\[(.*?)\]/g, (m, p1) => {
            return `\\[${normalizeChord(p1)}]`;
        });

        // B. Gestione Formattazione
        processed = processed.replace(/\*\*(.*?)\*\*/g, "\\textbf{$1}"); // Grassetto
        processed = processed.replace(/__(.*?)__/g, "\\textit{$1}");     // Corsivo

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
        const safeName = sec.name.replace(/'/g, "\\'"); 

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
                    <h5 class="fw-bold mb-0 text-white text-truncate">${sec.name}</h5>
                    <small class="text-white-50" style="font-size: 0.85rem;">${songCount} canzoni</small>
                </div>

                <div class="d-flex gap-2">
                    <button class="btn btn-outline-light btn-sm" title="Modifica" onclick="window.openSectionSettings('${sec.id}','${safeName}','${sec.coverUrl||''}', event)">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-outline-danger btn-sm" title="Elimina" onclick="window.triggerDeleteSection('${sec.id}', '${safeName}')">
                        <i class="bi bi-trash"></i>
                    </button>
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
            coverUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.readAsDataURL(fileInput.files[0]);
                reader.onload = () => resolve(reader.result);
                reader.onerror = error => reject(error);
            });
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
    switchView('view-export');
    
    // Reset variabili temporanee
    exportSectionCovers = {}; 
    document.getElementById("globalCoverInput").value = "";
    document.getElementById("exportPreviewImg").style.display = "none";
    document.getElementById("exportPreviewPlaceholder").style.display = "block";

    // Copia locale ordine sezioni + AGGIUNTA PROPRIETÀ included
    exportSectionOrder = [...allSections].map(s => ({...s, included: true})).sort((a, b) => {
        const orderA = (a.order !== undefined && a.order !== null) ? a.order : 9999;
        const orderB = (b.order !== undefined && b.order !== null) ? b.order : 9999;
        if (orderA !== orderB) return orderA - orderB;
        return a.name.localeCompare(b.name);
    });

    window.renderExportList();
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
        sel.innerHTML += `<option value="${sec.name}">${sec.name}</option>`;
    });

    // 4. Mostra la vista
    window.switchView('view-propose');
};
window.renderProposePreview = () => {
    const txt = document.getElementById("propLyrics").value;
    const div = document.getElementById("propPreviewArea");
    div.innerHTML = "";
    
    // Usa la stessa logica di rendering dell'editor principale
    txt.split("\n").forEach(l => {
        let formattedLine = l.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                             .replace(/__(.*?)__/g, '<i>$1</i>');
        
        let pl = formattedLine.replace(/\[(.*?)\]/g, (m, p1) => 
            `<span class="chord-span">${transposeChord(normalizeChord(p1), 0)}</span>`
        );
        div.innerHTML += `<div>${pl || '&nbsp;'}</div>`;
    });
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
    const cleanTitle = p.title.trim().toLowerCase();
    // Cerca canzone esistente con stesso titolo
    const duplicate = allSongs.find(s => s.title.trim().toLowerCase() === cleanTitle);
    
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
            <strong>ATTENZIONE:</strong> Esiste già una canzone chiamata <u>${duplicate.title}</u> nella sezione <b>${duplicate.category}</b>.<br>
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
    div.innerHTML = "";
    
    // Logica di formattazione (Grassetto, Corsivo, Accordi)
    txt.split("\n").forEach(l => {
        let formattedLine = l.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                             .replace(/__(.*?)__/g, '<i>$1</i>');
        
        // Evidenzia accordi
        let pl = formattedLine.replace(/\[(.*?)\]/g, (m, p1) => 
            `<span class="chord-span" style="color: #ff85c0; font-weight:bold;">${transposeChord(normalizeChord(p1), 0)}</span>`
        );
        div.innerHTML += `<div>${pl || '&nbsp;'}</div>`;
    });
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
        createdAt: Date.now()
    };

    document.getElementById("loadingOverlay").style.display = "flex";
    mReviewProposal.hide();

    try {
        // --- LOGICA DI MERGE ---
        if (targetMergeSongId) {
            // SE C'ERA UN DUPLICATO RILEVATO: AGGIORNA QUELLO ESISTENTE
            await updateDoc(doc(db, "songs", targetMergeSongId), finalData);
            
            // Aggiorna array locale
            const localS = allSongs.find(x => x.id === targetMergeSongId);
            if(localS) Object.assign(localS, finalData); // Aggiorna l'oggetto in memoria
            
            showToast("Proposta unita alla canzone esistente!", "success");
        } else {
            // SE NON C'ERA DUPLICATO: CREA NUOVA
            const r = await addDoc(collection(db, "songs"), finalData);
            allSongs.push({ id: r.id, ...finalData });
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
             onmouseenter="window.hoverSectionPreview('${sec.id}', '${sec.name.replace(/'/g, "\\'")}')">
            
            <div class="d-flex align-items-center gap-2 flex-grow-1" style="min-width:0;">
                <div class="form-check form-switch me-1">
                    <input class="form-check-input" type="checkbox" ${checkedAttr} onchange="window.toggleExportSection(${idx})">
                </div>

                <div class="d-flex flex-column">
                    <button class="btn btn-sm btn-link text-white py-0" onclick="window.moveExportSection(${idx}, -1)"><i class="bi bi-caret-up-fill"></i></button>
                    <button class="btn btn-sm btn-link text-white py-0" onclick="window.moveExportSection(${idx}, 1)"><i class="bi bi-caret-down-fill"></i></button>
                </div>
                
                <div class="text-truncate">
                    <div class="fw-bold small">${sec.name}</div>
                    <div class="d-flex align-items-center gap-1">
                        <small>${hasDbCover}</small>
                        <label class="btn btn-outline-secondary btn-xs py-0 px-1 border-0" style="font-size: 0.7rem;">
                            <i class="bi bi-upload"></i> Cambia
                            <input type="file" hidden accept="image/*" 
                                   data-sec-id="${sec.id}"
                                   onchange="window.updateExportPreview('section_custom', this, '${sec.name.replace(/'/g, "\\'")}')">
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
        const safeTitle = (s.title || "").replace(/;/g, ",");
        const safeAuthor = (s.author || "").replace(/;/g, ",");
        const safeYear = (s.year || "").replace(/;/g, "");
        const safeCategory = (s.category || "").replace(/;/g, ",");
        
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












