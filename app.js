// README:
// - Install deps: npm install
// - Start dev: vercel dev
// - Set OPENAI_API_KEY in .env (used only by api/extract.js)
// - Deploy: vercel --prod

const pdfVersion = '4.3.136';
const pdfSources = [
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfVersion}/pdf.min.js`,
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfVersion}/build/pdf.min.js`,
  `https://unpkg.com/pdfjs-dist@${pdfVersion}/build/pdf.min.js`,
  `https://cdn.jsdelivr.net/gh/mozilla/pdf.js@v${pdfVersion}/build/pdf.min.js`,
];
let pdfAvailable = false;
let pdfReadyPromise = ensurePdfJs();

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const extractBtn = document.getElementById('extract-btn');
const exportCsvBtn = document.getElementById('export-csv-btn');
const copyTsvBtn = document.getElementById('copy-tsv-btn');
const clearBtn = document.getElementById('clear-btn');
const fileListEl = document.getElementById('file-list');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const tableBody = document.getElementById('table-body');
const searchInput = document.getElementById('search-input');
const issuesPanel = document.getElementById('issues-panel');
const toast = document.getElementById('toast');
const detailsModal = document.getElementById('details-modal');
const closeModalBtn = document.getElementById('close-modal');
const detailsGrid = document.getElementById('details-grid');

const STORAGE_KEY = 'cmr-notes';
const state = {
  files: [],
  rows: [],
  dedupe: new Set(),
  sortKey: 'datum',
  sortDir: 'asc',
  filterTerm: '',
  totalPages: 0,
  processedPages: 0,
  inProgress: false,
  currentFileIndex: 0,
  currentPage: 0,
  currentPageTotal: 0,
  filePageTotals: []
};

function init() {
  loadStoredRows();
  bindEvents();
  renderTable();
  renderIssuesPanel();
  renderFileList();
  pdfReadyPromise.then((ok) => {
    if (!ok) showToast('PDF renderer not loaded. Check your connection and refresh.');
  });
  runDerivedFieldTests();
}

function bindEvents() {
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
  extractBtn.addEventListener('click', processQueue);
  exportCsvBtn.addEventListener('click', exportCsv);
  copyTsvBtn.addEventListener('click', copyTsv);
  clearBtn.addEventListener('click', clearAll);
  searchInput.addEventListener('input', (e) => {
    state.filterTerm = e.target.value.toLowerCase();
    renderTable();
  });
  document.querySelectorAll('#results-table th').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = 'asc';
      }
      renderTable();
    });
  });
  tableBody.addEventListener('click', (e) => {
    const rowEl = e.target.closest('tr[data-row-id]');
    if (!rowEl) return;
    const id = rowEl.dataset.rowId;
    const row = state.rows.find((r) => r.id === id);
    if (row) showDetails(row);
  });
  closeModalBtn.addEventListener('click', () => detailsModal.classList.remove('show'));
  detailsModal.addEventListener('click', (e) => {
    if (e.target === detailsModal) detailsModal.classList.remove('show');
  });
}

function handleFiles(fileList) {
  const pdfs = Array.from(fileList).filter((f) => {
    if (f.type === 'application/pdf') return true;
    return f.name.toLowerCase().endsWith('.pdf');
  });
  if (!pdfs.length) {
    showToast('Only PDF files are supported.');
    return;
  }
  state.files = [...state.files, ...pdfs];
  extractBtn.disabled = false;
  progressText.textContent = `${state.files.length} file(s) ready.`;
  renderFileList();
  fileInput.value = '';
}

