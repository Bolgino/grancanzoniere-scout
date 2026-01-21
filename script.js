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
    const q=document.getElementById('globalSearch').value.toLowerCase();
    if(!q) { window.renderDashboard(); return; }
    const res=allSongs.filter(s=>s.title.toLowerCase().includes(q) || (s.author&&s.author.toLowerCase().includes(q)));
    document.getElementById("favoritesSection").style.display='none';
    
    document.getElementById("categoriesContainer").innerHTML = res.length ? res.map(s => {
        let badgeHtml = "";
        if (isAdmin) {
            // LOGICA BOLLINI:
            const hasLyrics = s.lyrics && s.lyrics.trim().length > 5;
            const hasChords = s.lyrics && s.lyrics.includes("[");
            
            if (hasLyrics && hasChords) {
                // VERDE: Completo
                badgeHtml = `<span class="status-dot status-green" title="Completo"></span>`;
            } else if (hasLyrics) {
                // ARANCIO: Solo Testo
                badgeHtml = `<span class="status-dot status-orange" title="Solo Testo"></span>`;
            } else {
                // ROSSO: Vuoto
                badgeHtml = `<span class="status-dot status-red" title="Vuoto"></span>`;
            }
        }
        return `<div class="col-12"><div class="card shadow-sm border-0" onclick="window.openEditor('${s.id}')" style="cursor:pointer">
            <div class="card-body d-flex justify-content-between align-items-center">
                <div>
                    <h6 class="fw-bold mb-0">${s.title} ${badgeHtml}</h6>
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
        if (isAdmin) {
            // LOGICA BOLLINI:
            const hasLyrics = s.lyrics && s.lyrics.trim().length > 5;
            const hasChords = s.lyrics && s.lyrics.includes("[");
            
            if (hasLyrics && hasChords) {
                // VERDE
                badgeHtml = `<span class="status-dot status-green" title="Completo"></span>`;
            } else if (hasLyrics) {
                // ARANCIO
                badgeHtml = `<span class="status-dot status-orange" title="Solo Testo"></span>`;
            } else {
                // ROSSO
                badgeHtml = `<span class="status-dot status-red" title="Vuoto"></span>`;
            }
        }
        c.innerHTML += `
            <button class="list-group-item list-group-item-action p-3 border-0 mb-1 rounded shadow-sm" onclick="window.openEditor('${s.id}')">
                <div class="d-flex w-100 justify-content-between align-items-center">
                    <div><h6 class="mb-1 fw-bold">${s.title} ${badgeHtml}</h6></div>
                    <small class="text-muted">${s.author || ''}</small>
                </div>
            </button>`;
    });
};

window.openEditor = (id) => {
    currentSongId=id; const s=allSongs.find(x=>x.id===id);
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

    currentTranspose=0; document.getElementById("toneDisplay").innerText="0";
    updateFavIcon(); window.renderPreview();
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
    // Nuovi ID della vista Proponi
    const t = document.getElementById("propTitle").value.trim();
    const a = document.getElementById("propAuthor").value.trim(); 
    const c = document.getElementById("propCategory").value; 
    const l = document.getElementById("propLyrics").value; 
    const p = document.getElementById("propUser").value.trim();
    const d = document.getElementById("propDesc").value.trim();
    const y = document.getElementById("propYear").value;

    if(!t) return showToast("Manca il Titolo!", 'warning');
    if(!isAdmin && !p) return showToast("Il tuo nome è obbligatorio", 'warning'); 

    if (checkTitleDuplicate(t)) return showToast(`Esiste già "${t}"!`, 'danger');

    const songData = { 
        title: t, 
        author: a, 
        category: c, 
        lyrics: l, 
        description: d, 
        year: y, 
        chords: window.extractChords(l),
        createdAt: Date.now()
    };

    document.getElementById("loadingOverlay").style.display = "flex"; 

    try {
        if(isAdmin){ 
            const r = await addDoc(collection(db,"songs"), {...songData, added:true}); 
            allSongs.push({ id: r.id, ...songData, added: true });
            showToast("Canzone Creata!", 'success'); 
            window.openEditor(r.id); 
        } else { 
            await addDoc(collection(db,"proposals"), {...songData, proposer: p}); 
            showToast("Proposta inviata con successo!", 'success'); 
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
window.generateFullPDF = async () => {
    const showChords = document.getElementById("pdfShowChords").checked;
    
    if(document.getElementById("loadingOverlay")) document.getElementById("loadingOverlay").style.display="flex";
    
    const { jsPDF } = window.jspdf;
    const isTwoColumns = document.getElementById("pdfTwoColumns").checked;

    const doc = new jsPDF({ format: 'a4', orientation: 'portrait', unit: 'mm' });
    const PAGE_WIDTH = 210;
    const PAGE_HEIGHT = 297;
    const MARGIN_TOP = 20;
    const MARGIN_BOTTOM = 280;
    const SIDE_MARGIN = 15;
    const GUTTER = 10;

    // --- 1. GENERAZIONE COPERTINA ---
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

    // --- 2. PREPARAZIONE DATI E STIMA PAGINE INDICE ---
    // Usa l'ordine locale se definito, altrimenti quello standard
    const sourceList = (typeof exportSectionOrder !== 'undefined' && exportSectionOrder.length > 0) 
                        ? exportSectionOrder 
                        : allSections;
    const finalOrderNames = sourceList.map(s => s.name);

    // Calcoliamo quanti elementi totali abbiamo per l'indice
    let totalTocItems = 0;
    for (const secName of finalOrderNames) {
        const songs = allSongs.filter(s => s.category === secName);
        if (songs.length > 0) {
            totalTocItems++; // Titolo sezione
            totalTocItems += songs.length; // Canzoni
        }
    }

    // STIMA: Circa 90 righe per pagina (su 2 colonne). 
    // Arrotondiamo per eccesso per stare sicuri.
    const tocPagesNeeded = Math.ceil(totalTocItems / 90);
    
    // Aggiungi le pagine bianche per l'indice (dopo la copertina che è pag 1)
    for(let i=0; i < tocPagesNeeded; i++) {
        doc.addPage(); 
    }

    let tocData = []; 

    // Parametri layout canzoni
    const COL_WIDTH = isTwoColumns ? (PAGE_WIDTH - (SIDE_MARGIN * 2) - GUTTER) / 2 : (PAGE_WIDTH - (SIDE_MARGIN * 2));
    const COL_1_X = SIDE_MARGIN;
    const COL_2_X = isTwoColumns ? (SIDE_MARGIN + COL_WIDTH + GUTTER) : SIDE_MARGIN;

    let currentX = COL_1_X;
    let currentY = MARGIN_TOP;
    let currentCol = 1;

    // Funzione controllo fine pagina
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

    // --- 3. LOOP SEZIONI E CANZONI ---
    // Partiamo con una nuova pagina dopo quelle prenotate per l'indice
    doc.addPage();
    currentCol = 1; currentX = COL_1_X; currentY = MARGIN_TOP;

    for (const secName of finalOrderNames) {
        const songs = allSongs.filter(s => s.category === secName).sort((a,b)=>a.title.localeCompare(b.title));
        if (songs.length === 0) continue;

        // Nuova pagina per ogni nuova sezione (opzionale, ma più pulito)
        if (currentY > MARGIN_TOP) {
             doc.addPage();
             currentCol = 1; currentX = COL_1_X; currentY = MARGIN_TOP;
        }
        
        // Salviamo dati per l'indice (Pagina corrente)
        tocData.push({ type: 'section', text: secName.toUpperCase(), page: doc.internal.getCurrentPageInfo().pageNumber });
        
        // Titolo Sezione nella pagina
        doc.setTextColor(0, 51, 102); doc.setFont("helvetica", "bold"); doc.setFontSize(30);
        doc.text(secName.toUpperCase(), PAGE_WIDTH/2, 100, {align: 'center'});
        
        doc.addPage();
        currentCol = 1; currentX = COL_1_X; currentY = MARGIN_TOP;

        for (const s of songs) {
            // Aggiungi canzone all'indice
            tocData.push({ type: 'song', text: s.title, subtext: s.author, page: doc.internal.getCurrentPageInfo().pageNumber });

            checkLimit(25);

            // -- TITOLO --
            doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(0, 51, 102);
            const titleLines = doc.splitTextToSize(s.title.toUpperCase(), COL_WIDTH);
            doc.text(titleLines, currentX, currentY);
            currentY += (titleLines.length * 5);

            // -- AUTORE --
            if(s.author) {
                doc.setFont("helvetica", "italic"); doc.setFontSize(9); doc.setTextColor(100);
                const authTxt = s.year ? `${s.author} (${s.year})` : s.author;
                doc.text(authTxt, currentX + COL_WIDTH, currentY - 5, {align: 'right'}); 
            }

            // -- NOTE (Descrizione) --
            if (s.description) {
                doc.setFont("helvetica", "italic"); 
                doc.setFontSize(8); 
                doc.setTextColor(50);
                
                const noteWidth = COL_WIDTH - 4; 
                const splitNotes = doc.splitTextToSize(s.description, noteWidth);
                const blockHeight = (splitNotes.length * 3.5) + 4; 
                
                checkLimit(blockHeight);

                doc.setFillColor(240, 240, 240);
                doc.rect(currentX, currentY, COL_WIDTH, blockHeight, 'F');
                doc.text(splitNotes, currentX + 2, currentY + 3.5);
                
                currentY += blockHeight + 2; 
            } else {
                currentY += 4; 
            }

            // -- LINEA DIVISORIA (FIX SOVRAPPOSIZIONE) --
            doc.setDrawColor(200); doc.setLineWidth(0.2);
            doc.line(currentX, currentY - 2, currentX + COL_WIDTH, currentY - 2);
            currentY += 9; // Aumentato spazio per evitare che gli accordi Intro tocchino la linea
            
            // -- TESTO E ACCORDI --
            doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(0);
            
            const lines = (s.lyrics || "").split("\n");
            
            for (let l of lines) {
                l = l.replace(/\*\*|__/g, ''); 
                
                const parts = l.split(/(\[.*?\])/);
                const hasChords = parts.some(p => p.startsWith("["));
                const heightNeeded = hasChords ? 10 : 5;
                
                checkLimit(heightNeeded);

                let lineX = currentX;
                
                if (hasChords && showChords) { 
                    let lastChordEnd = 0; 
                    parts.forEach(p => {
                        if (p.startsWith("[")) {
                            let c = p.replace(/[\[\]]/g,'');
                            c = transposeChord(normalizeChord(c), 0); 
                            
                            doc.setFont(undefined, 'bold'); doc.setTextColor(220, 53, 69);
                            doc.text(c, lineX, currentY);
                            
                            const chordWidth = doc.getTextWidth(c);
                            lastChordEnd = lineX + chordWidth + 1; 

                        } else {
                            doc.setFont(undefined, 'normal'); doc.setTextColor(0);
                            doc.text(p, lineX, currentY + 4);
                            
                            const textWidth = doc.getTextWidth(p);
                            lineX += textWidth;

                            if (lineX < lastChordEnd) {
                                lineX = lastChordEnd;
                            }
                        }
                    });
                    currentY += 9; 
                } else {
                    const cleanLine = l.replace(/\[.*?\]/g, ''); 
                    doc.setFont(undefined, 'normal'); doc.setTextColor(0);
                    const splitText = doc.splitTextToSize(cleanLine, COL_WIDTH);
                    doc.text(splitText, lineX, currentY);
                    currentY += (splitText.length * 5);
                }
            }
            currentY += 8; 
        }
    }

    // --- 4. SCRITTURA INDICE (Nelle pagine prenotate all'inizio) ---
    // Torniamo alla pagina 2 (la prima dopo la copertina)
    if (tocPagesNeeded > 0 && tocData.length > 0) {
        let tocPageIdx = 2; // Pagina fisica (1-based)
        doc.setPage(tocPageIdx); 

        // Titolo Indice
        doc.setTextColor(0, 51, 102); doc.setFont("helvetica", "bold"); doc.setFontSize(22);
        doc.text("INDICE", PAGE_WIDTH/2, 20, {align: 'center'});
        
        let tocY = 40;
        let tocCol = 1; 
        const TOC_COL_WIDTH = 80;
        const TOC_COL_1_X = 20;
        const TOC_COL_2_X = 115;
        
        tocData.forEach(item => {
            // Se la colonna finisce
            if(tocY > 270) {
                 if(tocCol === 1) { 
                     tocCol = 2; 
                     tocY = 40; 
                 } else { 
                     // Se finisce la pagina, passa alla prossima pagina prenotata
                     tocPageIdx++;
                     if (tocPageIdx <= 1 + tocPagesNeeded) {
                         doc.setPage(tocPageIdx);
                         tocCol = 1; 
                         tocY = 40; 
                     } else {
                         // Sicurezza: se abbiamo sottostimato le pagine, ne aggiungiamo una nuova
                         // Nota: questo è raro se la stima è generosa
                         doc.insertPage(tocPageIdx); 
                         doc.setPage(tocPageIdx);
                         tocCol = 1; 
                         tocY = 40;
                     }
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
                // Stampa il numero di pagina salvato
                doc.text(String(item.page), tx + TOC_COL_WIDTH, tocY, {align:'right'});
                tocY += 5;
            }
        });
    }

    // --- 5. NUMERAZIONE PAGINE (PIÈ DI PAGINA SU TUTTO) ---
    const totalPages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
        // Salta copertina (pag 1)
        if (i === 1) continue;
        
        doc.setPage(i);
        doc.setFont("helvetica", "normal"); 
        doc.setFontSize(9); 
        doc.setTextColor(150);
        doc.text(String(i), PAGE_WIDTH/2, 290, {align:'center'});
    }

    doc.save("Canzoniere_Completo.pdf");
    if(document.getElementById("loadingOverlay")) document.getElementById("loadingOverlay").style.display="none"; 
    window.showToast("PDF Scaricato!", "success");
    
    const exportModal = bootstrap.Modal.getInstance(document.getElementById('exportOptionsModal'));
    if(exportModal) exportModal.hide();
};

window.generateFullLatex=()=>{if(!isAdmin)return;let l=`\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[a5paper]{geometry}\n\\usepackage{songs}\n\\begin{document}\n\\title{Canzoniere}\\maketitle\\tableofcontents\\newpage\n`;sectionOrder.forEach(secName=>{l+=`\\section{${secName}}\n`;allSongs.filter(s=>s.category===secName).sort((a,b)=>a.title.localeCompare(b.title)).forEach(s=>{l+=`\\beginsong{${s.title}}[by={${s.author||''}}]\n\\beginverse\n`;(s.lyrics||"").split("\n").forEach(line=>{l+=line.replace(/\[(.*?)\]/g,(m,p1)=>`\\[${normalizeChord(p1)}]`)+"\n";});l+=`\\endverse\n\\endsong\n`;});});l+=`\\end{document}`;const b=new Blob([l],{type:'text/plain'});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="Canzoniere.tex";a.click();};

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
        await updateDoc(doc(db,"songs",currentSongId), { lyrics: t, chords: window.extractChords(t) });
        const s = allSongs.find(x => x.id === currentSongId); if(s) { s.lyrics = t; s.chords = window.extractChords(t); }
        hasUnsavedChanges = false; showToast("Salvato con successo!", 'success');
    } catch(e) { showToast("Errore salvataggio: " + e.message, 'danger'); }
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

    // Lettura corretta dell'ID sistemato nell'HTML
    const isTwoColumns = document.getElementById("setlistTwoColumns").checked;

    mExportSetlist.hide();
    document.getElementById("loadingOverlay").style.display = "flex";

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ format: 'a4', orientation: 'portrait', unit: 'mm' });

        const PAGE_WIDTH = 210;
        const MARGIN_TOP = 15;
        const MARGIN_BOTTOM = 280;
        const SIDE_MARGIN = 15;
        const GUTTER = 10;
        
        // Calcolo larghezza: se isTwoColumns è false, usa tutta la pagina
        const COL_WIDTH = isTwoColumns ? (PAGE_WIDTH - (SIDE_MARGIN * 2) - GUTTER) / 2 : (PAGE_WIDTH - (SIDE_MARGIN * 2));
        const COL_1_X = SIDE_MARGIN;
        const COL_2_X = isTwoColumns ? (SIDE_MARGIN + COL_WIDTH + GUTTER) : SIDE_MARGIN;

        let currentX = COL_1_X;
        let currentY = MARGIN_TOP;
        let currentCol = 1;
        
        const checkLimit = (heightNeeded) => {
            if (currentY + heightNeeded > MARGIN_BOTTOM) {
                // Se abilitate 2 colonne e sono nella prima, passa alla seconda
                if (isTwoColumns && currentCol === 1) {
                    currentCol = 2;
                    currentX = COL_2_X;
                    const isFirstPageWithoutCover = doc.internal.getNumberOfPages() === 1 && !document.getElementById('setlistCoverInputModal').files[0];
                    // FIX SOVRAPPOSIZIONE: Se prima pagina senza copertina, scendi sotto il titolo (Y=40)
                    currentY = isFirstPageWithoutCover ? 40 : MARGIN_TOP; 
                } else {
                    // Altrimenti aggiungi nuova pagina
                    doc.addPage();
                    currentCol = 1;
                    currentX = COL_1_X;
                    currentY = MARGIN_TOP;
                }
                return true;
            }
            return false;
        };


        const coverInput = document.getElementById('setlistCoverInputModal');
        if (coverInput && coverInput.files && coverInput.files[0]) {
            const coverBase64 = await fileToBase64(coverInput.files[0]);
            doc.addImage(coverBase64, 'JPEG', 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
            doc.setFillColor(255, 255, 255); doc.rect(0, 100, PAGE_WIDTH, 25, 'F');
            doc.setFont("helvetica", "bold"); doc.setFontSize(26); doc.setTextColor(0, 51, 102);
            doc.text(sl.name.toUpperCase(), PAGE_WIDTH/2, 117, {align: 'center'});
            doc.addPage();
        } else {
            doc.setFont("helvetica", "bold"); doc.setFontSize(22); doc.setTextColor(0, 51, 102);
            doc.text(sl.name.toUpperCase(), PAGE_WIDTH/2, 20, {align: 'center'});
            currentY = 35;
        }
        const showChords = document.getElementById("setlistShowChords").checked;

        for (const item of sl.songs) {
            const sId = typeof item === 'string' ? item : item.id;
            const sTrans = typeof item === 'object' ? (item.trans || 0) : 0;
            const s = allSongs.find(x => x.id === sId);
            if(!s) continue;
            
            checkLimit(30);

            doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(0, 51, 102);
            const titleLines = doc.splitTextToSize((s.title || "").toUpperCase(), COL_WIDTH);
            doc.text(titleLines, currentX, currentY);
            currentY += (titleLines.length * 5);
            
            if(s.author) {
                doc.setFont("helvetica", "italic"); doc.setFontSize(9); doc.setTextColor(100);
                const authTxt = s.year ? `${s.author} (${s.year})` : s.author;
                doc.text(authTxt, currentX + COL_WIDTH, currentY, {align: 'right'});
            }
            currentY += 2;

            if (s.description) {
                doc.setFont("helvetica", "italic"); 
                doc.setFontSize(8); 
                doc.setTextColor(50);
                
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
            
            doc.setDrawColor(200); doc.setLineWidth(0.2);
            doc.line(currentX, currentY, currentX + COL_WIDTH, currentY);
            currentY += 4;

            doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(0);
            const lines = (s.lyrics || "").split("\n");
            
            for (let l of lines) {
                l = l.replace(/\*\*|__/g, '');
                
                const parts = l.split(/(\[.*?\])/);
                const hasChords = parts.some(p => p.startsWith("["));
                const heightNeeded = hasChords ? 10 : 5;
                
                checkLimit(heightNeeded);
                
                let lineX = currentX;

                // Sostituisci il blocco degli accordi dentro il ciclo for (let l of lines)
                if (hasChords && showChords) { 
                    let lastChordEnd = 0; 
                    parts.forEach(p => {
                        if (p.startsWith("[")) {
                            let c = p.replace(/[\[\]]/g,'');
                            // USA sTrans che abbiamo calcolato sopra!
                            c = transposeChord(normalizeChord(c), sTrans); 
                            doc.setFont(undefined, 'bold'); doc.setTextColor(220, 53, 69);
                            doc.text(c, lineX, currentY);
                            const chordWidth = doc.getTextWidth(c);
                            lastChordEnd = lineX + chordWidth + 1;
                        } else {
                            doc.setFont(undefined, 'normal'); doc.setTextColor(0);
                            doc.text(p, lineX, currentY + 4);
                            const textWidth = doc.getTextWidth(p);
                            lineX += textWidth;
                            if (lineX < lastChordEnd) {
                                lineX = lastChordEnd;
                            }
                        }
                    });
                    currentY += 9;
                } else {
                    // Se showChords è false o non ci sono accordi, pulisci la riga
                    const cleanLine = l.replace(/\[.*?\]/g, ''); 
                    doc.setFont(undefined, 'normal'); doc.setTextColor(0);
                    const splitText = doc.splitTextToSize(cleanLine, COL_WIDTH);
                    doc.text(splitText, lineX, currentY);
                    currentY += (splitText.length * 5);
                }
            }
            currentY += 8; 
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

    if (autoScrollInterval) { // Usa la variabile globale definita a inizio file
        clearInterval(autoScrollInterval);
        autoScrollInterval = null;
        isUserInteracting = false;
        
        if(btn) {
            btn.classList.replace('btn-success', 'btn-outline-success');
            btn.innerHTML = '<i class="bi bi-mouse3"></i>';
        }

        area.removeEventListener('mousedown', setInteractingTrue);
        area.removeEventListener('mouseup', setInteractingFalse);
        area.removeEventListener('touchstart', setInteractingTrue);
        area.removeEventListener('touchend', setInteractingFalse);
    } else {
        if (area.scrollHeight <= area.clientHeight) {
            window.showToast("Testo troppo breve", "warning");
            return;
        }

        if(btn) {
            btn.classList.replace('btn-outline-success', 'btn-success');
            btn.innerHTML = '<i class="bi bi-pause-fill"></i>';
        }

        area.addEventListener('mousedown', setInteractingTrue);
        area.addEventListener('mouseup', setInteractingFalse);
        area.addEventListener('touchstart', setInteractingTrue, {passive: true});
        area.addEventListener('touchend', setInteractingFalse);

        autoScrollInterval = setInterval(() => {
            if (isUserInteracting) return;
            if (Math.ceil(area.scrollTop + area.clientHeight) >= area.scrollHeight - 1) {
                window.toggleAutoScroll(); 
                return;
            }
            area.scrollTop += 1; 
        }, 50); 
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
window.exportSingleLatex = () => { showToast("LaTeX Canzone in arrivo...", "warning"); };

/* ==========================================
   LOGICA GESTIONE SEZIONI (FIX LISTA VUOTA)
   ========================================== */

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
    // (Prima per Ordine numerico, poi Alfabetico per risolvere i pari merito)
    allSections.sort((a, b) => {
        const orderA = (a.order !== undefined && a.order !== null) ? a.order : 9999;
        const orderB = (b.order !== undefined && b.order !== null) ? b.order : 9999;
        
        // Se l'ordine è diverso, usa quello
        if (orderA !== orderB) {
            return orderA - orderB;
        }
        // Se l'ordine è uguale (es. entrambi 9999), usa il nome per stabilità
        return a.name.localeCompare(b.name);
    });

    // 2. Trova l'indice dell'elemento che vogliamo spostare
    const idx = allSections.findIndex(s => s.id === sectionId);
    if (idx === -1) return; // Errore: ID non trovato

    // 3. Calcola il nuovo indice
    const newIdx = idx + direction;

    // 4. Controllo limiti (non possiamo andare sopra la lista o sotto zero)
    if (newIdx < 0 || newIdx >= allSections.length) return;

    // 5. SCAMBIO FISICO DEGLI ELEMENTI NELL'ARRAY
    // Usiamo lo splice per essere sicuri di spostare l'oggetto intero
    const itemToMove = allSections[idx];
    const itemTarget = allSections[newIdx];
    
    // Scambio posizioni
    allSections[idx] = itemTarget;
    allSections[newIdx] = itemToMove;

    // 6. NORMALIZZAZIONE: Riassegna i numeri 0, 1, 2, 3... a TUTTI
    // Questo è il passaggio fondamentale che ripara gli ordini "rotti"
    allSections.forEach((sec, i) => {
        sec.order = i;
    });

    // Aggiorna anche la lista nomi globale usata per l'export
    sectionOrder = allSections.map(s => s.name);

    // 7. AGGIORNA L'INTERFACCIA UTENTE (UI) IMMEDIATAMENTE
    // Capisce in quale schermata sei e aggiorna solo quella
    if (document.getElementById('view-export').classList.contains('active')) {
        (); // Ridisegna lista export
    } else {
        window.renderManageSections(); // Ridisegna lista gestione
    }

    // 8. SALVA SU DATABASE IN BACKGROUND (Batch write)
    // Non blocchiamo l'utente con un loading, salviamo "silenziosamente"
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
    
    // 1. Crea una COPIA locale dell'array sezioni, ordinata come il default attuale
    // Usiamo lo spread operator [...] per rompere il riferimento all'array originale
    exportSectionOrder = [...allSections].sort((a, b) => {
        const orderA = (a.order !== undefined && a.order !== null) ? a.order : 9999;
        const orderB = (b.order !== undefined && b.order !== null) ? b.order : 9999;
        if (orderA !== orderB) return orderA - orderB;
        return a.name.localeCompare(b.name);
    });

    // 2. Renderizza la lista visuale basata su questa copia locale
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
    // Resetta i campi
    document.getElementById("propTitle").value = "";
    document.getElementById("propAuthor").value = "";
    document.getElementById("propLyrics").value = "";
    document.getElementById("propYear").value = "";
    document.getElementById("propDesc").value = "";
    document.getElementById("propUser").value = ""; // O lascia salvato se vuoi
    document.getElementById("propPreviewArea").innerHTML = "";

    // Popola le sezioni
    const sel = document.getElementById("propCategory");
    sel.innerHTML = "";
    allSections.forEach(sec => {
        sel.innerHTML += `<option value="${sec.name}">${sec.name}</option>`;
    });

    // Switch view
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
    const p = allProposals.find(x => x.id === id);
    if (!p) return;

    // Popola i campi input
    document.getElementById("reviewTitle").value = p.title || "";
    document.getElementById("reviewAuthor").value = p.author || "";
    document.getElementById("reviewYear").value = p.year || "";
    document.getElementById("reviewDesc").value = p.description || "";
    document.getElementById("reviewProposer").value = p.proposer || "";
    document.getElementById("reviewLyrics").value = p.lyrics || "";

    // Popola la select delle categorie (Sezioni)
    const sel = document.getElementById("reviewCategory");
    sel.innerHTML = "";
    allSections.forEach(sec => {
        const opt = document.createElement("option");
        opt.value = sec.name;
        opt.innerText = sec.name;
        if (sec.name === p.category) opt.selected = true;
        sel.appendChild(opt);
    });

    // Renderizza l'anteprima iniziale
    window.renderReviewPreview();
    
    // Mostra il modale
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
    if (!t) return showToast("Il titolo è obbligatorio", "warning");

    // Dati presi dall'editor (potenzialmente modificati dall'admin)
    const finalData = {
        title: t,
        author: document.getElementById("reviewAuthor").value.trim(),
        category: document.getElementById("reviewCategory").value,
        year: document.getElementById("reviewYear").value,
        description: document.getElementById("reviewDesc").value.trim(),
        lyrics: document.getElementById("reviewLyrics").value,
        // Rigenera l'array degli accordi basandosi sul testo MODIFICATO
        chords: window.extractChords(document.getElementById("reviewLyrics").value),
        added: true,
        createdAt: Date.now()
    };

    document.getElementById("loadingOverlay").style.display = "flex";
    mReviewProposal.hide();

    try {
        // Aggiungi alla raccolta "songs"
        const r = await addDoc(collection(db, "songs"), finalData);
        allSongs.push({ id: r.id, ...finalData });

        // Cancella dalla raccolta "proposals"
        await deleteDoc(doc(db, "proposals", currentReviewId));
        
        // Aggiorna lista locale
        allProposals = allProposals.filter(p => p.id !== currentReviewId);
        
        showToast("Proposta approvata e pubblicata!", "success");
        
        // Ricarica la vista proposte
        window.openProposalsView();
        window.loadData(); // Ricarica tutto per sicurezza
        
    } catch (e) {
        console.error(e);
        showToast("Errore durante l'approvazione: " + e.message, "danger");
        // Se fallisce, riapri il modale per non perdere le modifiche
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
        // NOTA: Qui passiamo l'indice (idx) array, non l'ID, perché lavoriamo su una lista locale
        list.innerHTML += `
        <div class="d-flex justify-content-between align-items-center bg-secondary bg-opacity-25 p-2 mb-1 rounded">
            <span class="text-white small fw-bold">${sec.name}</span>
            <div>
                <button class="btn btn-sm btn-link text-white py-0" onclick="window.moveExportSection(${idx}, -1)">⬆</button>
                <button class="btn btn-sm btn-link text-white py-0" onclick="window.moveExportSection(${idx}, 1)">⬇</button>
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


