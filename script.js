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

// Loader
const loaderPhrases = [
    "Allineo gli astri...",
    "Accordo la chitarra...",
    "Scaldo le corde vocali...",
    "Cerco il Nord...",
    "Preparo il fuoco...",
    "Consulto la mappa..."
];
let loaderInterval;

// Modals
let mLogin, mAddSong, mAddSection, mEditSection, mEditSongMeta, mConfirm, mExport, mSearchSetlist, mExportSetlist, mAddToSetlist;

window.addEventListener('load', () => {
    startLoaderAnimation();
    manageDynamicBackgrounds();
    
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
});

function startLoaderAnimation() {
    const textEl = document.getElementById('loaderText');
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
      if (err.code == 'failed-precondition') console.warn("Persistenza fallita: Più tab aperti.");
      else if (err.code == 'unimplemented') console.warn("Browser non supportato.");
  })
  .finally(() => {
      setPersistence(auth, inMemoryPersistence)
        .then(() => console.log("Sessione In Memory"))
        .catch((error) => console.error("Errore auth:", error));

      onAuthStateChanged(auth, (user) => {
          isAdmin = !!user;
          document.body.classList.toggle('user-admin', isAdmin);
          
          const btnLogin = document.getElementById('btnLoginBtn');
          if(btnLogin) btnLogin.style.display = isAdmin ? 'none' : 'inline-block';
          
          const btnAddTxt = document.getElementById('btnAddText');
          const btnSubmit = document.getElementById('btnSubmitSong');
          const infoProp = document.getElementById('proposalInfo');
          const propField = document.getElementById('proposerField');
          const prevCol = document.getElementById('previewContainerCol');

          if (isAdmin) {
              if(btnAddTxt) btnAddTxt.innerText = 'Aggiungi';
              if(btnSubmit) btnSubmit.innerText = 'Crea Subito';
              if(infoProp) infoProp.style.display = 'none';
              if(propField) propField.style.display = 'none';
              if(prevCol) prevCol.className = "col-md-7";
              loadProposals();
          } else {
              if(btnAddTxt) btnAddTxt.innerText = 'Proponi';
              if(btnSubmit) btnSubmit.innerText = 'Invia Proposta';
              if(infoProp) infoProp.style.display = 'block';
              if(propField) propField.style.display = 'block';
              if(prevCol) prevCol.className = "col-md-12";
          }
          loadData();
      });
  });

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

        allSections.sort((a,b) => a.name.localeCompare(b.name));
        sectionOrder = allSections.map(s => s.name); 
        
        if(document.getElementById('view-setlists').classList.contains('active')) {
            window.renderSetlistsList();
            if(currentSetlistId) window.renderActiveSetlistSongs();
        } else if(!currentCategory) {
            window.renderDashboard(); 
        } else {
            openList(currentCategory); 
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
    const b=document.getElementById('proposalsBadge');
    if(allProposals.length>0){b.innerText=allProposals.length;b.style.display='inline-block';}else{b.style.display='none';}
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
        const btnEdit=`<div class="cat-actions"><button class="btn btn-light btn-sm rounded-circle shadow-sm" onclick="window.openSectionSettings('${sec.id}','${sec.name}','${sec.coverUrl||''}',event)"><i class="bi bi-gear-fill text-secondary"></i></button></div>`;
        c.innerHTML+=`<div class="col-md-4 col-sm-6"><div class="category-card shadow-sm">${isAdmin?btnEdit:''}<div class="cat-cover" style="${bg}" onclick="window.openList('${sec.name}')">${ico}</div><div class="p-3 text-center" onclick="window.openList('${sec.name}')"><h5 class="fw-bold mb-1 text-truncate">${sec.name}</h5><small class="text-muted">${count} canzoni</small></div></div></div>`;
    });
};

