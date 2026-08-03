/* ===================== LAGER SCANNER ===================== */
/* Helt lokal app: IndexedDB, kamera-QR-scanning, fetch+extraktion, PDF-export */

(function () {
  "use strict";

  /* ---------- Konstanter ---------- */
  var DB_NAME = "LagerScannerDB";
  var DB_VERSION = 1;
  var STORE_NAME = "kollin";
  var MAX_STORED_HTML = 20000;    // begränsa lagrad rå-HTML per post
  var MAX_STORED_TEXT = 5000;     // begränsa extraherad text per post
  var MAX_PDF_INFO_CHARS = 900;   // så att varje kolli får plats på EN PDF-sida

  /* ---------- DOM-referenser ---------- */
  var views = {
    home: document.getElementById("view-home"),
    scanner: document.getElementById("view-scanner"),
    loading: document.getElementById("view-loading"),
    form: document.getElementById("view-form"),
    pdf: document.getElementById("view-pdf")
  };

  var statCount = document.getElementById("stat-count");
  var listRecent = document.getElementById("list-recent");
  var homeStatus = document.getElementById("home-status");

  var btnScan = document.getElementById("btn-scan");
  var btnPdf = document.getElementById("btn-pdf");

  var scanVideo = document.getElementById("scan-video");
  var scanStatus = document.getElementById("scan-status");
  var btnScanCancel = document.getElementById("btn-scan-cancel");

  var loadingStatus = document.getElementById("loading-status");
  var btnLoadingCancel = document.getElementById("btn-loading-cancel");

  var kolliForm = document.getElementById("kolli-form");
  var formUrl = document.getElementById("form-url");
  var formExtracted = document.getElementById("form-extracted");
  var inputKolli = document.getElementById("input-kolli");
  var inputHyllplats = document.getElementById("input-hyllplats");
  var inputKommentar = document.getElementById("input-kommentar");
  var btnFormCancel = document.getElementById("btn-form-cancel");
  var fallbackField = document.getElementById("fallback-frame-field");
  var fallbackIframe = document.getElementById("fallback-iframe");
  var fallbackOpenLink = document.getElementById("fallback-open-link");

  var pdfStatus = document.getElementById("pdf-status");
  var btnPdfBack = document.getElementById("btn-pdf-back");

  /* ---------- Tillstånd ---------- */
  var db = null;
  var mediaStream = null;
  var zxingReader = null;
  var nativeDetectLoopId = null;
  var scanningActive = false;
  var pendingScan = null; // { url, html_data, extracted_text }
  var fetchAbortController = null;

  /* ===================== Vy-hantering ===================== */
  function showView(name) {
    Object.keys(views).forEach(function (k) {
      views[k].classList.toggle("active", k === name);
    });
  }

  /* ===================== IndexedDB ===================== */
  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          var store = database.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
          store.createIndex("datum", "datum", { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function addKolli(record) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, "readwrite");
      var store = tx.objectStore(STORE_NAME);
      var req = store.add(record);
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function getAllKollin() {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, "readonly");
      var store = tx.objectStore(STORE_NAME);
      var req = store.getAll();
      req.onsuccess = function (e) { resolve(e.target.result || []); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function countKollin() {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, "readonly");
      var store = tx.objectStore(STORE_NAME);
      var req = store.count();
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function deleteKolli(id) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, "readwrite");
      var store = tx.objectStore(STORE_NAME);
      var req = store.delete(id);
      req.onsuccess = function () { resolve(); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  /* ===================== Hjälpfunktioner ===================== */
  function todayISO() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd;
  }

  function nowDatetime() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    var hh = String(d.getHours()).padStart(2, "0");
    var mi = String(d.getMinutes()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd + " " + hh + ":" + mi;
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function setStatus(el, msg, type) {
    el.textContent = msg || "";
    el.classList.remove("error", "success");
    if (type) el.classList.add(type);
  }

  /* ===================== Extraktion av HTML ===================== */
  function extractTextFromHtml(html) {
    try {
      var doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("script, style, noscript, template").forEach(function (el) { el.remove(); });
      var title = doc.title ? doc.title.trim() : "";
      var bodyText = doc.body ? doc.body.textContent : "";
      bodyText = bodyText.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
      var combined = title ? (title + "\n\n" + bodyText) : bodyText;
      return combined.trim();
    } catch (err) {
      return "";
    }
  }

  async function fetchAndExtract(url) {
    fetchAbortController = new AbortController();
    var timeoutId = setTimeout(function () { fetchAbortController.abort(); }, 15000);
    try {
      var resp = await fetch(url, { mode: "cors", signal: fetchAbortController.signal });
      clearTimeout(timeoutId);
      if (!resp.ok) {
        return { html: "", extracted: "", error: "Servern svarade med status " + resp.status };
      }
      var html = await resp.text();
      var extracted = extractTextFromHtml(html);
      return { html: html, extracted: extracted, error: null };
    } catch (err) {
      clearTimeout(timeoutId);
      var msg = (err && err.name === "AbortError")
        ? "Tidsgräns överskreds vid hämtning."
        : "Kunde inte hämta sidan (CORS eller nätverksfel): " + (err && err.message ? err.message : err);
      return { html: "", extracted: "", error: msg };
    }
  }

  /* ===================== Kamera / QR-scanning ===================== */
  async function startScanner() {
    showView("scanner");
    setStatus(scanStatus, "Startar kamera...");
    scanningActive = true;

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false
      });
    } catch (err) {
      setStatus(scanStatus, "Kunde inte starta kameran: " + err.message, "error");
      return;
    }

    scanVideo.srcObject = mediaStream;
    try {
      await scanVideo.play();
    } catch (e) { /* ignoreras, autoplay kan kräva user-gesture på vissa plattformar */ }

    var nativeSupported = false;
    if ("BarcodeDetector" in window) {
      try {
        var formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.indexOf("qr_code") !== -1) nativeSupported = true;
      } catch (e) { nativeSupported = false; }
    }

    if (nativeSupported) {
      setStatus(scanStatus, "Rikta kameran mot QR-koden...");
      startNativeDetectLoop();
    } else {
      setStatus(scanStatus, "Rikta kameran mot QR-koden... (ZXing)");
      startZXingFallback();
    }
  }

  function startNativeDetectLoop() {
    var detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    var busy = false;

    async function tick() {
      if (!scanningActive) return;
      if (!busy && scanVideo.readyState >= 2) {
        busy = true;
        try {
          var codes = await detector.detect(scanVideo);
          if (codes && codes.length > 0 && scanningActive) {
            onScanSuccess(codes[0].rawValue);
            return;
          }
        } catch (e) { /* tillfälliga fel ignoreras */ }
        busy = false;
      }
      nativeDetectLoopId = requestAnimationFrame(tick);
    }
    nativeDetectLoopId = requestAnimationFrame(tick);
  }

  function startZXingFallback() {
    try {
      zxingReader = new window.ZXing.BrowserQRCodeReader();
      zxingReader.decodeFromVideoElement(scanVideo, function (result, err) {
        if (!scanningActive) return;
        if (result) {
          onScanSuccess(result.getText());
        }
        // "err" (NotFoundException) triggas kontinuerligt medan inget hittas - ignoreras
      });
    } catch (e) {
      setStatus(scanStatus, "QR-scanning stöds inte i denna webbläsare.", "error");
    }
  }

  function stopScanner() {
    scanningActive = false;

    if (nativeDetectLoopId) {
      cancelAnimationFrame(nativeDetectLoopId);
      nativeDetectLoopId = null;
    }
    if (zxingReader) {
      try { zxingReader.reset(); } catch (e) { /* noop */ }
      zxingReader = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
    scanVideo.srcObject = null;
  }

  function onScanSuccess(rawValue) {
    if (!scanningActive) return;
    scanningActive = false;
    stopScanner();
    handleScannedUrl(rawValue);
  }

  /* ===================== Flöde efter scan ===================== */
  async function handleScannedUrl(rawValue) {
    showView("loading");
    setStatus(loadingStatus, "Hämtar information...");

    var url = (rawValue || "").trim();
    var result = await fetchAndExtract(url);

    pendingScan = {
      url: url,
      html_data: result.html ? result.html.slice(0, MAX_STORED_HTML) : "",
      extracted_text: result.extracted ? result.extracted.slice(0, MAX_STORED_TEXT) : "",
      fetchFailed: !!result.error
    };

    if (result.error) {
      pendingScan.extracted_text = "(Kunde inte hämta information automatiskt)\n" + result.error +
        "\n\nTips: Använd förhandsvisningen/länken nedan, eller skriv in viktig information manuellt i kommentarsfältet.";
    }

    openFormForPendingScan();
  }

  function openFormForPendingScan() {
    formUrl.textContent = pendingScan.url || "-";
    formExtracted.textContent = pendingScan.extracted_text || "-";
    inputKolli.value = "";
    inputHyllplats.value = "";
    inputKommentar.value = "";

    if (pendingScan.fetchFailed && pendingScan.url) {
      fallbackField.style.display = "flex";
      fallbackOpenLink.href = pendingScan.url;
      fallbackIframe.src = pendingScan.url;
    } else {
      resetFallbackFrame();
    }

    showView("form");
    setTimeout(function () { inputKolli.focus(); }, 100);
  }

  function resetFallbackFrame() {
    fallbackField.style.display = "none";
    fallbackIframe.src = "about:blank";
    fallbackOpenLink.href = "#";
  }

  async function saveKolli(e) {
    e.preventDefault();
    var kolli = inputKolli.value.trim();
    if (!kolli) {
      inputKolli.focus();
      return;
    }

    var record = {
      url: pendingScan ? pendingScan.url : "",
      html_data: pendingScan ? pendingScan.html_data : "",
      extracted_text: pendingScan ? pendingScan.extracted_text : "",
      kolli: kolli,
      hyllplats: inputHyllplats.value.trim(),
      kommentar: inputKommentar.value.trim(),
      datum: nowDatetime()
    };

    await addKolli(record);
    pendingScan = null;
    resetFallbackFrame();
    showView("home");
    setStatus(homeStatus, "Kolli \"" + kolli + "\" sparad.", "success");
    await refreshHome();
  }

  function cancelForm() {
    pendingScan = null;
    resetFallbackFrame();
    showView("home");
  }

  /* ===================== Hemvy: lista + räknare ===================== */
  async function refreshHome() {
    var count = await countKollin();
    statCount.textContent = String(count);

    var all = await getAllKollin();
    all.sort(function (a, b) { return b.id - a.id; });
    var recent = all.slice(0, 20);

    listRecent.innerHTML = "";
    if (recent.length === 0) {
      var li = document.createElement("li");
      li.className = "empty-note";
      li.style.justifyContent = "center";
      li.textContent = "Inga kollin registrerade ännu.";
      listRecent.appendChild(li);
      return;
    }

    recent.forEach(function (rec) {
      var li = document.createElement("li");

      var main = document.createElement("div");
      main.className = "kolli-main";

      var idEl = document.createElement("div");
      idEl.className = "kolli-id";
      idEl.textContent = rec.kolli || "(utan id)";

      var shelfEl = document.createElement("div");
      shelfEl.className = "kolli-shelf";
      shelfEl.textContent = rec.hyllplats || "";

      var dateEl = document.createElement("div");
      dateEl.className = "kolli-date";
      dateEl.textContent = rec.datum || "";

      main.appendChild(idEl);
      if (rec.hyllplats) main.appendChild(shelfEl);
      main.appendChild(dateEl);

      var delBtn = document.createElement("button");
      delBtn.className = "btn-danger-outline";
      delBtn.textContent = "Ta bort";
      delBtn.addEventListener("click", function () { onDeleteKolli(rec.id); });

      li.appendChild(main);
      li.appendChild(delBtn);
      listRecent.appendChild(li);
    });
  }

  async function onDeleteKolli(id) {
    if (!window.confirm("Ta bort denna registrering?")) return;
    await deleteKolli(id);
    await refreshHome();
  }

  /* ===================== PDF-generering ===================== */
  async function createPdf() {
    showView("pdf");
    btnPdfBack.style.display = "none";
    setStatus(pdfStatus, "Bygger dokument...");

    var records = await getAllKollin();
    if (records.length === 0) {
      setStatus(pdfStatus, "Inga registrerade kollin att skapa PDF för.", "error");
      btnPdfBack.style.display = "block";
      return;
    }
    records.sort(function (a, b) { return a.id - b.id; });

    try {
      var jsPDFCtor = window.jspdf.jsPDF;
      var doc = new jsPDFCtor({ unit: "pt", format: "a4" });
      var pageWidth = doc.internal.pageSize.getWidth();
      var marginX = 44;
      var maxTextWidth = pageWidth - marginX * 2;

      records.forEach(function (rec, index) {
        if (index > 0) doc.addPage();
        renderKolliPage(doc, rec, marginX, maxTextWidth);
      });

      var filename = "Kollin_" + todayISO() + ".pdf";
      var blob = doc.output("blob");
      setStatus(pdfStatus, "PDF skapad. Öppnar delning...", "success");
      await shareOrDownloadPdf(blob, filename);
      btnPdfBack.style.display = "block";
    } catch (err) {
      setStatus(pdfStatus, "Fel vid PDF-skapande: " + err.message, "error");
      btnPdfBack.style.display = "block";
    }
  }

  function renderKolliPage(doc, rec, marginX, maxTextWidth) {
    var y = 56;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text("KOLLI REGISTRERING", marginX, y);
    y += 34;

    doc.setDrawColor(150);
    doc.line(marginX, y - 14, marginX + maxTextWidth, y - 14);

    function addFieldLabel(label) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.setTextColor(110);
      doc.text(label, marginX, y);
      y += 16;
      doc.setTextColor(20);
    }

    function addFieldValue(text, size) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(size || 12);
      var lines = doc.splitTextToSize(text || "-", maxTextWidth);
      doc.text(lines, marginX, y);
      y += lines.length * (size ? size * 1.25 : 15) + 14;
    }

    addFieldLabel("Kolli:");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text(rec.kolli || "-", marginX, y);
    y += 28;

    addFieldLabel("Hyllplats:");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(rec.hyllplats || "-", marginX, y);
    y += 26;

    addFieldLabel("QR URL:");
    addFieldValue(rec.url, 10);

    addFieldLabel("Information:");
    var info = (rec.extracted_text || "-").slice(0, MAX_PDF_INFO_CHARS);
    if ((rec.extracted_text || "").length > MAX_PDF_INFO_CHARS) info += " (...)";
    addFieldValue(info, 9);

    if (rec.kommentar) {
      addFieldLabel("Kommentar:");
      addFieldValue(rec.kommentar, 10);
    }

    addFieldLabel("Datum:");
    addFieldValue(rec.datum, 11);
  }

  async function shareOrDownloadPdf(blob, filename) {
    try {
      var file = new File([blob], filename, { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (err) {
      // Om delning avbryts/misslyckas -> falla tillbaka på nedladdning
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
  }

  /* ===================== Event-bindningar ===================== */
  btnScan.addEventListener("click", startScanner);
  btnScanCancel.addEventListener("click", function () {
    stopScanner();
    showView("home");
  });

  btnLoadingCancel.addEventListener("click", function () {
    if (fetchAbortController) fetchAbortController.abort();
    pendingScan = null;
    showView("home");
  });

  kolliForm.addEventListener("submit", saveKolli);
  btnFormCancel.addEventListener("click", cancelForm);

  btnPdf.addEventListener("click", createPdf);
  btnPdfBack.addEventListener("click", function () { showView("home"); });

  /* ===================== Init ===================== */
  (async function init() {
    if (!("indexedDB" in window)) {
      setStatus(homeStatus, "Denna webbläsare saknar stöd för IndexedDB.", "error");
      return;
    }
    try {
      db = await openDB();
    } catch (err) {
      setStatus(homeStatus, "Kunde inte öppna lokal databas: " + err.message, "error");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus(homeStatus, "Kameraåtkomst kräver HTTPS eller localhost i denna webbläsare.", "error");
    }
    await refreshHome();
    showView("home");
  })();

})();