async function processQueue() {
  const ok = await pdfReadyPromise;
  if (!ok) {
    showToast('PDF renderer not loaded. Check your connection and refresh.');
    return;
  }
  if (!state.files.length || state.inProgress) return;
  state.inProgress = true;
  extractBtn.disabled = true;
  progressFill.style.width = '0%';
  state.totalPages = 0;
  state.processedPages = 0;
  state.filePageTotals = [];

  const tasks = [];
  for (let i = 0; i < state.files.length; i++) {
    const file = state.files[i];
    const typedArray = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data: typedArray }).promise;
    state.totalPages += pdf.numPages;
    state.filePageTotals[i] = pdf.numPages;
    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex++) {
      tasks.push(() => handlePage(pdf, { file, fileIndex: i, pageIndex, pageCount: pdf.numPages }));
    }
  }

  const concurrency = 2;
  let running = 0;
  let cursor = 0;

  return new Promise((resolve) => {
    const runNext = () => {
      if (cursor >= tasks.length && running === 0) {
        state.inProgress = false;
        progressText.textContent = 'Done processing.';
        extractBtn.disabled = !state.files.length;
        resolve();
        return;
      }
      while (running < concurrency && cursor < tasks.length) {
        const task = tasks[cursor];
        cursor += 1;
        running += 1;
        task()
          .catch((err) => {
            console.error(err);
            showToast('Failed processing a page. You can retry.');
          })
          .finally(() => {
            running -= 1;
            state.processedPages += 1;
            updateProgress();
            runNext();
          });
      }
    };
    updateProgress();
    runNext();
  });
}

async function handlePage(pdf, meta) {
  state.currentFileIndex = meta.fileIndex + 1;
  state.currentPage = meta.pageIndex;
  state.currentPageTotal = meta.pageCount;
  updateProgress();
  const blob = await renderPageToBlob(pdf, meta.pageIndex);
  const payloadMeta = {
    fileName: meta.file.name,
    fileIndex: meta.fileIndex,
    pageIndex: meta.pageIndex
  };
  const notes = await callExtractApi(blob, payloadMeta);
  if (Array.isArray(notes)) {
    addNotes(notes, payloadMeta);
  }
}

async function renderPageToBlob(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 2.5 });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: context, viewport }).promise;
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

async function callExtractApi(imageBlob, meta) {
  try {
    const formData = new FormData();
    formData.append('image', imageBlob, `${meta.fileName}-p${meta.pageIndex}.png`);
    formData.append('meta', JSON.stringify(meta));
    const res = await fetch('/api/extract', { method: 'POST', body: formData });
    if (!res.ok) {
      showToast('API error while extracting. Retry allowed.');
      throw new Error(`API error ${res.status}`);
    }
    const data = await res.json();
    return data.notes || [];
  } catch (err) {
    showToast('Network/API error. Please retry.');
    throw err;
  }
}

function addNotes(notes, meta) {
  notes.forEach((note, idx) => {
    const key = `${meta.fileName}|${meta.pageIndex}|${note.datum || ''}|${note.aantal || ''}|${note.unit || ''}`;
    if (state.dedupe.has(key)) {
      return;
    }
    state.dedupe.add(key);
    const derived = deriveFields(note, meta);
    const row = {
      id: uniqueId(),
      ...derived,
      raw: note,
      meta,
      noteIndex: idx
    };
    state.rows.push(row);
  });
  saveRows();
  renderTable();
  renderIssuesPanel();
}

function deriveFields(note, meta) {
  const warnings = [];
  const safeDatum = (note.datum || '').trim();
  const rawAantal = (note.aantal || '').trim();
  const rawUnit = (note.unit || '').trim();

  const aantalNormalized = parseAantal(rawAantal, warnings);
  const unitInfo = parseUnit(rawUnit, warnings);

  let hoogte_enkel = null;
  if (unitInfo.valid) {
    hoogte_enkel = unitInfo.digits * 10;
  } else {
    warnings.push('Unit invalid; hoogte_enkel missing.');
  }

  let hoogte_stack = null;
  if (hoogte_enkel != null) {
    hoogte_stack = hoogte_enkel <= 150 ? hoogte_enkel * 2 : hoogte_enkel;
  }

  let aantal2 = null;
  if (aantalNormalized != null) {
    aantal2 = hoogte_enkel != null && hoogte_enkel <= 150
      ? Math.round(aantalNormalized / 2)
      : Math.round(aantalNormalized);
  }

  const pallet = unitInfo.letter === 'M' ? 'BLOK' : 'EURO';

  return {
    datum: safeDatum,
    aantal: rawAantal || '',
    unit: rawUnit || '',
    hoogte_enkel,
    hoogte_stack,
    aantal2,
    pallet,
    warnings,
    duplicate: false,
    fileName: meta.fileName,
    pageIndex: meta.pageIndex
  };
}