window.performGlobalSearch = () => {
    const q=document.getElementById('globalSearch').value.toLowerCase();
    if(!q) { window.renderDashboard(); return; }
    const res=allSongs.filter(s=>s.title.toLowerCase().includes(q) || (s.author&&s.author.toLowerCase().includes(q)));
    document.getElementById("favoritesSection").style.display='none';
    document.getElementById("categoriesContainer").innerHTML = res.length ? res.map(s => {
        let badgesHtml = "";
        if (isAdmin) {
            const hasChords = s.lyrics && s.lyrics.includes("[");
            const hasLyrics = s.lyrics && s.lyrics.trim().length > 10;
            if (hasChords) badgesHtml = `<span class="admin-badge badge-accordi">A</span>`;
            else if (hasLyrics) badgesHtml = `<span class="admin-badge badge-testo">T</span>`;
        }
        return `<div class="col-12"><div class="card shadow-sm border-0" onclick="window.openEditor('${s.id}')" style="cursor:pointer">
            <div class="card-body d-flex justify-content-between align-items-center">
                <div>
                    <h6 class="fw-bold mb-0">${s.title} ${badgesHtml}</h6>
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
        let badgesHtml = "";
        if (isAdmin) {
            const hasLyrics = s.lyrics && s.lyrics.trim().length > 10;
            const hasChords = s.lyrics && s.lyrics.includes("[");
            
            if (hasChords) {
                badgesHtml = `<span class="admin-badge badge-accordi" title="Testo e Accordi">A</span>`;
            } else if (hasLyrics) {
                badgesHtml = `<span class="admin-badge badge-testo" title="Solo Testo">T</span>`;
            }
        }

        c.innerHTML += `
            <button class="list-group-item list-group-item-action p-3 border-0 mb-1 rounded shadow-sm" onclick="window.openEditor('${s.id}')">
                <div class="d-flex w-100 justify-content-between align-items-center">
                    <div>
                        <h6 class="mb-1 fw-bold">${s.title} ${badgesHtml}</h6>
                    </div>
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
    
    editor.oninput = () => {
        hasUnsavedChanges = true;
        window.renderPreview();
    };

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
    const t = document.getElementById("newSongTitle").value;
    const a = document.getElementById("newSongAuthor").value; 
    const c = document.getElementById("newSongCategorySelect").value; 
    const l = document.getElementById("newSongLyrics").value; 
    const p = document.getElementById("newSongProposer").value;
    const d = document.getElementById("newSongDescription").value;
    const y = document.getElementById("newSongYear").value;

    if(!t||!c) return showToast("Titolo e Sezione obbligatori", 'warning');
    if(!isAdmin && !p) return showToast("Il tuo nome è obbligatorio", 'warning'); 

    if (checkTitleDuplicate(t)) {
        return showToast(`Esiste già una canzone intitolata "${t}"!`, 'danger');
    }

    const songData = {
        title:t, author:a, category:c, lyrics:l, description:d, year:y, 
        chords:window.extractChords(l)
    };
    
    document.getElementById("loadingOverlay").style.display = "flex"; 

    try {
        if(isAdmin){ 
            const r = await addDoc(collection(db,"songs"), {...songData, added:true}); 
            const newSongLocal = { id: r.id, ...songData, added: true };
            allSongs.push(newSongLocal);
            mAddSong.hide(); 
            showToast("Creata!", 'success'); 
            window.openEditor(r.id); 
        } else { 
            await addDoc(collection(db,"proposals"), {...songData, proposer:p}); 
            mAddSong.hide(); 
            showToast("Proposta inviata!", 'success'); 
        }
    } catch(e) {
        console.error(e);
        showToast("Errore creazione: " + e.message, 'danger');
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

window.moveSection = (idx, dir) => {
    if (idx+dir < 0 || idx+dir >= sectionOrder.length) return;
    const temp = sectionOrder[idx]; sectionOrder[idx] = sectionOrder[idx+dir]; sectionOrder[idx+dir] = temp;
    const list = document.getElementById("sectionOrderList"); list.innerHTML = "";
    sectionOrder.forEach((name, i) => {
        list.innerHTML += `<div class="order-list-item"><span>${name}</span><div><button class="btn btn-sm btn-outline-secondary me-1" onclick="window.moveSection(${i},-1)">⬆</button><button class="btn btn-sm btn-outline-secondary" onclick="window.moveSection(${i},1)">⬇</button></div></div>`;
    });
};

window.generateFullPDF = async () => {
    const showChords = document.getElementById("pdfShowChords").checked;
    document.getElementById("loadingOverlay").style.display="flex";
    const { jsPDF } = window.jspdf;
    
    const isTwoColumns = document.getElementById("pdfTwoColumns").checked;

    const doc = new jsPDF({ format: 'a4', orientation: 'portrait', unit: 'mm' });
    const PAGE_WIDTH = 210;
    const PAGE_HEIGHT = 297;
    const MARGIN_TOP = 20;
    const MARGIN_BOTTOM = 280;
    const SIDE_MARGIN = 15;
    const GUTTER = 10;

    const COL_WIDTH = isTwoColumns ? (PAGE_WIDTH - (SIDE_MARGIN * 2) - GUTTER) / 2 : (PAGE_WIDTH - (SIDE_MARGIN * 2));
    const COL_1_X = SIDE_MARGIN;
    const COL_2_X = isTwoColumns ? (SIDE_MARGIN + COL_WIDTH + GUTTER) : SIDE_MARGIN;

    let currentX = COL_1_X;
    let currentY = MARGIN_TOP;
    let currentCol = 1;
    let pageNum = 1;

    const checkLimit = (heightNeeded) => {
        if (currentY + heightNeeded > MARGIN_BOTTOM) {
            if (isTwoColumns && currentCol === 1) {
                currentCol = 2;
                currentX = COL_2_X;
                currentY = MARGIN_TOP;
            } else {
                doc.addPage();
                pageNum++;
                currentCol = 1;
                currentX = COL_1_X;
                currentY = MARGIN_TOP;
                doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(150);
                doc.text(String(pageNum), PAGE_WIDTH/2, 290, {align:'center'});
            }
            return true;
        }
        return false;
    };

    const coverInput = document.getElementById("globalCoverInput").files[0];
    if (coverInput) {
        const coverBase64 = await fileToBase64(coverInput);
        doc.addImage(coverBase64, 'JPEG', 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
        doc.addPage(); pageNum++;
    } else {
        doc.setFillColor(0, 51, 102); 
        doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold"); doc.setFontSize(40);
        doc.text("CANZONIERE", PAGE_WIDTH/2, 120, {align: 'center'});
        doc.setFontSize(20);
        doc.text("SCOUT", PAGE_WIDTH/2, 135, {align: 'center'});
        doc.addPage(); pageNum++;
    }

    for (const secName of sectionOrder) {
        const songs = allSongs.filter(s => s.category === secName).sort((a,b)=>a.title.localeCompare(b.title));
        if (songs.length === 0) continue;

        doc.addPage(); pageNum++;
        tocData.push({ type: 'section', text: secName.toUpperCase(), page: pageNum });
        currentCol = 1; currentX = COL_1_X; currentY = MARGIN_TOP;
        
        doc.setTextColor(0, 51, 102); doc.setFont("helvetica", "bold"); doc.setFontSize(30);
        doc.text(secName.toUpperCase(), PAGE_WIDTH/2, 100, {align: 'center'});
        
        doc.addPage(); pageNum++;
        currentCol = 1; currentX = COL_1_X; currentY = MARGIN_TOP;
        doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(150);
        doc.text(String(pageNum), PAGE_WIDTH/2, 290, {align:'center'});

        for (const s of songs) {
            tocData.push({ type: 'song', text: s.title, subtext: s.author, page: pageNum });

            checkLimit(25);

            doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(0, 51, 102);
            const titleLines = doc.splitTextToSize(s.title.toUpperCase(), COL_WIDTH);
            doc.text(titleLines, currentX, currentY);
            currentY += (titleLines.length * 5);

            if(s.author) {
                doc.setFont("helvetica", "italic"); doc.setFontSize(9); doc.setTextColor(100);
                const authTxt = s.year ? `${s.author} (${s.year})` : s.author;
                doc.text(authTxt, currentX + COL_WIDTH, currentY - 5, {align: 'right'}); 
            }

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
                currentY += 2; 
            }

            doc.setDrawColor(200); doc.setLineWidth(0.2);
            doc.line(currentX, currentY - 2, currentX + COL_WIDTH, currentY - 2);
            
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

    doc.addPage();
    doc.setTextColor(0, 51, 102); doc.setFont("helvetica", "bold"); doc.setFontSize(22);
    doc.text("INDICE", PAGE_WIDTH/2, 20, {align: 'center'});
    
    let tocY = 40;
    let tocCol = 1; 
    const TOC_COL_WIDTH = 80;
    const TOC_COL_1_X = 20;
    const TOC_COL_2_X = 115;
    
    tocData.forEach(item => {
        if(tocY > 270) {
             if(tocCol === 1) { tocCol = 2; tocY = 40; }
             else { doc.addPage(); tocCol = 1; tocY = 40; }
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

    doc.save("Canzoniere_Completo.pdf");
    document.getElementById("loadingOverlay").style.display="none"; 
    mExport.hide();
};

window.generateFullLatex=()=>{if(!isAdmin)return;let l=`\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[a5paper]{geometry}\n\\usepackage{songs}\n\\begin{document}\n\\title{Canzoniere}\\maketitle\\tableofcontents\\newpage\n`;sectionOrder.forEach(secName=>{l+=`\\section{${secName}}\n`;allSongs.filter(s=>s.category===secName).sort((a,b)=>a.title.localeCompare(b.title)).forEach(s=>{l+=`\\beginsong{${s.title}}[by={${s.author||''}}]\n\\beginverse\n`;(s.lyrics||"").split("\n").forEach(line=>{l+=line.replace(/\[(.*?)\]/g,(m,p1)=>`\\[${normalizeChord(p1)}]`)+"\n";});l+=`\\endverse\n\\endsong\n`;});});l+=`\\end{document}`;const b=new Blob([l],{type:'text/plain'});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="Canzoniere.tex";a.click();};

// UTILS & EXTRAS
const fileToBase64 = file => new Promise((resolve, reject) => { const r = new FileReader(); r.readAsDataURL(file); r.onload = () => resolve(r.result); r.onerror = error => reject(error); });

window.openLoginModal=()=>mLogin.show();

function manageDynamicBackgrounds() {
    const bg = document.getElementById('dynamic-background');
    if(bg) bg.style.display = 'block';
    
    const container = document.getElementById('night-stars-container');
    if (container && container.innerHTML === "") {
        for (let i = 0; i < 100; i++) {
            const s = document.createElement('div');
            s.className = 'bg-star';
            s.style.left = Math.random() * 100 + '%';
            s.style.top = Math.random() * 100 + '%';
            const size = Math.random() * 2; 
            s.style.width = size + 'px'; s.style.height = size + 'px';
            s.style.animationDelay = (Math.random() * 5) + 's';
            s.style.opacity = Math.random();
            container.appendChild(s);
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
        
        const cleanSearch = () => {
            const searchBar = document.getElementById('globalSearch');
            if(searchBar) { searchBar.value = ""; searchBar.blur(); }
        };
        setTimeout(cleanSearch, 100);
        setTimeout(cleanSearch, 500);

        emailField.value = "";
        passField.value = "";
        showToast("Benvenuto!", 'success');
    } catch (e) {
        console.error(e);
        showToast("Errore login: controlla credenziali", 'danger');
    }
};

window.logout=async()=>{await signOut(auth);window.location.reload();};
window.showAddSectionModal=()=>{document.getElementById("newSectionName").value="";mAddSection.show();};
window.createNewSection = async () => {
    const n = document.getElementById("newSectionName").value.trim();
    if (!n) return;
    if (document.activeElement) document.activeElement.blur();
    await addDoc(collection(db, "sections"), { name: n, coverUrl: "" });
    mAddSection.hide();
    showToast("Sezione creata");
    loadData();
};
window.openSectionSettings=(id,name,url,e)=>{e.stopPropagation();editingSectionId=id;currentCategory=name;currentCoverUrl=url;document.getElementById("editSectionNameInput").value=name;document.getElementById("coverFileInput").value="";const img=document.getElementById("coverPreviewImg");img.src=url||"";img.style.display=url?'block':'none';mEditSection.show();};
window.previewCoverFile = () => {
    const fileInput = document.getElementById("coverFileInput");
    const f = fileInput.files[0];
    if (f) {
        const r = new FileReader();
        r.onload = e => {
            const img = document.getElementById("coverPreviewImg");
            img.src = e.target.result;
            img.style.display = 'block';
            fileInput.focus(); 
        };
        r.readAsDataURL(f);
    }
};
window.saveSectionSettings=async()=>{const n=document.getElementById("editSectionNameInput").value;const f=document.getElementById("coverFileInput").files[0];document.getElementById("loadingOverlay").style.display="flex";try{let u=currentCoverUrl;if(f)u=await fileToBase64(f);if(n!==currentCategory){const b=writeBatch(db);b.update(doc(db,"sections",editingSectionId),{name:n,coverUrl:u});allSongs.filter(s=>s.category===currentCategory).forEach(s=>b.update(doc(db,"songs",s.id),{category:n}));await b.commit();}else{await updateDoc(doc(db,"sections",editingSectionId),{coverUrl:u});}mEditSection.hide();showToast("Salvato");loadData();}catch(e){showToast(e.message,'danger');}finally{document.getElementById("loadingOverlay").style.display="none";}};
window.triggerDeleteSection = () => window.confirmModal("Eliminare sezione e tutte le sue canzoni?", async () => {
    try {
        document.getElementById("loadingOverlay").style.display = "flex"; 
        await deleteDoc(doc(db, "sections", editingSectionId));
        const b = writeBatch(db);
        const songsToDelete = allSongs.filter(s => s.category === currentCategory);
        songsToDelete.forEach(s => b.delete(doc(db, "songs", s.id)));
        await b.commit();
        mEditSection.hide();
        currentCategory = null; 
        window.goHome(); 
        await loadData();
        showToast("Sezione eliminata correttamante");
    } catch(e) {
        showToast("Errore: " + e.message, 'danger');
    } finally {
        document.getElementById("loadingOverlay").style.display = "none";
        if(loaderInterval) clearInterval(loaderInterval);
    }
});
window.showAddModal=()=>{const s=document.getElementById("newSongCategorySelect");s.innerHTML="";allSections.forEach(sec=>s.innerHTML+=`<option value="${sec.name}">${sec.name}</option>`);document.getElementById("newSongTitle").value="";document.getElementById("newSongAuthor").value="";document.getElementById("newSongLyrics").value="";mAddSong.show();};
window.saveSong = async () => {
    const t = document.getElementById("lyricsEditor").value;
    try {
        await updateDoc(doc(db,"songs",currentSongId), {
            lyrics: t,
            chords: window.extractChords(t)
        });
        const s = allSongs.find(x => x.id === currentSongId);
        if(s) {
            s.lyrics = t;
            s.chords = window.extractChords(t);
        }
        hasUnsavedChanges = false; 
        showToast("Salvato con successo!", 'success');
    } catch(e) {
        console.error(e);
        showToast("Errore salvataggio: " + e.message, 'danger');
    }
};
window.deleteCurrentSong = () => window.confirmModal('Eliminare definitivamente?', async () => {
    try {
        await deleteDoc(doc(db,"songs",currentSongId));
        allSongs = allSongs.filter(s => s.id !== currentSongId);
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
window.openSongMetadataModal = () => {
    const s = allSongs.find(x => x.id === currentSongId);
    if (!s) return;

    document.getElementById("editSongTitleInput").value = s.title;
    document.getElementById("editSongAuthorInput").value = s.author;
    document.getElementById("editSongYearInput").value = s.year || "";
    document.getElementById("editSongDescInput").value = s.description || "";

    const catSelect = document.getElementById("editSongCategorySelect");
    catSelect.innerHTML = "";
    allSections.forEach(sec => {
        const opt = document.createElement("option");
        opt.value = sec.name;
        opt.innerText = sec.name;
        if (sec.name === s.category) opt.selected = true;
        catSelect.appendChild(opt);
    });
    mEditSongMeta.show();
};

window.saveSongMetadata = async () => {
    const t = document.getElementById("editSongTitleInput").value;
    const a = document.getElementById("editSongAuthorInput").value;
    const y = document.getElementById("editSongYearInput").value;
    const d = document.getElementById("editSongDescInput").value;
    const newCategory = document.getElementById("editSongCategorySelect").value;

    if (!t) return showToast("Il titolo non può essere vuoto", "warning");
    
    if (checkTitleDuplicate(t, currentSongId)) {
        return showToast(`Attenzione: esiste già "${t}"`, 'danger');
    }

    document.getElementById("loadingOverlay").style.display = "flex";

    try {
        await updateDoc(doc(db, "songs", currentSongId), {
            title: t, author: a, year: y, description: d, category: newCategory
        });
        const s = allSongs.find(x => x.id === currentSongId);
        if(s) {
            s.title = t; s.author = a; s.year = y; s.description = d; s.category = newCategory;
        }
        mEditSongMeta.hide();
        document.getElementById("editorTitle").innerText = t;
        document.getElementById("editorAuthor").innerText = a;
        let metaText = []; if(d) metaText.push(d); if(y) metaText.push(`(${y})`);
        document.getElementById("editorMeta").innerText = metaText.join(" - ");
        showToast("Dati aggiornati", "success");
    } catch (e) {
        console.error(e);
        showToast("Errore salvataggio: " + e.message, "danger");
    } finally {
        document.getElementById("loadingOverlay").style.display = "none";
    }
};
window.openProposalsView=()=>{window.switchView('view-proposals');const c=document.getElementById("proposalsContainer");c.innerHTML="";if(allProposals.length===0)c.innerHTML="<div class='text-center mt-5 text-muted'>Nessuna proposta.</div>";allProposals.forEach(p=>{c.innerHTML+=`<div class="card mb-3 shadow-sm"><div class="card-body d-flex justify-content-between"><div><h5 class="fw-bold mb-1">${p.title}</h5><small class="text-muted">${p.author} &bull; ${p.category} (da: ${p.proposer||'Anon'})</small></div><div class="d-flex gap-2"><button class="btn btn-success btn-sm" onclick="window.acceptProposal('${p.id}')"><i class="bi bi-check-lg"></i></button><button class="btn btn-danger btn-sm" onclick="window.rejectProposal('${p.id}')"><i class="bi bi-x-lg"></i></button></div></div></div>`});};
window.acceptProposal=(id)=>window.confirmModal("Approvare?",async()=>{const p=allProposals.find(x=>x.id===id);await addDoc(collection(db,"songs"),{title:p.title,author:p.author,category:p.category,lyrics:p.lyrics,chords:window.extractChords(p.lyrics)});await deleteDoc(doc(db,"proposals",id));showToast("Approvata!",'success');await loadProposals();loadData();window.openProposalsView();});
window.rejectProposal=(id)=>window.confirmModal("Rifiutare?",async()=>{await deleteDoc(doc(db,"proposals",id));await loadProposals();window.openProposalsView();});
window.showToast=(m,t='info')=>{const el=document.createElement('div');el.className=`toast align-items-center text-white bg-${t} border-0`;el.innerHTML=`<div class="d-flex"><div class="toast-body">${m}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;document.getElementById('toastContainer').appendChild(el);new bootstrap.Toast(el).show();};
window.confirmModal=(m,c)=>{document.getElementById('confirmMessage').innerText=m;document.getElementById('confirmBtnAction').onclick=()=>{c();mConfirm.hide();};mConfirm.show();};
window.switchView=(id)=>{document.querySelectorAll('.view-screen').forEach(el=>el.classList.remove('active'));document.getElementById(id).classList.add('active');window.scrollTo(0,0);};
window.goHome = () => {
    currentCategory = null;
    currentSongId = null;
    const searchInput = document.getElementById('globalSearch');
    if(searchInput) searchInput.value = "";
    window.renderDashboard();
};
window.goBackToList = () => {
    if (hasUnsavedChanges) {
        if(!confirm("Hai modifiche non salvate al testo. Vuoi uscire comunque?")) return; 
        hasUnsavedChanges = false; 
    }

    if (currentSetlistId) {
        switchView('view-setlists');
        document.getElementById('setlistsContainer').innerHTML = ""; 
        document.getElementById('activeSetlistDetail').style.display = 'block'; 
        window.renderActiveSetlistSongs();
    } 
    else if (currentCategory) {
        window.openList(currentCategory);
    } 
    else {
        window.goHome();
    }
};
window.handleSetlistBack = () => {
    const detail = document.getElementById('activeSetlistDetail');
    if (detail.style.display === 'block') {
        detail.style.display = 'none';
        currentSetlistId = null; 
        window.renderSetlistsList(); 
    } else {
        window.goHome();
    }
};
window.changeTone=(d)=>{currentTranspose+=d;document.getElementById("toneDisplay").innerText=currentTranspose;window.renderPreview();};
window.adjustFontSize=(d)=>{currentFontSize+=d;window.renderPreview();};
window.toggleChords=()=>document.getElementById('previewArea').classList.toggle('hide-chords');

window.toggleFavorite=()=>{if(favorites.includes(currentSongId))favorites=favorites.filter(id=>id!==currentSongId);else{favorites.push(currentSongId);showToast("Aggiunta ai preferiti",'success');}localStorage.setItem('scoutFavorites',JSON.stringify(favorites));updateFavIcon();};
function updateFavIcon(){document.getElementById('favIcon').className=favorites.includes(currentSongId)?"bi bi-star-fill":"bi bi-star";}
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
window.exportSingleLatex=()=>{if(!isAdmin)return;const s=allSongs.find(x=>x.id===currentSongId);let c=`\\beginsong{${s.title}}[by={${s.author}}]\n\\beginverse\n`;document.getElementById("lyricsEditor").value.split("\n").forEach(l=>{c+=l.replace(/\[(.*?)\]/g,(m,p1)=>`\\[${transposeChord(normalizeChord(p1),currentTranspose)}]`)+"\n";});c+=`\\endverse\n\\endsong\n`;downloadFile(s.title+".tex",c);};
function downloadFile(n, c) { const b = new Blob([c], {type:'text/plain'}); const a = document.createElement("a"); a.href=URL.createObjectURL(b); a.download=n; a.click(); }
window.processTxtImport = () => {
    const fileInput = document.getElementById("txtImporter");
    const file = fileInput.files[0];
    if (!file) return;

    if (!confirm("Attenzione: Questo importerà tutte le canzoni dal file TXT. Assicurati di essere Admin. Continuare?")) {
        fileInput.value = ""; 
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        const text = e.target.result;
        const lines = text.split('\n');
        document.getElementById("loadingOverlay").style.display = "flex";

        const batch = writeBatch(db);
        let operationCount = 0;
        let currentSectionName = "Generale"; 
        const processedSections = new Set(allSections.map(s => s.name));

        try {
            for (let line of lines) {
                line = line.trim();
                if (!line) continue;
                if (line.includes("SEZIONE:")) {
                    const parts = line.split("SEZIONE:");
                    if (parts.length > 1) {
                        let secName = parts[1].replace(/=/g, '').trim();
                        secName = secName.charAt(0).toUpperCase() + secName.slice(1).toLowerCase(); 
                        currentSectionName = secName;

                        if (!processedSections.has(currentSectionName)) {
                            const newSecRef = doc(collection(db, "sections"));
                            batch.set(newSecRef, { name: currentSectionName, coverUrl: "" });
                            processedSections.add(currentSectionName);
                            operationCount++;
                        }
                    }
                    continue;
                }
                const songMatch = line.match(/^(\d+)\.\s+(.*)/);
                if (songMatch) {
                    let rawContent = songMatch[2]; 
                    let title = rawContent;
                    let author = "";
                    if (rawContent.includes("- Autore:")) {
                        const split = rawContent.split("- Autore:");
                        title = split[0].trim();
                        author = split[1].trim();
                    }
                    const newSongRef = doc(collection(db, "songs"));
                    batch.set(newSongRef, {
                        title: title,
                        author: author,
                        category: currentSectionName, 
                        lyrics: "", 
                        chords: [],
                        added: true,
                        year: "", 
                        description: "" 
                    });
                    operationCount++;
                }
                if (operationCount >= 450) {
                    await batch.commit();
                    operationCount = 0; 
                }
            }
            if (operationCount > 0) {
                await batch.commit();
            }
            showToast("Importazione completata!", "success");
            loadData(); 
        } catch (error) {
            console.error(error);
            showToast("Errore importazione: " + error.message, "danger");
        } finally {
            document.getElementById("loadingOverlay").style.display = "none";
            fileInput.value = "";
        }
    };
    reader.readAsText(file);
};
window.generateFullTxtList = () => {
    if(!isAdmin) return;
    
    let content = "LISTA CANZONIERE SCOUT\nGenerato il: " + new Date().toLocaleDateString() + "\n\n";
    sectionOrder.forEach(secName => {
        const songs = allSongs.filter(s => s.category === secName).sort((a,b)=>a.title.localeCompare(b.title));
        
        if (songs.length > 0) {
            content += "========================================\n";
            content += `SEZIONE: ${secName.toUpperCase()}\n`;
            content += "========================================\n";
            
            songs.forEach((s, index) => {
                let line = `${index + 1}. ${s.title}`;
                if (s.author) line += ` - ${s.author}`;
                if (s.year) line += ` (${s.year})`;
                if (s.description) line += ` [Note: ${s.description}]`;
                
                content += line + "\n";
            });
            content += "\n";
        }
    });

    downloadFile("Lista_Canzoniere.txt", content);
    mExport.hide();
};
const normalizeStr = (str) => str ? str.trim().toLowerCase() : "";
function checkTitleDuplicate(title, excludeId = null) {
    const cleanTitle = normalizeStr(title);
    return allSongs.some(s => {
        if (excludeId && s.id === excludeId) return false; 
        return normalizeStr(s.title) === cleanTitle;
    });
}
window.openSetlistsView = () => {
    switchView('view-setlists');
    window.renderSetlistsList();
    document.getElementById('activeSetlistDetail').style.display = 'none';
    currentSetlistId = null;
};
window.renderSetlistsList = () => {
    const c = document.getElementById("setlistsContainer");
    c.innerHTML = "";
    if (allSetlists.length === 0) {
        c.innerHTML = `<div class="text-center text-muted p-3">Nessuna scaletta pubblica presente. Creane una!</div>`;
        return;
    }
    allSetlists.forEach(sl => {
        c.innerHTML += `
            <button class="list-group-item list-group-item-action d-flex justify-content-between align-items-center" onclick="window.openSetlistDetail('${sl.id}')">
                <div class="fw-bold"><i class="bi bi-folder2-open me-2 text-warning"></i>${sl.name}</div>
                <span class="badge bg-secondary rounded-pill">${sl.songs.length}</span>
            </button>`;
    });
};
window.createNewSetlistPrompt = async () => {
    const name = prompt("Nome della nuova scaletta pubblica (es. 'Fuoco 2025'):");
    if (name) {
        try {
            document.getElementById("loadingOverlay").style.display = "flex";
            await addDoc(collection(db, "setlists"), {
                name: name,
                songs: [], 
                createdAt: Date.now()
            });
            await loadData(); 
            showToast("Scaletta creata e condivisa!");
        } catch(e) {
            showToast("Errore creazione: " + e.message, 'danger');
        } finally {
            document.getElementById("loadingOverlay").style.display = "none";
        }
    }
};
window.openSetlistDetail = (id) => {
    currentSetlistId = id;
    const sl = allSetlists.find(s => s.id === id);
    if (!sl) return;

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
        // Valore salvato nel DB
        const savedTrans = typeof item === 'object' ? (item.trans || 0) : 0;
        
        const song = allSongs.find(s => s.id === sId);
        if(!song) return; 

        // Genera lo snippet iniziale usando la tonalità salvata
        let snippetHtml = generateSnippetHtml(song.lyrics, savedTrans);

        c.innerHTML += `
            <div class="list-group-item p-3" id="setlist-item-${idx}">
                <div class="d-flex justify-content-between align-items-start">
                    <div class="text-truncate" style="cursor:pointer; flex-grow: 1;" onclick="document.getElementById('preview-box-${idx}').classList.toggle('d-none')">
                        <strong class="text-primary">${idx + 1}. ${song.title}</strong>
                        <div class="small text-muted">
                            ${song.author || ''} 
                            <span class="badge bg-light text-dark border ms-2" id="badge-trans-${idx}" data-val="${savedTrans}">Tono: ${savedTrans > 0 ? '+'+savedTrans : savedTrans}</span>
                        </div>
                    </div>
                    <div class="btn-group btn-group-sm ms-2">
                        <button class="btn btn-outline-secondary" onclick="window.moveSetlistSong(${idx}, -1)">⬆</button>
                        <button class="btn btn-outline-secondary" onclick="window.moveSetlistSong(${idx}, 1)">⬇</button>
                        <button class="btn btn-outline-danger" onclick="window.removeFromSetlist(${idx})"><i class="bi bi-trash"></i></button>
                    </div>
                </div>
                
                <div id="preview-box-${idx}" class="mt-2 p-3 bg-white rounded d-none border shadow-sm">
                    <div id="snippet-content-${idx}" class="mb-3" style="font-family: monospace; line-height: 1.8; white-space: pre-wrap; font-size: 0.95rem;">${snippetHtml}</div>
                    
                    <div class="d-flex align-items-center justify-content-between bg-light p-2 rounded">
                        <div class="d-flex align-items-center gap-2">
                            <span class="small fw-bold text-uppercase">Cambia:</span>
                            <button class="btn btn-sm btn-outline-primary fw-bold" style="width:30px" onclick="window.changeSetlistPreviewTone(${idx}, '${sId}', -1)">-</button>
                            <button class="btn btn-sm btn-outline-primary fw-bold" style="width:30px" onclick="window.changeSetlistPreviewTone(${idx}, '${sId}', 1)">+</button>
                            
                            <button class="btn btn-sm btn-success ms-2" onclick="window.saveSetlistSongTone(${idx})">
                                <i class="bi bi-check-lg"></i> Salva
                            </button>
                        </div>
                        <button class="btn btn-sm btn-outline-dark" onclick="window.openEditor('${sId}')">
                            Canzone Completa
                        </button>
                    </div>
                </div>
            </div>`;
    });
};
// 1. Modifica SOLO l'HTML (non ricarica la pagina, non chiude il box)
window.changeSetlistPreviewTone = (idx, songId, delta) => {
    const badge = document.getElementById(`badge-trans-${idx}`);
    const snippetDiv = document.getElementById(`snippet-content-${idx}`);
    
    // Recupera il valore attuale dal data-attribute
    let currentVal = parseInt(badge.getAttribute('data-val'));
    let newVal = currentVal + delta;
    
    // Aggiorna il badge visivo e il data-attribute
    badge.setAttribute('data-val', newVal);
    badge.innerText = `Tono: ${newVal > 0 ? '+' + newVal : newVal}`;
    // Evidenzia il badge per far capire che è cambiato ma non salvato
    badge.classList.remove('bg-light', 'text-dark');
    badge.classList.add('bg-warning', 'text-dark');

    // Ricalcola lo snippet al volo
    const song = allSongs.find(s => s.id === songId);
    if (song) {
        snippetDiv.innerHTML = generateSnippetHtml(song.lyrics, newVal);
    }
};

// 2. Salva effettivamente nel Database
window.saveSetlistSongTone = async (idx) => {
    const sl = allSetlists.find(s => s.id === currentSetlistId);
    if(!sl) return;

    // Recupera il valore "nuovo" che è visualizzato nel badge HTML
    const badge = document.getElementById(`badge-trans-${idx}`);
    const finalVal = parseInt(badge.getAttribute('data-val'));

    const newSongs = [...sl.songs];
    let item = newSongs[idx];
    
    // Assicurati che sia un oggetto
    if (typeof item === 'string') item = { id: item, trans: 0 };
    else item = { ...item };

    // Aggiorna il valore reale
    item.trans = finalVal;
    newSongs[idx] = item;

    // Aggiorna DB
    await updateDoc(doc(db, "setlists", currentSetlistId), {
        songs: newSongs
    });
    
    // Aggiorna array locale
    sl.songs = newSongs;

    // Feedback visivo: rimetti il badge normale e mostra un toast
    badge.classList.remove('bg-warning');
    badge.classList.add('bg-light');
    showToast("Tonalità salvata!", "success");
};
// Funzione helper per generare l'HTML dello snippet (usata sia all'inizio che al cambio tono)
function generateSnippetHtml(lyrics, transposeVal) {
    if (!lyrics) return "...";
    const lines = lyrics.split('\n').slice(0, 4); // Prime 4 righe
    return lines.map(line => {
        return line.replace(/\[(.*?)\]/g, (match, p1) => {
            const originalChord = normalizeChord(p1);
            const newChord = transposeChord(originalChord, transposeVal);
            return `<span style="color:#d63384; font-weight:bold; font-size:0.9em;">${newChord}</span>`;
        });
    }).join('<br>');
}
// Nuova funzione per cambiare il tono dentro la scaletta
window.updateSetlistSongTone = async (idx, delta) => {
    const sl = allSetlists.find(s => s.id === currentSetlistId);
    if(!sl) return;
    
    const newSongs = [...sl.songs];
    let item = newSongs[idx];
    
    // Converti in oggetto se è ancora stringa
    if (typeof item === 'string') item = { id: item, trans: 0 };
    else item = { ...item }; // Clona oggetto

    item.trans = (item.trans || 0) + delta;
    newSongs[idx] = item;
    
    await updateSetlistSongs(currentSetlistId, newSongs);
};
window.deleteActiveSetlist = () => window.confirmModal("Eliminare questa scaletta per tutti?", async () => {
    try {
        await deleteDoc(doc(db, "setlists", currentSetlistId));
        await loadData();
        window.openSetlistsView();
        showToast("Scaletta eliminata");
    } catch(e) {
        showToast("Errore eliminazione: " + e.message, "danger");
    }
});
async function updateSetlistSongs(setlistId, newSongsArray) {
    try {
        const localSl = allSetlists.find(s => s.id === setlistId);
        if(localSl) localSl.songs = newSongsArray;
        if(currentSetlistId === setlistId) window.renderActiveSetlistSongs();

        await updateDoc(doc(db, "setlists", setlistId), {
            songs: newSongsArray
        });
    } catch(e) {
        console.error(e);
        showToast("Errore sincronizzazione: " + e.message, "danger");
        await loadData(); 
    }
}
window.moveSetlistSong = (idx, dir) => {
    const sl = allSetlists.find(s => s.id === currentSetlistId);
    if (!sl) return;
    if (idx + dir < 0 || idx + dir >= sl.songs.length) return;
    const newSongs = [...sl.songs];
    const temp = newSongs[idx];
    newSongs[idx] = newSongs[idx + dir];
    newSongs[idx + dir] = temp;
    updateSetlistSongs(currentSetlistId, newSongs);
};
window.removeFromSetlist = (idx) => {
    const sl = allSetlists.find(s => s.id === currentSetlistId);
    if (!sl) return;
    const newSongs = [...sl.songs];
    newSongs.splice(idx, 1);
    updateSetlistSongs(currentSetlistId, newSongs);
};
window.openAddToSetlistModal = () => {
    const c = document.getElementById('setlistSelectorContainer');
    c.innerHTML = "";
    if (allSetlists.length === 0) {
        c.innerHTML = "<div class='small text-muted text-center'>Nessuna scaletta. Creane una nuova!</div>";
    } else {
        allSetlists.forEach(sl => {
            c.innerHTML += `<button class="list-group-item list-group-item-action py-2" onclick="window.addSongToSetlistId('${sl.id}')">${sl.name}</button>`;
        });
    }
    mAddToSetlist.show();
};
window.createNewSetlistFromModal = async () => {
    const name = prompt("Nome nuova scaletta:");
    if(name) {
        try {
            const docRef = await addDoc(collection(db, "setlists"), {
                name: name,
                songs: [],
                createdAt: Date.now()
            });
            await loadData();
            window.addSongToSetlistId(docRef.id);
        } catch(e) {
            showToast("Errore: " + e.message);
        }
    }
};
window.addSongToSetlistId = async (setId) => { 
    const sl = allSetlists.find(s => s.id === setId);
    if (sl) {
        // CORREZIONE: Controlla l'ID sia se item è stringa che se è oggetto
        const isPresent = sl.songs.some(item => {
            const id = typeof item === 'string' ? item : item.id;
            return id === currentSongId;
        });

        if (isPresent) {
            showToast(`Già presente in "${sl.name}"`, 'warning');
            return;
        }
        try {
            // Aggiungiamo la canzone come oggetto con trans: 0 di default
            const newSongEntry = { id: currentSongId, trans: 0 };
            await updateDoc(doc(db, "setlists", setId), {
                songs: arrayUnion(newSongEntry) 
            });
            sl.songs.push(newSongEntry);
            showToast(`Aggiunta a "${sl.name}"`, 'success');
            mAddToSetlist.hide();
        } catch (e) {
            showToast("Errore: " + e.message, 'danger');
        }
    }
};
window.openSetlistExportModal = () => {
    document.getElementById('setlistCoverInputModal').value = ""; 
    mExportSetlist.show();
};
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
window.openSearchForSetlistModal = () => {
    document.getElementById("searchSetlistInput").value = "";
    window.performSetlistSearch(); 
    mSearchSetlist.show();
};
window.performSetlistSearch = () => {
    const q = document.getElementById("searchSetlistInput").value.toLowerCase();
    const c = document.getElementById("searchSetlistResults");
    c.innerHTML = "";
    
    let res;
    if (q.trim() === "") {
        res = allSongs.sort((a,b) => a.title.localeCompare(b.title)); 
    } else {
        res = allSongs.filter(s => s.title.toLowerCase().includes(q) || (s.author && s.author.toLowerCase().includes(q)));
    }

    if(res.length === 0) {
        c.innerHTML = "<div class='text-center text-muted p-2'>Nessun risultato</div>";
        return;
    }

    const sl = allSetlists.find(x => x.id === currentSetlistId);
    
    res.forEach(s => {
        const isPresent = sl && sl.songs.some(item => (typeof item === 'string' ? item : item.id) === s.id);
        const btnClass = isPresent ? "btn-secondary disabled" : "btn-outline-primary";
        const icon = isPresent ? '<i class="bi bi-check2"></i>' : '<i class="bi bi-plus-lg"></i>';
        const action = isPresent ? "" : `onclick="window.addSongFromSearch('${s.id}')"`;

        c.innerHTML += `
            <div class="list-group-item list-group-item-action d-flex justify-content-between align-items-center">
                <div class="text-truncate" style="max-width: 80%;">
                    <div class="fw-bold text-truncate">${s.title}</div>
                    <small class="text-muted text-truncate">${s.author || ''}</small>
                </div>
                <button class="btn btn-sm ${btnClass} rounded-circle" ${action} style="width: 32px; height: 32px; padding: 0;">
                    ${icon}
                </button>
            </div>
        `;
    });
};
window.addSongFromSearch = (songId) => {
    const sl = allSetlists.find(s => s.id === currentSetlistId);
    if(sl) {
        // Controllo duplicati universale (stringa o oggetto)
        const isPresent = sl.songs.some(item => (typeof item === 'string' ? item : item.id) === songId);
        if(isPresent) return showToast("Già in scaletta", "info"); 
        
        // Aggiunge come oggetto per coerenza con il resto del sistema
        const newSongs = [...sl.songs, { id: songId, trans: 0 }];
        updateSetlistSongs(currentSetlistId, newSongs); 
        
        showToast("Aggiunta!", "success");
        window.performSetlistSearch(); 
    }
};
window.insertFormatting = (tag) => {
    const textarea = document.getElementById("lyricsEditor");
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    
    const before = text.substring(0, start);
    const selected = text.substring(start, end);
    const after = text.substring(end);
    
    textarea.value = before + tag + selected + tag + after;
    
    textarea.selectionStart = start + tag.length;
    textarea.selectionEnd = end + tag.length;
    textarea.focus();
    
    window.renderPreview();
};
// --- FUNZIONE EFFETTI VISIVI ---
function createStarryBackground() {
    const overlay = document.getElementById('loadingOverlay');
    // Crea 50 stelle casuali
    for (let i = 0; i < 50; i++) {
        const star = document.createElement('div');
        star.classList.add('star');
        
        // Posizione casuale
        const x = Math.random() * 100;
        const y = Math.random() * 100;
        
        // Dimensione casuale (piccole, medie)
        const size = Math.random() * 2 + 1; // da 1px a 3px
        
        // Durata animazione e delay casuali per effetto scintillio naturale
        const duration = Math.random() * 3 + 2; // da 2s a 5s
        const delay = Math.random() * 5; 
        const opacity = Math.random() * 0.7 + 0.3;

        star.style.left = x + '%';
        star.style.top = y + '%';
        star.style.width = size + 'px';
        star.style.height = size + 'px';
        star.style.setProperty('--duration', duration + 's');
        star.style.setProperty('--delay', delay + 's');
        star.style.setProperty('--opacity', opacity);

        overlay.appendChild(star);
    }
}
// Variabili globali per lo scroll (assicurati siano fuori dalla funzione)
let scrollInterval = null;

window.toggleAutoScroll = () => {
    const area = document.getElementById('previewArea');
    const btn = document.getElementById('btnAutoScroll');
    
    // Se è già attivo, lo fermiamo
    if (scrollInterval) {
        clearInterval(scrollInterval);
        scrollInterval = null;
        if(btn) {
            btn.classList.replace('btn-success', 'btn-outline-success');
            btn.innerHTML = '<i class="bi bi-mouse3"></i> Auto-Scroll';
        }
        return;
    }

    // AVVIO
    if(btn) {
        btn.classList.replace('btn-outline-success', 'btn-success');
        btn.innerHTML = '<i class="bi bi-pause-fill"></i> Stop';
    }

    // Rimuoviamo il controllo "troppo corto" che dava fastidio.
    // Semplicemente se non c'è nulla da scrollare, non succederà nulla visivamente, ma il bottone si accende.
    
    scrollInterval = setInterval(() => {
        // Logica migliorata: controlla se è arrivato in fondo
        if (area.scrollTop + area.clientHeight >= area.scrollHeight - 1) {
            // Arrivato in fondo: ferma tutto
            window.toggleAutoScroll();
        } else {
            // Scorre di 1 pixel
            area.scrollTop += 1;
        }
    }, 50); // Velocità (50ms è standard, abbassa per velocizzare)
};

function updateThemeIcon() {
    return;
}
window.switchView = (viewId) => {
    // 1. Prende tutte le schermate
    const allViews = document.querySelectorAll('.view-screen');
    
    // 2. Rimuove la classe 'active' da TUTTE
    allViews.forEach(view => {
        view.classList.remove('active');
        view.style.display = 'none'; // Sicurezza aggiuntiva
    });

    // 3. Attiva solo quella richiesta
    const target = document.getElementById(viewId);
    if (target) {
        target.style.display = 'block';
        // Piccolo timeout per permettere l'animazione opacity
        setTimeout(() => target.classList.add('active'), 10);
        window.scrollTo(0, 0);
    } else {
        console.error("Vista non trovata:", viewId);
    }
};
