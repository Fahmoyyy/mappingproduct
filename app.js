(() => {
  "use strict";

  // ---------- Matching engine ----------
  // Catatan: awalnya dicoba Fuse.js polos (keys:['name'], threshold 0.4) sesuai draft awal,
  // tapi diuji dengan kalimat Uraian RAB yang realistis (mis. "Crane untuk angkut material")
  // hasilnya 0 kandidat -- karena algoritma Bitap Fuse.js membandingkan SELURUH string,
  // jadi nama katalog pendek ("Crane") vs kalimat panjang selalu dianggap beda jauh.
  // Diganti dengan scorer berbasis overlap kata (token) sendiri: cek berapa kata di nama
  // katalog yang muncul di teks Uraian (toleran typo & angka+satuan nempel spt "1300cc").
  // Ini jauh lebih akurat untuk kasus RAB nyata dan tetap ringan untuk 1000+ baris.

  const STOPWORDS = new Set([
    "yang", "untuk", "dan", "dengan", "di", "ke", "dari", "pada", "atau", "ini", "itu",
    "adalah", "serta", "juga", "sebanyak", "sejumlah", "sebesar", "akan", "telah",
    "oleh", "secara", "atas", "sebagai", "dalam", "tersebut", "per", "biaya",
    "pengadaan", "pekerjaan", "sesuai", "guna", "agar", "supaya",
  ]);

  // Selalu tampilkan 4 kandidat paling mirip walau skornya rendah (bukan disaring habis) --
  // biar user tetap lihat "opsi terbaik yang ada" dan sadar kalau memang lemah/tidak relevan,
  // daripada dapat panel kosong yang terlihat seperti tool tidak jalan.
  const MIN_SCORE_AUTO = 0.02;
  const MIN_SCORE_MANUAL = 0.02;
  const LOW_CONFIDENCE_THRESHOLD = 0.3;

  function normalizeLower(str) {
    return String(str ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  }

  // ---------- Kamus Sinonim ----------
  // Text similarity (token overlap) tidak bisa menjembatani istilah yang benar-benar beda kata
  // (mis. "jaket" vs "seragam") -- itu butuh pengetahuan bisnis, bukan algoritma. Jadi user bisa
  // ajarkan pasangan istilah lewat UI "Kamus Sinonim"; di sini kita ganti semua istilah dalam satu
  // grup jadi satu kata kanonik (istilah pertama di grup) sebelum tokenisasi, di kedua sisi
  // (Uraian RAB & nama katalog), supaya keduanya match walau beda kata.
  let synonymGroups = [];
  let synonymRules = []; // [{ regex, canonical }]

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function rebuildSynonymRules() {
    synonymRules = [];
    for (const group of synonymGroups) {
      const terms = group.map((t) => normalizeLower(t).trim()).filter(Boolean);
      if (terms.length < 2) continue;
      const canonical = terms[0];
      for (let i = 1; i < terms.length; i++) {
        if (terms[i] === canonical) continue;
        synonymRules.push({ regex: new RegExp("\\b" + escapeRegExp(terms[i]) + "\\b", "g"), canonical });
      }
    }
  }

  function applySynonyms(lowerText) {
    if (!synonymRules.length) return lowerText;
    let result = lowerText;
    for (const rule of synonymRules) result = result.replace(rule.regex, rule.canonical);
    return result;
  }

  function canonicalizeLower(str) {
    return applySynonyms(normalizeLower(str));
  }

  function tokenize(str) {
    return canonicalizeLower(str).split(/\s+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  }

  function tokenWeight(t) {
    return Math.min(t.length, 8);
  }

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 99;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[m][n];
  }

  function tokenMatchWeight(catToken, uraianLower, uraianTokenSet) {
    if (uraianTokenSet.has(catToken)) return 1;
    if (catToken.length >= 2 && uraianLower.includes(catToken)) return 0.85;
    for (const ut of uraianTokenSet) {
      if (ut.length >= 2 && (catToken.startsWith(ut) || ut.startsWith(catToken))) return 0.75;
    }
    if (catToken.length >= 4) {
      for (const ut of uraianTokenSet) {
        if (Math.abs(ut.length - catToken.length) <= 1 && levenshtein(ut, catToken) <= 1) return 0.7;
      }
    }
    return 0;
  }

  function getMatchEvidence(item, text, satuan, kelompokAffinity) {
    const uraianLower = canonicalizeLower(text);
    const uraianTokenSet = new Set(tokenize(text));
    const evidence = item._tokens
      .map((catToken) => {
        if (uraianTokenSet.has(catToken)) return { token: catToken, type: "persis" };
        if (catToken.length >= 2 && uraianLower.includes(catToken)) return { token: catToken, type: "bagian kata" };
        for (const uraianToken of uraianTokenSet) {
          if (uraianToken.length >= 2 && (catToken.startsWith(uraianToken) || uraianToken.startsWith(catToken))) {
            return { token: catToken, type: "variasi kata" };
          }
        }
        if (catToken.length >= 4) {
          for (const uraianToken of uraianTokenSet) {
            if (Math.abs(uraianToken.length - catToken.length) <= 1 && levenshtein(uraianToken, catToken) <= 1) {
              return { token: catToken, type: "kemiripan ejaan" };
            }
          }
        }
        return null;
      })
      .filter(Boolean);
    if (unitMatchBonus(satuan, item.unit) > 0) {
      evidence.push({ token: item.unit, type: "satuan cocok" });
    }
    if (kelompokBonus(kelompokAffinity, item.kelompok) >= 0.03) {
      evidence.push({ token: item.kelompok, type: "konteks kelompok cocok" });
    }
    return evidence;
  }

  // ---------- Sinyal Satuan RAB ----------
  // Overlap kata saja gampang salah kaprah: "Tang Potong" (alat) ikut nyangkut di uraian
  // "Potong/tebang pohon" (jasa) cuma gara-gara sama-sama punya kata "potong", padahal alat
  // potong kawat jelas beda konteks dari jasa tebang pohon. Sinyal yang jauh lebih dipercaya
  // dan sudah ada di data tapi belum dipakai: Satuan RAB (kolom "Satuan" di file RAB, mis.
  // "POHON") vs satuan bawaan produk di katalog (mis. unit "Pohon" milik "PANGKAS POHON SAWIT").
  // Kalau dua-duanya sama-sama pakai satuan yang SPESIFIK (bukan satuan umum kayak "Buah"/"Set"
  // yang dipakai ratusan produk), itu petunjuk kuat baris ini memang soal jasa/barang bersatuan
  // itu -- dipakai sebagai bonus skor di atas overlap kata, bukan pengganti.
  let unitFrequency = new Map();

  function normalizeUnitKey(u) {
    return String(u ?? "").trim().toLowerCase();
  }

  function computeUnitFrequency() {
    unitFrequency = new Map();
    for (const item of catalog) {
      const key = normalizeUnitKey(item.unit);
      if (!key) continue;
      unitFrequency.set(key, (unitFrequency.get(key) || 0) + 1);
    }
  }

  function unitMatchBonus(rowSatuan, itemUnit) {
    const a = normalizeUnitKey(rowSatuan);
    const b = normalizeUnitKey(itemUnit);
    if (!a || !b || a !== b) return 0;
    const freq = unitFrequency.get(b) || 0;
    if (freq <= 5) return 0.35;
    if (freq <= 20) return 0.2;
    if (freq <= 50) return 0.08;
    return 0; // satuan terlalu umum (mis. "Buah"/"Set"/"Units") -- tidak informatif
  }

  // ---------- Sinyal Konteks Kelompok ----------
  // Overlap kata per-item tidak "tahu" konteks pekerjaannya apa -- makanya kata generik kayak
  // "potong" gampang nyasar ke alat (Peralatan Kerja) padahal maksud Uraian-nya jasa (Jasa).
  // Di sini kita bangun profil kosakata per Kelompok (Jasa, Material, Peralatan Kerja, dst.)
  // dari nama semua produk katalog -- murni dari data, tanpa daftar kata kunci manual -- lalu
  // cek kosakata Uraian ini paling "mirip" ke Kelompok mana. Kata yang cuma muncul di 1-2
  // Kelompok (mis. "pangkas" cuma di Jasa) jauh lebih diskriminatif daripada kata yang tersebar
  // di hampir semua Kelompok (mis. "besar"/"kecil"), jadi dibobot terbalik dengan jumlah
  // Kelompok yang memuatnya. Hasilnya bonus skor kecil untuk produk yang se-Kelompok dengan
  // dugaan konteks Uraian -- sinyal ketiga di samping overlap kata dan kecocokan satuan.
  const KELOMPOK_BONUS_MAX = 0.15;
  let kelompokTokenGroups = new Map(); // token -> Set(kelompok)
  let kelompokCount = 0;

  function computeKelompokProfiles() {
    kelompokTokenGroups = new Map();
    const kelompokSeen = new Set();
    for (const item of catalog) {
      const k = item.kelompok || "";
      if (!k) continue;
      kelompokSeen.add(k);
      for (const t of item._tokens) {
        if (!kelompokTokenGroups.has(t)) kelompokTokenGroups.set(t, new Set());
        kelompokTokenGroups.get(t).add(k);
      }
    }
    kelompokCount = kelompokSeen.size;
  }

  function computeKelompokAffinity(uraianTokenSet) {
    const raw = new Map();
    for (const t of uraianTokenSet) {
      const groups = kelompokTokenGroups.get(t);
      if (!groups || !groups.size) continue;
      const w = 1 / groups.size; // makin sedikit Kelompok yang punya kata ini, makin diskriminatif
      for (const k of groups) raw.set(k, (raw.get(k) || 0) + w);
    }
    let total = 0;
    for (const v of raw.values()) total += v;
    if (!total || kelompokCount < 2) return new Map();
    const baseline = 1 / kelompokCount;
    const affinity = new Map();
    for (const [k, v] of raw) {
      const share = v / total;
      const excess = Math.max(0, (share - baseline) / (1 - baseline));
      if (excess > 0) affinity.set(k, excess);
    }
    return affinity;
  }

  function kelompokBonus(affinity, itemKelompok) {
    if (!affinity || !affinity.size) return 0;
    return (affinity.get(itemKelompok) || 0) * KELOMPOK_BONUS_MAX;
  }

  function scoreCatalogItem(item, uraianLower, uraianTokenSet, rowSatuan, kelompokAffinity) {
    const catTokens = item._tokens;
    if (!catTokens.length) return 0;
    let matched = 0, total = 0;
    for (const ct of catTokens) {
      const w = tokenWeight(ct);
      total += w;
      matched += w * tokenMatchWeight(ct, uraianLower, uraianTokenSet);
    }
    const base = total ? matched / total : 0;
    const bonus = unitMatchBonus(rowSatuan, item.unit) + kelompokBonus(kelompokAffinity, item.kelompok);
    return Math.min(1, base + bonus);
  }

  function findCandidates(text, limit, minScore, satuan) {
    // Karena sekarang top-N SELALU ditampilkan (skor rendah tidak lagi disaring habis --
    // lihat MIN_SCORE_AUTO di atas), filter-lalu-sort-semua-1155-item per baris jadi mahal
    // kalau dikali 1000+ baris. Jaga performa dengan insertion ke array kecil ukuran `limit`
    // saja, bukan sort penuh array besar.
    const uraianLower = canonicalizeLower(text);
    const uraianTokenSet = new Set(tokenize(text));
    if (!uraianTokenSet.size) return [];
    const kelompokAffinity = computeKelompokAffinity(uraianTokenSet);
    const top = [];
    for (const item of catalog) {
      const score = scoreCatalogItem(item, uraianLower, uraianTokenSet, satuan, kelompokAffinity);
      if (score < minScore) continue;
      if (top.length < limit) {
        top.push({ item, score, evidence: getMatchEvidence(item, text, satuan, kelompokAffinity) });
        if (top.length === limit) top.sort((a, b) => b.score - a.score);
      } else if (score > top[top.length - 1].score) {
        top[top.length - 1] = { item, score, evidence: getMatchEvidence(item, text, satuan, kelompokAffinity) };
        top.sort((a, b) => b.score - a.score);
      }
    }
    top.sort((a, b) => b.score - a.score);
    return top;
  }

  // ---------- State ----------
  let catalog = [];
  let catalogReady = false;
  let headerRow = [];
  let colIdx = { uraian: -1, produk: -1, satuan: -1, volume: -1 };
  let rows = []; // { uraian, satuanDisplay, volumeDisplay, raw: [], candidates: [], selectedItem: null }
  let originalFileName = "rab";
  let filterUnmappedOnly = false;

  // ---------- DOM refs ----------
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const uploadInfo = document.getElementById("uploadInfo");
  const workspace = document.getElementById("workspace");
  const btnAutoMatch = document.getElementById("btnAutoMatch");
  const btnExport = document.getElementById("btnExport");
  const filterUnmapped = document.getElementById("filterUnmapped");
  const progressFill = document.getElementById("progressFill");
  const progressLabel = document.getElementById("progressLabel");
  const matchingStatus = document.getElementById("matchingStatus");
  const exportWarning = document.getElementById("exportWarning");
  const rowsContainer = document.getElementById("rowsContainer");
  const btnToggleSynonyms = document.getElementById("btnToggleSynonyms");
  const synonymSection = document.getElementById("synonym-section");
  const synonymList = document.getElementById("synonymList");
  const synonymInput = document.getElementById("synonymInput");
  const synonymError = document.getElementById("synonymError");
  const btnAddSynonym = document.getElementById("btnAddSynonym");
  const btnExportSynonyms = document.getElementById("btnExportSynonyms");

  const SYNONYM_STORAGE_KEY = "rabMappingProduk_synonyms_v1";

  // ---------- Utilities ----------
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function findColIndex(header, name) {
    const target = name.trim().toLowerCase();
    return header.findIndex((h) => String(h ?? "").trim().toLowerCase() === target);
  }

  // ---------- Load catalog ----------
  async function loadCatalog() {
    try {
      const res = await fetch("catalog.json");
      if (!res.ok) throw new Error("HTTP " + res.status);
      catalog = await res.json();
      catalog.forEach((item) => {
        item._tokens = tokenize(item.nameClean || item.name);
      });
      computeUnitFrequency();
      computeKelompokProfiles();
      catalogReady = true;
    } catch (err) {
      showUploadInfo(
        "Gagal memuat catalog.json (" + err.message + "). " +
        "Kalau file ini dibuka lewat double-click (file://), beberapa browser (terutama Chrome) " +
        "memblokir pembacaan file lokal via fetch. Jalankan lewat VS Code Live Server " +
        "(klik kanan index.html → Open with Live Server) lalu refresh halaman.",
        true
      );
    }
  }

  function recomputeCatalogTokens() {
    catalog.forEach((item) => {
      item._tokens = tokenize(item.nameClean || item.name);
    });
    computeKelompokProfiles();
  }

  // ---------- Kamus Sinonim: load/save/UI ----------
  async function loadSynonyms() {
    try {
      const saved = localStorage.getItem(SYNONYM_STORAGE_KEY);
      if (saved) {
        synonymGroups = JSON.parse(saved);
      } else {
        const res = await fetch("synonyms.json");
        synonymGroups = res.ok ? await res.json() : [];
      }
    } catch (err) {
      synonymGroups = [];
    }
    if (!Array.isArray(synonymGroups)) synonymGroups = [];
    rebuildSynonymRules();
  }

  function persistSynonyms() {
    try {
      localStorage.setItem(SYNONYM_STORAGE_KEY, JSON.stringify(synonymGroups));
    } catch (err) {
      // localStorage bisa gagal (mode private/quota) -- tidak fatal, cukup diabaikan
    }
  }

  function renderSynonymList() {
    if (!synonymGroups.length) {
      synonymList.innerHTML = `<div class="synonym-empty">Belum ada istilah tersimpan. Tambahkan pasangan kata di bawah.</div>`;
      return;
    }
    synonymList.innerHTML = synonymGroups
      .map(
        (group, i) => `<div class="synonym-group">
          <span class="synonym-group-terms">${group.map((t, ti) => (ti === 0 ? `<strong>${escapeHtml(t)}</strong>` : escapeHtml(t))).join(" = ")}</span>
          <button type="button" class="btn-clear" data-action="remove-synonym" data-index="${i}">Hapus</button>
        </div>`
      )
      .join("");
  }

  function addSynonymGroupFromInput() {
    const raw = synonymInput.value.trim();
    if (!raw) return;
    const terms = raw.split(",").map((t) => t.trim()).filter(Boolean);
    if (terms.length < 2) {
      synonymError.textContent = "Masukkan minimal 2 istilah dipisah koma, contoh: jaket, seragam.";
      synonymError.classList.remove("hidden");
      return;
    }
    synonymError.classList.add("hidden");
    synonymGroups.push(terms);
    synonymInput.value = "";
    rebuildSynonymRules();
    if (catalogReady) recomputeCatalogTokens();
    persistSynonyms();
    renderSynonymList();
  }

  function removeSynonymGroup(index) {
    synonymGroups.splice(index, 1);
    rebuildSynonymRules();
    if (catalogReady) recomputeCatalogTokens();
    persistSynonyms();
    renderSynonymList();
  }

  function exportSynonymsFile() {
    const blob = new Blob([JSON.stringify(synonymGroups, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "synonyms.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function showUploadInfo(msg, isError) {
    uploadInfo.textContent = msg;
    uploadInfo.classList.remove("hidden");
    uploadInfo.classList.toggle("error", !!isError);
  }

  // ---------- File handling ----------
  function setupDropzone() {
    ["dragenter", "dragover"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
      })
    );
    ["dragleave", "drop"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
      })
    );
    dropzone.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleFile(file);
    });
  }

  function handleFile(file) {
    if (!/\.xlsx$/i.test(file.name)) {
      showUploadInfo("File harus berformat .xlsx", true);
      return;
    }
    originalFileName = file.name.replace(/\.xlsx$/i, "");
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        parseWorkbook(new Uint8Array(e.target.result));
      } catch (err) {
        showUploadInfo("Gagal membaca file: " + err.message, true);
      }
    };
    reader.onerror = () => showUploadInfo("Gagal membaca file.", true);
    reader.readAsArrayBuffer(file);
  }

  function parseWorkbook(data) {
    const wb = XLSX.read(data, { type: "array" });
    let sheetName = wb.SheetNames.find((n) => n.trim().toLowerCase() === "rab detail");
    let fallbackNote = "";
    if (!sheetName) {
      sheetName = wb.SheetNames[0];
      fallbackNote = ` (sheet "RAB Detail" tidak ditemukan, memakai sheet pertama: "${sheetName}")`;
    }
    const ws = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
    if (!aoa.length) {
      showUploadInfo("Sheet kosong, tidak ada data.", true);
      return;
    }

    headerRow = aoa[0].map((h) => String(h ?? "").trim());
    const dataRows = aoa.slice(1).filter((r) => r.some((c) => String(c ?? "").trim() !== ""));

    colIdx = {
      uraian: findColIndex(headerRow, "Uraian"),
      produk: findColIndex(headerRow, "Produk"),
      satuan: findColIndex(headerRow, "Satuan"),
      volume: findColIndex(headerRow, "Volume"),
    };

    if (colIdx.uraian === -1) {
      showUploadInfo('Kolom "Uraian" tidak ditemukan di sheet ini. Periksa header file.', true);
      return;
    }

    rows = dataRows.map((r) => ({
      uraian: String(r[colIdx.uraian] ?? "").trim(),
      satuanDisplay: colIdx.satuan >= 0 ? String(r[colIdx.satuan] ?? "").trim() : "",
      volumeDisplay: colIdx.volume >= 0 ? r[colIdx.volume] : "",
      raw: r.slice(),
      candidates: [],
      selectedItem: null,
    }));

    showUploadInfo(
      `Berhasil membaca ${rows.length} baris dari sheet "${sheetName}".${fallbackNote}`,
      false
    );
    workspace.classList.remove("hidden");
    btnExport.disabled = false;
    exportWarning.classList.add("hidden");
    renderAllRows();
    updateProgress();
  }

  // ---------- Auto matching ----------
  function runAutoMatch() {
    if (!catalogReady) {
      showUploadInfo("Katalog produk belum berhasil dimuat, tidak bisa menjalankan mapping otomatis.", true);
      return;
    }
    btnAutoMatch.disabled = true;
    matchingStatus.classList.remove("hidden");
    const total = rows.length;
    const chunkSize = 30;
    let i = 0;

    function processChunk() {
      const end = Math.min(i + chunkSize, total);
      for (; i < end; i++) {
        const row = rows[i];
        row.candidates = row.uraian ? findCandidates(row.uraian, 4, MIN_SCORE_AUTO, row.satuanDisplay) : [];
      }
      matchingStatus.textContent = `Mencocokkan baris ${i} dari ${total}...`;
      if (i < total) {
        setTimeout(processChunk, 0);
      } else {
        const withoutAnyCandidate = rows.filter((r) => r.candidates.length === 0).length;
        const confident = rows.filter(
          (r) => r.candidates.length > 0 && r.candidates[0].score >= LOW_CONFIDENCE_THRESHOLD
        ).length;
        const weakOnly = total - withoutAnyCandidate - confident;
        matchingStatus.innerHTML =
          `Pemetaan otomatis selesai — ${total} baris diproses: <strong>${confident}</strong> kandidat kuat, ` +
          `<strong>${weakOnly}</strong> kandidat lemah (perlu diperiksa manual)` +
          (withoutAnyCandidate > 0 ? `, <strong>${withoutAnyCandidate}</strong> tanpa kandidat.` : ".") +
          ` <button type="button" id="btnDismissMatchStatus" class="btn-clear" style="margin-left:8px;padding:2px 10px;">Tutup</button>`;
        document.getElementById("btnDismissMatchStatus").addEventListener("click", () => {
          matchingStatus.classList.add("hidden");
        });
        btnAutoMatch.disabled = false;
        renderAllRows();
        updateProgress();
      }
    }
    processChunk();
  }

  // ---------- Rendering ----------
  function rowStatus(row) {
    return row.selectedItem ? "mapped" : "pending";
  }

  function renderAllRows() {
    rowsContainer.innerHTML = rows.map((row, i) => renderRowCard(row, i)).join("");
    applyFilter();
  }

  function renderRowCard(row, index) {
    const status = rowStatus(row);
    const statusLabel = { pending: "Belum dipetakan", mapped: "Sudah dipetakan" }[status];

    const allLowConfidence = row.candidates.length > 0 && row.candidates.every((c) => c.score < LOW_CONFIDENCE_THRESHOLD);
    const candidatesHtml = row.candidates.length
      ? `${allLowConfidence ? '<div class="low-confidence-warning">Semua kandidat berskor rendah — kemungkinan baris ini bukan item barang. Tetap wajib dipetakan, periksa manual sebelum memilih.</div>' : ""}
        <div class="candidates">${row.candidates
          .map((c, ci) => {
            const selected = row.selectedItem && row.selectedItem.ref === c.item.ref;
            const lowConf = c.score < LOW_CONFIDENCE_THRESHOLD;
            const scoreTier = c.score >= 0.6 ? "high" : c.score >= LOW_CONFIDENCE_THRESHOLD ? "mid" : "low";
            const evidence = c.evidence || [];
            const evidenceText = evidence.length
              ? `Dasar kecocokan: ${evidence.map((match) => `${escapeHtml(match.token)} (${match.type})`).join(", ")}`
              : "Tidak ada kata yang cocok secara langsung — periksa manual sebelum memilih.";
            return `<button type="button" class="candidate-card${selected ? " selected" : ""}${lowConf ? " low-confidence" : ""}" data-action="select-candidate" data-row="${index}" data-cand="${ci}">
              <span class="candidate-score score-${scoreTier}">${Math.round(c.score * 100)}%</span>
              <div class="candidate-name">${escapeHtml(c.item.name)}</div>
              <div class="candidate-detail">${escapeHtml(c.item.unit || "-")} · ${escapeHtml(c.item.kelompok || "-")}</div>
              <div class="candidate-reason">${evidenceText}</div>
            </button>`;
          })
          .join("")}</div>`
      : `<div class="no-candidates">Tidak ditemukan kandidat yang cocok di katalog. Baris ini tetap wajib dipetakan — gunakan pencarian manual di bawah.</div>`;

    const selectedSummary = row.selectedItem
      ? `<div class="selected-summary">Dipilih: <strong>${escapeHtml(row.selectedItem.name)}</strong></div>`
      : "";

    return `<div class="row-card status-${status}" data-row-card="${index}">
      <div class="row-header">
        <div>
          <div class="row-index">Baris #${index + 1}</div>
          <div class="row-uraian">${escapeHtml(row.uraian || "(kosong)")}</div>
          <div class="row-meta">Satuan RAB: ${escapeHtml(row.satuanDisplay || "-")} &nbsp;|&nbsp; Volume: ${escapeHtml(row.volumeDisplay ?? "-")}</div>
        </div>
        <span class="status-badge ${status}">${statusLabel}</span>
      </div>

      ${candidatesHtml}
      ${selectedSummary}

      <div class="row-actions">
        <div class="manual-search-wrap">
          <input type="text" class="manual-search-input" placeholder="Cari produk lain secara manual..." data-row="${index}" autocomplete="off">
          <div class="manual-search-results hidden" data-row="${index}"></div>
        </div>
        ${status === "mapped" ? `<button type="button" class="btn-clear" data-action="clear-row" data-row="${index}">Reset</button>` : ""}
      </div>
    </div>`;
  }

  function updateRowCardDom(index) {
    const el = rowsContainer.querySelector(`[data-row-card="${index}"]`);
    if (!el) return;
    const temp = document.createElement("div");
    temp.innerHTML = renderRowCard(rows[index], index);
    el.replaceWith(temp.firstElementChild);
    applyFilter();
  }

  function applyFilter() {
    const cards = rowsContainer.querySelectorAll("[data-row-card]");
    cards.forEach((card) => {
      const idx = Number(card.dataset.rowCard);
      const status = rowStatus(rows[idx]);
      const shouldHide = filterUnmappedOnly && status !== "pending";
      card.classList.toggle("hidden", shouldHide);
    });
  }

  function updateProgress() {
    const total = rows.length;
    const processed = rows.filter((r) => r.selectedItem).length;
    const pct = total ? Math.round((processed / total) * 100) : 0;
    progressFill.style.width = pct + "%";
    progressLabel.textContent = `${processed} dari ${total} baris sudah dipetakan`;
  }

  // ---------- Row actions (event delegation) ----------
  function closeAllDropdowns(exceptRow) {
    rowsContainer.querySelectorAll(".manual-search-results").forEach((el) => {
      if (Number(el.dataset.row) !== exceptRow) {
        el.classList.add("hidden");
        el.innerHTML = "";
      }
    });
  }

  rowsContainer.addEventListener("click", (e) => {
    const target = e.target.closest("[data-action]");
    if (target) {
      const index = Number(target.dataset.row);
      const row = rows[index];
      const action = target.dataset.action;

      if (action === "select-candidate") {
        const candIdx = Number(target.dataset.cand);
        row.selectedItem = row.candidates[candIdx].item;
        updateRowCardDom(index);
        updateProgress();
      } else if (action === "clear-row") {
        row.selectedItem = null;
        updateRowCardDom(index);
        updateProgress();
      }
      return;
    }

    // click on a manual search suggestion
    const suggestion = e.target.closest(".manual-search-item");
    if (suggestion && suggestion.dataset.ref) {
      const index = Number(suggestion.dataset.row);
      const ref = suggestion.dataset.ref;
      const item = catalog.find((c) => c.ref === ref);
      if (item) {
        rows[index].selectedItem = item;
        updateRowCardDom(index);
        updateProgress();
      }
      return;
    }

    // clicked elsewhere inside container: close open dropdowns
    if (!e.target.closest(".manual-search-wrap")) {
      closeAllDropdowns(-1);
    }
  });

  let searchDebounce = null;
  rowsContainer.addEventListener("input", (e) => {
    if (!e.target.classList.contains("manual-search-input")) return;
    const index = Number(e.target.dataset.row);
    const query = e.target.value.trim();
    const resultsEl = rowsContainer.querySelector(`.manual-search-results[data-row="${index}"]`);

    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      if (!query) {
        resultsEl.classList.add("hidden");
        resultsEl.innerHTML = "";
        return;
      }
      if (!catalogReady) return;
      const results = findCandidates(query, 8, MIN_SCORE_MANUAL, rows[index].satuanDisplay);
      if (!results.length) {
        resultsEl.innerHTML = `<div class="manual-search-item">Tidak ada hasil.</div>`;
      } else {
        resultsEl.innerHTML = results
          .map(
            (r) => `<div class="manual-search-item" data-row="${index}" data-ref="${escapeHtml(r.item.ref)}">
              <div>${escapeHtml(r.item.name)}</div>
              <span class="candidate-detail">${escapeHtml(r.item.unit || "-")} · ${escapeHtml(r.item.kelompok || "-")}</span>
            </div>`
          )
          .join("");
      }
      closeAllDropdowns(index);
      resultsEl.classList.remove("hidden");
    }, 150);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".manual-search-wrap")) {
      closeAllDropdowns(-1);
    }
  });

  // ---------- Export ----------
  // Setiap baris RAB wajib punya produk -- tidak ada opsi skip. Export diblokir selama
  // masih ada baris yang belum dipetakan, supaya file hasil export tidak pernah punya baris kosong.
  function exportXlsx() {
    if (!rows.length) return;

    const unmapped = rows.filter((r) => !r.selectedItem).length;
    if (unmapped > 0) {
      exportWarning.textContent =
        `Belum bisa export — masih ada ${unmapped} baris yang belum diberi produk. Lengkapi seluruh baris terlebih dahulu.`;
      exportWarning.classList.remove("hidden");
      filterUnmapped.checked = true;
      filterUnmappedOnly = true;
      applyFilter();
      return;
    }
    exportWarning.classList.add("hidden");

    const newHeader = headerRow.slice();
    let produkIdx = colIdx.produk;
    if (produkIdx === -1) {
      produkIdx = newHeader.length;
      newHeader.push("Produk");
    }
    const refColIdx = newHeader.length;
    newHeader.push("Produk Internal Reference");

    const aoa = [newHeader];
    rows.forEach((row) => {
      const cells = row.raw.slice();
      while (cells.length < newHeader.length) cells.push("");
      cells[produkIdx] = row.selectedItem.name;
      cells[refColIdx] = row.selectedItem.ref;
      aoa.push(cells);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "RAB Detail");
    XLSX.writeFile(wb, `${originalFileName}_mapped.xlsx`);
  }

  // ---------- Init ----------
  async function init() {
    setupDropzone();
    await loadSynonyms(); // harus siap dulu sebelum tokenisasi katalog jalan
    renderSynonymList();
    loadCatalog();

    btnAutoMatch.addEventListener("click", runAutoMatch);
    btnExport.addEventListener("click", exportXlsx);
    filterUnmapped.addEventListener("change", (e) => {
      filterUnmappedOnly = e.target.checked;
      applyFilter();
    });

    btnToggleSynonyms.addEventListener("click", () => {
      synonymSection.classList.toggle("hidden");
    });
    btnAddSynonym.addEventListener("click", addSynonymGroupFromInput);
    synonymInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addSynonymGroupFromInput();
    });
    btnExportSynonyms.addEventListener("click", exportSynonymsFile);
    synonymList.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action='remove-synonym']");
      if (btn) removeSynonymGroup(Number(btn.dataset.index));
    });
  }

  init();
})();