function parseAantal(raw, warnings) {
  if (!raw) {
    warnings.push('Missing aantal.');
    return null;
  }
  const normalized = raw.replace(',', '.');
  const num = parseFloat(normalized);
  if (Number.isNaN(num)) {
    warnings.push('Aantal is not a number.');
    return null;
  }
  return num;
}

function parseUnit(raw, warnings) {
  const valid = /^[A-Z][0-9]{2}$/.test(raw);
  if (!valid) warnings.push('Unit format invalid.');
  return {
    valid,
    letter: raw ? raw[0] : '',
    digits: valid ? parseInt(raw.slice(1), 10) : null
  };
}

function renderTable() {
  let rows = [...state.rows];
  if (state.filterTerm) {
    rows = rows.filter((r) => Object.values(r).some((v) => {
      if (v === null || v === undefined) return false;
      return String(v).toLowerCase().includes(state.filterTerm);
    }));
  }
  rows.sort((a, b) => {
    const key = state.sortKey;
    const va = a[key] ?? '';
    const vb = b[key] ?? '';
    if (va < vb) return state.sortDir === 'asc' ? -1 : 1;
    if (va > vb) return state.sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  tableBody.innerHTML = rows.map((row) => {
    const issues = row.warnings.length ? row.warnings.join(', ') : '';
    const hasWarning = (field) => row.warnings.some((w) => w.toLowerCase().includes(field));
    const highlightClass = (val, field) => (val === null || val === '' || hasWarning(field) ? 'highlight' : '');
    const safeVal = (val) => (val === null || val === '' ? '-' : val);
    return `
      <tr data-row-id="${row.id}">
        <td>${safeVal(row.datum)}</td>
        <td class="${highlightClass(row.aantal, 'aantal')}">${safeVal(row.aantal)}</td>
        <td class="${highlightClass(row.unit, 'unit')}">${safeVal(row.unit)}</td>
        <td class="${highlightClass(row.hoogte_enkel, 'hoogte')}">${safeVal(row.hoogte_enkel)}</td>
        <td class="${highlightClass(row.hoogte_stack, 'stack')}">${safeVal(row.hoogte_stack)}</td>
        <td class="${highlightClass(row.aantal2, 'aantal2')}">${safeVal(row.aantal2)}</td>
        <td>${row.pallet}</td>
        <td>${issues ? `<span class="issue-chip">${issues}</span>` : ''}</td>
      </tr>
    `;
  }).join('');
}

function renderIssuesPanel() {
  const allWarnings = state.rows.flatMap((r) => r.warnings.map((w) => `${r.fileName} p${r.pageIndex}: ${w}`));
  issuesPanel.textContent = allWarnings.length ? allWarnings.join(' | ') : 'No warnings.';
}

function exportCsv() {
  if (!state.rows.length) return;
  const headers = ['datum','aantal','unit','hoogte_enkel','hoogte_stack','aantal2','pallet'];
  const lines = [headers.join(',')];
  state.rows.forEach((r) => {
    const values = headers.map((h) => formatCsvValue(r[h]));
    lines.push(values.join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'cmr-notes.csv';
  link.click();
  URL.revokeObjectURL(url);
}

function formatCsvValue(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function copyTsv() {
  if (!state.rows.length) return;
  const headers = ['datum','aantal','unit','hoogte_enkel','hoogte_stack','aantal2','pallet'];
  const lines = [headers.join('\t')];
  state.rows.forEach((r) => {
    const values = headers.map((h) => (r[h] ?? ''));
    lines.push(values.join('\t'));
  });
  await navigator.clipboard.writeText(lines.join('\n'));
  showToast('Copied TSV to clipboard');
}

function clearAll() {
  state.rows = [];
  state.dedupe.clear();
  state.files = [];
  saveRows();
  renderTable();
  renderIssuesPanel();
  renderFileList();
  extractBtn.disabled = true;
  progressText.textContent = 'Idle — no files yet';
  showToast('Cleared all rows and storage');
}

function updateProgress() {
  const total = state.totalPages || 1;
  const pct = Math.min(100, Math.round((state.processedPages / total) * 100));
  progressFill.style.width = `${pct}%`;
  const fileTotal = state.filePageTotals[state.currentFileIndex - 1] || state.currentPageTotal || 1;
  const page = Math.min(state.currentPage, fileTotal);
  progressText.textContent = state.inProgress
    ? `Processing: file ${state.currentFileIndex}/${state.files.length || 1} — page ${page}/${fileTotal} (${pct}%)`
    : 'Idle — no files yet';
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

function showDetails(row) {
  const pairs = [
    ['Filename', row.fileName],
    ['Page #', row.pageIndex],
    ['Datum', row.datum || '-'],
    ['Aantal (raw)', row.aantal || '-'],
    ['Unit', row.unit || '-'],
    ['Hoogte enkel', row.hoogte_enkel ?? '-'],
    ['Hoogte stack', row.hoogte_stack ?? '-'],
    ['Aantal2', row.aantal2 ?? '-'],
    ['Pallet', row.pallet],
    ['Warnings', row.warnings.length ? row.warnings.join(', ') : 'None']
  ];
  detailsGrid.innerHTML = pairs.map(([label, value]) => `
    <div class="cell">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
    </div>
  `).join('');
  detailsModal.classList.add('show');
}

function saveRows() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.rows));
}

function loadStoredRows() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      state.rows = JSON.parse(stored);
      state.rows.forEach((r) => {
        const key = `${r.fileName}|${r.pageIndex}|${r.datum || ''}|${r.aantal || ''}|${r.unit || ''}`;
        state.dedupe.add(key);
      });
    } catch (e) {
      console.warn('Failed to parse stored rows', e);
    }
  }
}

function renderFileList() {
  if (!state.files.length) {
    fileListEl.textContent = 'No files selected yet.';
    return;
  }
  fileListEl.innerHTML = state.files
    .map((f) => `<span class="file-chip">${f.name}</span>`)
    .join('');
}

function runDerivedFieldTests() {
  const samples = [
    { unit: 'E28', aantal: '10', label: 'E28 with aantal 10' },
    { unit: 'E15', aantal: '9', label: 'E15 with aantal 9' },
    { unit: 'E20', aantal: '12,5', label: 'E20 with aantal 12,5' },
    { unit: 'M15', aantal: '8', label: 'M15 pallet=BLOK' },
    { unit: 'A20', aantal: '5', label: 'A20 pallet=EURO' },
    { unit: 'E2X', aantal: '7', label: 'Invalid unit E2X' }
  ];
  samples.forEach((sample) => {
    const derived = deriveFields({ datum: '01-01-2024', aantal: sample.aantal, unit: sample.unit }, { fileName: 'test.pdf', fileIndex: 0, pageIndex: 1 });
    console.log(sample.label, derived);
  });
}

function uniqueId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function ensurePdfJs() {
  if (window.pdfjsLib) {
    setWorkerSrc(pdfSources[0]);
    pdfAvailable = true;
    return true;
  }
  for (const src of pdfSources) {
    try {
      const loaded = await loadScript(src);
      if (!loaded) continue;
      if (window.pdfjsLib) {
        setWorkerSrc(src);
        pdfAvailable = true;
        return true;
      }
    } catch (e) {
      console.warn('Failed loading pdf.js source', src, e);
    }
  }
  pdfAvailable = false;
  return false;
}

function setWorkerSrc(scriptUrl) {
  const workerUrl = scriptUrl.replace('pdf.min.js', 'pdf.worker.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-dynamic="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve(true);
      existing.addEventListener('load', () => resolve(true));
      existing.addEventListener('error', () => reject(new Error('load error')));
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.dynamic = src;
    script.onload = () => {
      script.dataset.loaded = '1';
      resolve(true);
    };
    script.onerror = (err) => reject(err);
    document.head.appendChild(script);
  });
}

init();
