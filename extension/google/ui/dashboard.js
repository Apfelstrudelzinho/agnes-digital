/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file dashboard.js
 * @description Controlador Principal do Dashboard (UI, reatividade, gerenciamento de estado
 *              e orquestração do pipeline de download e compilação de livros).
 *
 * @pipeline Scan → BookIR → Download + Tradução → ExporterRegistry → Saída (EPUB/PDF/TXT/MD/CBZ)
 * @requires window.AgnesLog, window.AgnesDB, window.MESSAGE_TYPES, window.BookIR,
 *           window.Translator, window.ExporterRegistry, window.ChapterExtractor,
 *           window.LibraryManager
 */

'use strict';

// ── Compatibilidade Firefox/Chrome ──
const api = typeof browser !== 'undefined' ? browser : chrome;

// ── Estado Global do Download ──
window.currentChapters = [];
window.currentProject  = null;
let isDownloading      = false;
let shouldCancel       = false;
let jobStartTime       = null;

// Getters/Setters locais para legibilidade
Object.defineProperty(window, 'currentChapters', {
  get: () => window._currentChapters || [],
  set: (v) => { window._currentChapters = v; },
  configurable: true
});
let currentChapters = window.currentChapters;
let currentProject  = window.currentProject;

// ── Configuração de Tradução/Manga (definida pelos botões de ação) ──
window._tlConfig = { enabled: false, manga: false };

// ── Keep-Alive Port (MV3) ──
// Mantém uma conexão aberta com o Service Worker para evitar hibernação durante downloads.
let _keepAlivePort = null;

function startKeepAlive() {
  if (_keepAlivePort) return;
  try {
    _keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
    _keepAlivePort.onDisconnect.addListener(function () {
      _keepAlivePort = null;
      if (isDownloading) setTimeout(startKeepAlive, 1000);
    });
    const pingInterval = setInterval(function () {
      if (!_keepAlivePort || !isDownloading) {
        clearInterval(pingInterval);
        return;
      }
      try { _keepAlivePort.postMessage({ type: (window.MESSAGE_TYPES && window.MESSAGE_TYPES.KEEP_ALIVE_PING) || 'PING' }); }
      catch (e) { clearInterval(pingInterval); }
    }, 20000);
  } catch (e) {
    if (typeof AgnesLog !== 'undefined') {
      AgnesLog.warn('KeepAlive', 'Falha ao conectar porta keep-alive:', e);
    }
  }
}

// ── Constantes de Idiomas Suportados ──
const LANGUAGES = {
  pt: 'Português', en: 'Inglês (English)', es: 'Espanhol (Español)', fr: 'Francês (Français)',
  de: 'Alemão (Deutsch)', it: 'Italiano', 'zh-CN': 'Chinês Simplificado (简体中文)',
  'zh-TW': 'Chinês Tradicional (繁體中文)', ja: 'Japonês (日本語)', ko: 'Coreano (한국어)',
  ru: 'Russo (Русский)', vi: 'Vietnamita (Tiếng Việt)', th: 'Tailandês (ไทย)',
  id: 'Indonésio (Bahasa Indonesia)', ar: 'Árabe (العربية)', tr: 'Turco (Türkçe)',
  nl: 'Holandês (Nederlands)', pl: 'Polonês (Polski)', uk: 'Ucraniano (Українська)',
  hi: 'Hindi (हिन्दी)'
};

// ── UTILITÁRIOS DA UI ──

function log(text, type) {
  type = type || 'info';
  var output = document.getElementById('log-output');
  if (!output) return;
  var entry = document.createElement('div');
  entry.className = 'log-entry log-' + type;
  var time = new Date().toLocaleTimeString();
  entry.textContent = '[' + time + '] ' + text;
  output.appendChild(entry);
  output.scrollTop = output.scrollHeight;
}
window.log = log;

function escapeXml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}
window.escapeXml = escapeXml;

function sanitizeFilename(name) {
  return (name || 'novel')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\.\s]+$/g, '')
    .replace(/\s+/g, '_')
    .trim() || 'novel';
}
window.sanitizeFilename = sanitizeFilename;

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function delayWithJitter(minMs, maxMs) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// ── REGISTRO DE EXPORTADORES ──

function registerExporters() {
  const registry = window.ExporterRegistry;
  if (!registry) {
    if (typeof AgnesLog !== 'undefined') AgnesLog.warn('Dashboard', 'ExporterRegistry not found.');
    return;
  }

  const supportedExporters = [
    { id: 'epub', module: window.EpubBuilder,  method: 'buildEpubFromIR', label: 'EPUB 3.0',        ext: '.epub', icon: '📚' },
    { id: 'pdf',  module: window.PdfExporter,  method: 'exportPdf',       label: 'PDF',             ext: '.pdf',  icon: '📄' },
    { id: 'cbz',  module: window.CbzBuilder,   method: 'buildCbz',        label: 'CBZ (Quadrinho)', ext: '.cbz',  icon: '📦' },
    { id: 'txt',  module: window.TxtBuilder,   method: 'buildTxt',        label: 'Texto (TXT)',     ext: '.txt',  icon: '📄' },
    { id: 'md',   module: window.MdBuilder,    method: 'buildMd',         label: 'Markdown (MD)',   ext: '.md',   icon: '📝' }
  ];

  for (const exp of supportedExporters) {
    if (exp.module && typeof exp.module[exp.method] === 'function') {
      registry.register(exp.id, {
        label:     exp.label,
        extension: exp.ext,
        icon:      exp.icon,
        exportFn:  (bookIR, opts) => exp.module[exp.method](bookIR, opts)
      });
    } else if (typeof AgnesLog !== 'undefined') {
      AgnesLog.warn('Dashboard', `Exportador '${exp.id}' desativado (módulo ou método ausente).`);
    }
  }
}

// ── MUTEX DE TRADUÇÃO (Garante 1 requisição por vez ao serviço de tradução) ──

let _translateMutexLocked = false;
const _translateQueue = [];

function withTranslateMutex(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      _translateMutexLocked = true;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally {
        _translateMutexLocked = false;
        if (_translateQueue.length > 0) _translateQueue.shift()();
      }
    };
    if (_translateMutexLocked) {
      _translateQueue.push(run);
    } else {
      run();
    }
  });
}

function setControlsDisabled(disabled) {
  const ids = [
    'inp-title', 'inp-author', 'inp-filename', 'inp-cover-url', 'inp-cover-file',
    'inp-synopsis', 'sel-status', 'sel-format', 'sel-source-lang', 'sel-target-lang',
    'chk-bilingual', 'inp-search', 'btn-select-all', 'btn-unselect-all',
    'btn-invert', 'btn-reverse', 'chk-all-header'
  ];
  ids.forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
  document.querySelectorAll('.chk-chapter').forEach(function (chk) {
    chk.disabled = disabled;
  });
}

// ── PIPELINE PRINCIPAL DE DOWNLOAD + EXPORTAÇÃO ──

async function handleExport() {
  currentChapters = window.currentChapters;
  var selectedChapters = currentChapters.filter(function (c) { return c.selected !== false; });
  if (selectedChapters.length === 0) {
    log('Nenhum capítulo selecionado.', 'warn');
    return;
  }

  isDownloading = true;
  shouldCancel  = false;
  jobStartTime  = Date.now();
  setControlsDisabled(true);
  startKeepAlive();

  var title        = document.getElementById('inp-title').value.trim()    || 'Novel Baixada';
  var author       = (document.getElementById('inp-author').value.trim()   || 'Unknown Author')
                     .replace(/(?:Translator|Editor|Tradutor|Revisor)\s*:.*$/i, '').trim();
  var coverUrl     = document.getElementById('inp-cover-url').value.trim();
  var filename     = document.getElementById('inp-filename').value.trim() || sanitizeFilename(title);
  var synopsis     = document.getElementById('inp-synopsis').value.trim();
  var status       = document.getElementById('sel-status').value          || 'unknown';
  var sourceUrl    = document.getElementById('inp-url').value.trim();

  var sourceLangEl = document.getElementById('sel-source-lang');
  var language     = (sourceLangEl && sourceLangEl.value && sourceLangEl.value !== 'auto')
                     ? sourceLangEl.value
                     : 'und';

  var tlConfig         = window._tlConfig || {};
  var translateEnabled = tlConfig.enabled  || false;
  var bilingualMode    = document.getElementById('chk-bilingual') && document.getElementById('chk-bilingual').checked;
  var targetLang       = document.getElementById('sel-target-lang')
                         ? (document.getElementById('sel-target-lang').value || 'pt')
                         : 'pt';
  var selectedFormat   = document.getElementById('sel-format').value || 'epub';

  var genres = [];
  document.querySelectorAll('.genre-chip').forEach(function (chip) {
    genres.push(chip.textContent.trim());
  });

  document.getElementById('btn-compile-native').style.display = 'none';
  document.getElementById('btn-compile-tl').parentElement.style.display = 'none';
  document.getElementById('btn-compile-comic').style.display = 'none';
  document.getElementById('btn-cancel').style.display = 'block';
  document.getElementById('progress-section').style.display = 'block';
  document.getElementById('status-indicator').textContent = 'Processando...';

  var formatLabel = selectedFormat.toUpperCase();
  log('Iniciando download de ' + selectedChapters.length + ' capítulos: "' + title + '" → ' + formatLabel, 'info');

  // STEP 1: Tradução da Sinopse (se ativada)
  if (translateEnabled && synopsis && self.Translator) {
    try {
      log('Traduzindo sinopse da obra...', 'info');
      var rawTransSyn = await withTranslateMutex(() =>
        self.Translator.translateText(synopsis, 'auto', targetLang)
      );
      if (rawTransSyn && rawTransSyn.trim()) {
        synopsis = rawTransSyn.replace(/<[^>]+>/g, '').trim();
        var synEl = document.getElementById('inp-synopsis');
        if (synEl) synEl.value = synopsis;
        if (window.currentProject) {
          if (window.currentProject.meta) window.currentProject.meta.synopsis = synopsis;
          if (window.currentProject.metadata) window.currentProject.metadata.synopsis = synopsis;
          window.currentProject.synopsis = synopsis;
        }
        log('Sinopse traduzida com sucesso.', 'info');
      }
    } catch (sErr) {
      if (typeof AgnesLog !== 'undefined') AgnesLog.warn('Dashboard', 'Falha ao traduzir sinopse:', sErr);
    }
  }

  // STEP 2: Construção da Estrutura BookIR
  var metadata = { title, author, coverUrl, synopsis, genres, status, sourceUrl, language };

  function autoGroupChapters(flatNodes) {
    const result = [];
    let currentVolume = null;
    const volRegex = /^(?:volume|book|livro|arc|arco|season|temporada)\s*(\d+|[IVX]+)/i;

    for (const ch of flatNodes) {
      if (!ch.title) ch.title = 'Capítulo';
      const match = ch.title.match(volRegex);
      if (match) {
        const splitPos = ch.title.indexOf(' - ');
        let volName = splitPos > 0 ? ch.title.substring(0, splitPos).trim() : ch.title;
        if (volName.length > 50) volName = 'Volume ' + match[1];
        if (!currentVolume || currentVolume.title !== volName) {
          currentVolume = { type: 'volume', title: volName, children: [] };
          result.push(currentVolume);
        }
      }
      if (currentVolume) {
        currentVolume.children.push(ch);
      } else {
        result.push(ch);
      }
    }
    return result;
  }

  var bookIR;
  if (window.currentProject && window.currentProject.structuredChapters && self.BookIR) {
    bookIR = self.BookIR.createBookIRWithHierarchy(metadata, window.currentProject.structuredChapters);
  } else if (self.BookIR) {
    const grouped = autoGroupChapters(selectedChapters);
    bookIR = grouped.some(n => n.type === 'volume')
      ? self.BookIR.createBookIRWithHierarchy(metadata, grouped)
      : self.BookIR.createBookIR(metadata, selectedChapters);
  } else {
    bookIR = null;
  }

  if (bookIR && bookIR.metadata) {
    bookIR.metadata.synopsis = synopsis;
  }

  var total           = selectedChapters.length;
  var downloadedCount = 0;

  var chapterNodes = bookIR
    ? self.BookIR.getChaptersFlat(bookIR)
    : selectedChapters.map(function (c, i) {
        return { order: i, title: c.title, sourceUrl: c.url, content: '' };
      });

  // Resume (Save State via AgnesDB)
  var stateId    = 'proj_' + (sourceUrl ? btoa(sourceUrl).replace(/[^a-zA-Z0-9]/g, '').substring(0, 30) : Date.now());
  var savedState = null;
  try { savedState = await AgnesDB.getProgress(stateId); } catch (e) {}

  if (savedState && savedState.chapterNodes && savedState.chapterNodes.length === chapterNodes.length) {
    var countDone = savedState.chapterNodes.filter(c => c.content && c.content.length > 50).length;
    if (countDone > 0 && countDone < chapterNodes.length) {
      if (confirm('Você tem um download pausado desta novel (' + countDone + '/' + chapterNodes.length + ' concluídos). Deseja retomar?')) {
        for (let idx = 0; idx < chapterNodes.length; idx++) {
          if (savedState.chapterNodes[idx] && savedState.chapterNodes[idx].content) {
            chapterNodes[idx].content = savedState.chapterNodes[idx].content;
            chapterNodes[idx].title   = savedState.chapterNodes[idx].title;
          }
        }
        downloadedCount = countDone;
        log('Retomando download do capítulo ' + (countDone + 1) + '...', 'info');
      } else {
        await AgnesDB.clearProgress(stateId).catch(() => {});
      }
    }
  }

  // Pool Concorrente de 4 workers
  const CONCURRENCY_LIMIT = 4;
  let currentIndex = 0;
  let speedSamples = [];

  async function workerTask() {
    while (currentIndex < chapterNodes.length) {
      if (shouldCancel) break;

      const i      = currentIndex++;
      const chNode = chapterNodes[i];

      if (chNode.content && chNode.content.length > 50) {
        downloadedCount++;
        updateProgress(downloadedCount, total, null);
        continue;
      }

      var currentNum   = i + 1;
      var chapterTitle = chNode.title;
      var chapterUrl   = chNode.sourceUrl || '';
      if (!/\d/.test(chapterTitle)) chapterTitle = 'Capítulo ' + currentNum + ' - ' + chapterTitle;

      var taskEl = document.getElementById('current-task');
      if (taskEl) taskEl.textContent = 'Baixando: ' + chapterTitle;

      await delayWithJitter(1000, 2500);

      var chapterContent = '';
      var downloadStart  = Date.now();

      try {
        var extracted = await window.ChapterExtractor.extract(chapterUrl);
        var textLen   = extracted.content ? extracted.content.replace(/<[^>]*>?/gm, '').trim().length : 0;
        var imgCount  = extracted.content ? (extracted.content.match(/<img[^>]+src=["'][^"']+["'][^>]*>/gi) || []).length : 0;

        if (textLen < 200 && imgCount === 0) {
          log('Conteúdo insuficiente ou dinâmico em ' + chapterTitle + ' (' + textLen + ' chars), acionando aba oculta...', 'warn');
          throw { block: true, url: chapterUrl };
        }
        chapterContent = extracted.content;
        if (extracted.title) chapterTitle = extracted.title;

      } catch (err) {
        if (err && err.block) {
          try {
            var hiddenSelector = chapterUrl.includes('cherrymist.cafe')
              ? '#root, main, body'
              : '.cha-words, div.chapter_content, .chapter_content, .reading-content, #chapter-content, .cha-content, .j_chapterBox, .chapter-content, .text-left, .post-body';
            var responseData = await window.ChapterExtractor.fetchViaHiddenTab(chapterUrl, hiddenSelector);
            chapterContent = window.ChapterExtractor.cleanHtml(responseData.content || responseData.html || '');
            if (responseData.title) chapterTitle = responseData.title;
          } catch (bErr) {
            chapterContent = '<p>Erro (Bloqueio): ' + escapeXml(bErr.message) + '</p>';
            if (typeof AgnesLog !== 'undefined') AgnesLog.error('Dashboard', 'Falha no Hidden Tab para ' + chapterUrl + ':', bErr);
          }
        } else {
          chapterContent = '<p>Erro ao extrair: ' + escapeXml(chapterUrl) + '</p>';
          if (typeof AgnesLog !== 'undefined') AgnesLog.error('Dashboard', 'Erro ao extrair capítulo:', err);
        }
      }

      // Tradução via Mutex (1 requisição sequencial por vez)
      if (translateEnabled && self.Translator && chapterContent) {
        var originalContent = chapterContent;
        var originalTitle   = chapterTitle;
        var isErrorMessage  = chapterContent.startsWith('<p>Erro (Bloqueio):') || chapterContent.startsWith('<p>Erro ao extrair:');
        if (!isErrorMessage) {
          try {
            if (taskEl) taskEl.textContent = 'Traduzindo: ' + chapterTitle;

            var [translatedTitle, translatedContent] = await withTranslateMutex(async () => {
              var tTitle = chapterTitle;
              try {
                if (chapterTitle && chapterTitle.trim()) {
                  var rawTransTitle = await self.Translator.translateText(chapterTitle, 'auto', targetLang);
                  if (rawTransTitle) {
                    tTitle = rawTransTitle.replace(/<[^>]+>/g, '').trim();
                  }
                }
              } catch (_) {}
              var tContent = await self.Translator.translateText(chapterContent, 'auto', targetLang);
              return [tTitle, tContent];
            });

            if (translatedTitle && translatedTitle !== originalTitle) {
              chapterTitle = bilingualMode
                ? originalTitle + ' (' + translatedTitle + ')'
                : translatedTitle;
            }

            chapterContent = bilingualMode
              ? window.ChapterExtractor.mergeBilingual(originalContent, translatedContent)
              : translatedContent;
          } catch (e) {
            if (typeof AgnesLog !== 'undefined') AgnesLog.warn('Dashboard', 'Falha na tradução do capítulo ' + currentNum + ':', e);
          }
        }
      }

      chNode.title   = chapterTitle;
      chNode.content = window.ChapterExtractor.cleanHtml(chapterContent);
      downloadedCount++;

      speedSamples.push((Date.now() - downloadStart) / 1000);
      if (speedSamples.length > 10) speedSamples.shift();

      updateProgress(downloadedCount, total, speedSamples);

      if (downloadedCount % 10 === 0) {
        AgnesDB.saveProgress(stateId, { chapterNodes }).catch(() => {});
      }
    }
  }

  function updateProgress(done, total, speedSamples) {
    var pct = Math.round((done / total) * 100);
    var barEl = document.getElementById('progress-bar');
    if (barEl) barEl.style.width = pct + '%';
    document.title = '[' + pct + '%] Novels Downloader';
    var statCh = document.getElementById('stat-chapters');
    if (statCh) statCh.textContent = done + '/' + total;

    if (speedSamples && speedSamples.length > 0) {
      var avgSec = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
      var spd    = avgSec > 0 ? (1 / avgSec).toFixed(1) : '0';
      var remSec = avgSec > 0 ? ((total - done) * avgSec) : 0;
      var mm = Math.floor(remSec / 60);
      var ss = Math.floor(remSec % 60);
      var statSpd = document.getElementById('stat-speed');
      var statEta = document.getElementById('stat-eta');
      if (statSpd) statSpd.textContent = spd + ' cap/s';
      if (statEta) statEta.textContent = 'Tempo restante: ' + (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
    }
  }

  var workers = [];
  for (let w = 0; w < CONCURRENCY_LIMIT; w++) workers.push(workerTask());
  await Promise.all(workers);

  if (!shouldCancel) {
    AgnesDB.clearProgress(stateId).catch(() => {});
  }

  if (shouldCancel || downloadedCount === 0) {
    var taskEl = document.getElementById('current-task');
    if (taskEl) taskEl.textContent = shouldCancel ? 'Download cancelado pelo usuário.' : 'Nenhum capítulo baixado.';
    var statEta = document.getElementById('stat-eta');
    if (statEta) statEta.textContent = '--:--';
    resetUI();
    return;
  }

  // Normalização de Títulos de Volumes/Arcos se tradução ativada
  if (translateEnabled && self.BookIR && bookIR) {
    self.BookIR.walkStructure(bookIR.structure, function (node) {
      if (node.type === 'volume' || node.type === 'arc') {
        if (node.title) {
          node.title = node.title
            .replace(/^Book\s+(\d+)/i, 'Livro $1')
            .replace(/^Volume\s+(\d+)/i, 'Volume $1')
            .replace(/^Arc\s+(\d+)/i, 'Arco $1')
            .replace(/^Season\s+(\d+)/i, 'Temporada $1');
        }
      }
    });
  }

  // STEP 3: Exportação do Arquivo Final
  var currentTaskEl = document.getElementById('current-task');
  if (currentTaskEl) currentTaskEl.textContent = 'Compilando arquivo ' + formatLabel + '...';
  var barEl = document.getElementById('progress-bar');
  if (barEl) barEl.style.width = '100%';
  var etaEl = document.getElementById('stat-eta');
  if (etaEl) etaEl.textContent = 'Tempo restante: 00:00';
  log('Capítulos baixados. Gerando arquivo ' + formatLabel + '...', 'info');

  try {
    var coverBlob = null;
    if (coverUrl && coverUrl.startsWith('http')) {
      try {
        var coverRes = await fetch(coverUrl);
        if (coverRes.ok) coverBlob = await coverRes.blob();
      } catch (cErr) {
        if (typeof AgnesLog !== 'undefined') AgnesLog.warn('Export', 'Falha ao baixar capa:', cErr);
      }
    } else if (coverUrl && coverUrl.startsWith('data:')) {
      try {
        const byteStr  = atob(coverUrl.split(',')[1]);
        const mimeType = coverUrl.split(',')[0].split(':')[1].split(';')[0];
        const ab       = new ArrayBuffer(byteStr.length);
        const ia       = new Uint8Array(ab);
        for (let bi = 0; bi < byteStr.length; bi++) ia[bi] = byteStr.charCodeAt(bi);
        coverBlob = new Blob([ab], { type: mimeType });
      } catch (e) {}
    }

    // Processamento de Imagens Inline
    if (currentTaskEl) currentTaskEl.textContent = 'Processando imagens das páginas...';
    var sessionImages = {};
    var allImageUrls  = new Set();

    var targetNodes = bookIR ? self.BookIR.getChaptersFlat(bookIR) : chapterNodes;
    targetNodes.forEach(function (node) {
      var imgRegex = /<img[^>]+src=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
      var match;
      imgRegex.lastIndex = 0;
      while ((match = imgRegex.exec(node.content || '')) !== null) {
        allImageUrls.add(match[1]);
      }
    });

    if (allImageUrls.size > 0) {
      log('Baixando ' + allImageUrls.size + ' imagens inline...', 'info');
      var hashStr = function (str) {
        var hash = 0;
        for (var i = 0; i < str.length; i++) {
          hash = ((hash << 5) - hash) + str.charCodeAt(i);
          hash |= 0;
        }
        return Math.abs(hash);
      };

      for (const imgUrl of allImageUrls) {
        try {
          var imgRes = await fetch(imgUrl);
          if (imgRes.ok) {
            var imgBlob = await imgRes.blob();
            var ext     = (imgBlob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
            var imgName = 'img_' + hashStr(imgUrl) + '.' + ext;
            sessionImages[imgUrl] = { blob: imgBlob, name: imgName };
          }
        } catch (e) {
          if (typeof AgnesLog !== 'undefined') AgnesLog.warn('Export', 'Erro ao baixar imagem: ' + imgUrl, e);
        }
        await wait(300);
      }

      targetNodes.forEach(function (node) {
        if (!node.content) return;
        var imgRegex = /<img[^>]+src=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
        imgRegex.lastIndex = 0;
        node.content = node.content.replace(imgRegex, function (match, imgUrl) {
          return sessionImages[imgUrl] ? match.replace(imgUrl, '../images/' + sessionImages[imgUrl].name) : match;
        });
      });
    }

    // Salva Snapshot na Biblioteca Local
    try {
      await AgnesDB.saveProjectToDB({
        id:          (metadata.title || 'novel').toLowerCase().replace(/\s+/g, '_'),
        title:       metadata.title,
        meta:        metadata,
        chapters:    chapterNodes,
        lastUpdated: Date.now()
      });
      if (typeof AgnesLog !== 'undefined') AgnesLog.info('DB', 'Projeto salvo na biblioteca local.');
    } catch (dbErr) {
      if (typeof AgnesLog !== 'undefined') AgnesLog.warn('DB', 'Erro ao salvar projeto na biblioteca:', dbErr);
    }

    var exportOptions = { coverImageBlob: coverBlob, inlineImages: sessionImages };
    var outputBlob;

    var bookIRForExport = (bookIR && self.BookIR && self.BookIR.cloneIR)
      ? self.BookIR.cloneIR(bookIR)
      : bookIR;

    if (bookIRForExport && self.ExporterRegistry && self.ExporterRegistry.has(selectedFormat)) {
      outputBlob = await self.ExporterRegistry.export(selectedFormat, bookIRForExport, exportOptions);
    } else if (selectedFormat === 'epub' && self.EpubBuilder) {
      outputBlob = await self.EpubBuilder.buildEpub({
        title: title, author, language, coverImageBlob: coverBlob,
        synopsis, genres, status, sourceUrl, inlineImages: sessionImages,
        chapters: chapterNodes.map(ch => ({ title: ch.title, content: ch.content, url: ch.sourceUrl }))
      });
    } else {
      throw new Error('Formato de exportação não disponível: ' + selectedFormat);
    }

    var ext      = self.ExporterRegistry ? self.ExporterRegistry.getExtension(selectedFormat) : ('.' + selectedFormat);
    var safeName = filename + ext;

    if (api.downloads && api.downloads.download) {
      var objectUrl = URL.createObjectURL(outputBlob);
      api.downloads.download({ url: objectUrl, filename: safeName, saveAs: true }, function (downloadId) {
        if (chrome.runtime.lastError) {
          if (typeof AgnesLog !== 'undefined') AgnesLog.error('Export', 'Erro ao disparar download:', chrome.runtime.lastError.message);
          URL.revokeObjectURL(objectUrl);
          return;
        }
        function onDownloadChanged(delta) {
          if (delta.id !== downloadId) return;
          if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
            chrome.downloads.onChanged.removeListener(onDownloadChanged);
            URL.revokeObjectURL(objectUrl);
          }
        }
        chrome.downloads.onChanged.addListener(onDownloadChanged);
        log('Livro ' + formatLabel + ' gerado com sucesso: "' + safeName + '" ✨', 'success');
        document.getElementById('status-indicator').textContent = 'Concluído';
        resetUI();
      });
    } else {
      var a = document.createElement('a');
      var blobUrl = URL.createObjectURL(outputBlob);
      a.href     = blobUrl;
      a.download = safeName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      log('Livro ' + formatLabel + ' gerado com sucesso: "' + safeName + '" ✨', 'success');
      document.getElementById('status-indicator').textContent = 'Concluído';
      resetUI();
    }
  } catch (exportErr) {
    log('Erro ao compilar ' + formatLabel + ': ' + escapeXml(exportErr.message), 'error');
    if (typeof AgnesLog !== 'undefined') AgnesLog.error('Export', 'Falha na exportação:', exportErr);
    resetUI();
  }
}

function resetUI() {
  document.getElementById('btn-compile-native').style.display = '';
  document.getElementById('btn-compile-tl').parentElement.style.display = 'flex';
  document.getElementById('btn-compile-comic').style.display = '';
  document.getElementById('btn-cancel').style.display = 'none';
  document.getElementById('status-indicator').textContent = (api.i18n && api.i18n.getMessage('txtStatusIdle')) || 'Ocioso';
  setControlsDisabled(false);
  isDownloading = false;
}

// ── RENDERIZAÇÃO DA TABELA (DocumentFragment) ──

function renderChapters(chaptersToRender) {
  var tbody = document.getElementById('chapter-list');
  if (!tbody) return;

  var fragment = document.createDocumentFragment();

  chaptersToRender.forEach(function (ch) {
    var tr = document.createElement('tr');
    tr.dataset.index = ch.index;

    var tdCheck = document.createElement('td');
    var chk = document.createElement('input');
    chk.type      = 'checkbox';
    chk.className = 'chk-chapter';
    chk.checked   = ch.selected !== false;
    chk.onchange  = function () {
      ch.selected = chk.checked;
      updateSelectedCount();
    };
    tdCheck.appendChild(chk);

    var tdNum = document.createElement('td');
    tdNum.textContent = ch.index + 1;

    var tdTitle = document.createElement('td');
    tdTitle.textContent = ch.title;

    var tdUrl = document.createElement('td');
    tdUrl.className   = 'col-url';
    tdUrl.textContent = ch.url;
    tdUrl.title       = ch.url;

    tr.appendChild(tdCheck);
    tr.appendChild(tdNum);
    tr.appendChild(tdTitle);
    tr.appendChild(tdUrl);
    fragment.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(fragment);

  updateSelectedCount();
}
window.renderChapters = renderChapters;

function renderGenres(genres) {}

function updateSelectedCount() {
  var checkboxes = document.querySelectorAll('.chk-chapter');
  var selected   = Array.from(checkboxes).filter(function (c) { return c.checked; }).length;
  var counter    = document.getElementById('chapter-counter');
  if (counter) counter.textContent = selected + '/' + window.currentChapters.length + ' selecionados';
}

function populateLanguageDropdowns() {
  var selTargetLang = document.getElementById('sel-target-lang');
  if (!selTargetLang) return;
  Object.keys(LANGUAGES).forEach(function (code) {
    var opt = document.createElement('option');
    opt.value       = code;
    opt.textContent = LANGUAGES[code];
    selTargetLang.appendChild(opt);
  });
  selTargetLang.value = navigator.language.split('-')[0] || 'pt';
}

function filterChapters(query) {
  var q     = query.toLowerCase();
  var tbody = document.getElementById('chapter-list');
  if (!tbody) return;

  var filtered = q
    ? window.currentChapters.filter(ch => ch.title.toLowerCase().includes(q))
    : window.currentChapters;
  renderChapters(filtered);
}

// ── LISTENERS DE EVENTOS DA INTERFACE ──

function attachEventListeners() {
  document.getElementById('inp-title').addEventListener('input', function (e) {
    document.getElementById('inp-filename').value = sanitizeFilename(e.target.value);
  });

  document.getElementById('inp-cover-url').addEventListener('input', function (e) {
    var img        = document.getElementById('img-cover');
    var emptyState = document.getElementById('cover-empty-state');
    if (e.target.value) {
      img.src           = e.target.value;
      img.style.display = '';
      if (emptyState) emptyState.style.display = 'none';
    } else {
      img.style.display = 'none';
      if (emptyState) emptyState.style.display = 'flex';
    }
  });

  var coverFileInput = document.getElementById('inp-cover-file');
  if (coverFileInput) {
    coverFileInput.addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (!file) return;
      var objectUrl = URL.createObjectURL(file);
      document.getElementById('inp-cover-url').value = objectUrl;
      var img        = document.getElementById('img-cover');
      var emptyState = document.getElementById('cover-empty-state');
      img.src           = objectUrl;
      img.style.display = '';
      if (emptyState) emptyState.style.display = 'none';
    });
  }

  document.getElementById('inp-search').addEventListener('input', function (e) {
    filterChapters(e.target.value);
  });

  document.getElementById('btn-select-all').addEventListener('click', function () {
    window.currentChapters.forEach(function (c) { c.selected = true; });
    document.querySelectorAll('.chk-chapter').forEach(function (c) { c.checked = true; });
    updateSelectedCount();
  });

  document.getElementById('btn-unselect-all').addEventListener('click', function () {
    window.currentChapters.forEach(function (c) { c.selected = false; });
    document.querySelectorAll('.chk-chapter').forEach(function (c) { c.checked = false; });
    updateSelectedCount();
  });

  document.getElementById('btn-invert').addEventListener('click', function () {
    window.currentChapters.forEach(function (c) { c.selected = !c.selected; });
    document.querySelectorAll('.chk-chapter').forEach(function (c) { c.checked = !c.checked; });
    updateSelectedCount();
  });

  document.getElementById('btn-reverse').addEventListener('click', function () {
    window.currentChapters.reverse();
    renderChapters(window.currentChapters);
  });

  document.getElementById('chk-all-header').addEventListener('change', function (e) {
    var checked = e.target.checked;
    window.currentChapters.forEach(function (c) { c.selected = checked; });
    document.querySelectorAll('.chk-chapter').forEach(function (c) { c.checked = checked; });
    updateSelectedCount();
  });

  document.getElementById('btn-clear-log').addEventListener('click', function () {
    document.getElementById('log-output').innerHTML = '';
  });

  document.getElementById('btn-cancel').addEventListener('click', function () {
    if (isDownloading) {
      shouldCancel = true;
      log('Cancelando download...', 'warn');
      var taskEl = document.getElementById('current-task');
      if (taskEl) taskEl.textContent = 'Cancelando download...';
      var statusInd = document.getElementById('status-indicator');
      if (statusInd) statusInd.textContent = (api.i18n && api.i18n.getMessage('btnCancel')) || 'Cancelado';
    }
  });
}

function localizeUI() {
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    var msg = api.i18n.getMessage(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
    var msg = api.i18n.getMessage(el.getAttribute('data-i18n-placeholder'));
    if (msg) el.setAttribute('placeholder', msg);
  });
}

// ── INICIALIZAÇÃO (DOMContentLoaded) ──

document.addEventListener('DOMContentLoaded', function () {
  try {
    localizeUI();
    registerExporters();
    populateLanguageDropdowns();
    attachEventListeners();

    var uiLang = api.i18n.getUILanguage().split('-')[0];
    if (LANGUAGES[uiLang]) {
      var selLang = document.getElementById('sel-target-lang');
      if (selLang) selLang.value = uiLang;
    }

    function loadPendingProject(targetKey) {
      api.storage.local.get(null, function (allStorage) {
        var pendingKey  = targetKey || null;
        var newestTime  = 0;

        if (!pendingKey) {
          Object.keys(allStorage).forEach(function (key) {
            if (key.startsWith('pendingProject')) {
              var item = allStorage[key];
              if (item && (item.timestamp || 0) > newestTime) {
                newestTime = item.timestamp || 0;
                pendingKey = key;
              }
            }
          });
        }

        var proj = pendingKey ? allStorage[pendingKey] : null;

        if (proj) {
          window.currentProject = proj;

          var inpUrl = document.getElementById('inp-url');
          if (inpUrl) inpUrl.value = proj.sourceUrl || proj.detectedSite || '';
          var inpTitle = document.getElementById('inp-title');
          if (inpTitle) inpTitle.value = proj.title || '';
          var inpAuthor = document.getElementById('inp-author');
          if (inpAuthor) inpAuthor.value = proj.author || '';

          var img        = document.getElementById('img-cover');
          var emptyState = document.getElementById('cover-empty-state');
          if (img) {
            if (proj.coverUrl) {
              var inpCover = document.getElementById('inp-cover-url');
              if (inpCover) inpCover.value = proj.coverUrl;
              img.src           = proj.coverUrl;
              img.style.display = '';
              if (emptyState) emptyState.style.display = 'none';
            } else {
              img.style.display = 'none';
              if (emptyState) emptyState.style.display = 'flex';
            }
          }

          if (proj.title) {
            var inpFilename = document.getElementById('inp-filename');
            if (inpFilename) inpFilename.value = sanitizeFilename(proj.title);
          }
          if (proj.synopsis) {
            var inpSynopsis = document.getElementById('inp-synopsis');
            if (inpSynopsis) inpSynopsis.value = proj.synopsis;
          }
          if (proj.status) {
            var selStatus = document.getElementById('sel-status');
            if (selStatus) selStatus.value = proj.status;
          }
          if (proj.genres && proj.genres.length > 0) {
            renderGenres(proj.genres);
          }

          if (proj.chapters && Array.isArray(proj.chapters)) {
            window.currentChapters = proj.chapters.map(function (c, i) {
              return { title: c.title, url: c.url, index: i, selected: true };
            });
            renderChapters(window.currentChapters);
            var btnNative = document.getElementById('btn-compile-native');
            if (btnNative) btnNative.disabled = false;
            var btnTl = document.getElementById('btn-compile-tl');
            if (btnTl) btnTl.disabled = false;
            var btnTlSet = document.getElementById('btn-tl-settings');
            if (btnTlSet) btnTlSet.disabled = false;
            var btnComic = document.getElementById('btn-compile-comic');
            if (btnComic) btnComic.disabled = false;

            var hierarchyInfo = '';
            if (proj.structuredChapters && proj.structuredChapters.length > 0) {
              hierarchyInfo = ' (com ' + proj.structuredChapters.length + ' volumes)';
            }
            log('Novel carregada: "' + proj.title + '" (' + window.currentChapters.length + ' capítulos' + hierarchyInfo + ')', 'success');
          }

          if (pendingKey) api.storage.local.remove(pendingKey);
        } else if (!targetKey) {
          log('Pronto. Navegue até a página de uma novel e clique no ícone da extensão para escanear.', 'info');
        }
      });
    }

    var urlParams = new URLSearchParams(window.location.search);
    var initialKey = urlParams.get('key');
    loadPendingProject(initialKey);

    if (chrome && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (msg && msg.type === 'LOAD_PENDING_PROJECT') {
          if (isDownloading) {
            log('Novo escaneamento recebido: conclua ou cancele o download atual para carregá-lo.', 'warn');
          } else {
            loadPendingProject(msg.storageKey);
          }
        }
      });
    }

    if (api && api.storage && api.storage.onChanged) {
      api.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName === 'local' && !isDownloading) {
          var addedKeys = Object.keys(changes).filter(function (k) {
            return k.startsWith('pendingProject') && changes[k].newValue;
          });
          if (addedKeys.length > 0) {
            loadPendingProject(addedKeys[0]);
          }
        }
      });
    }

  } catch (e) {
    if (typeof AgnesLog !== 'undefined') AgnesLog.error('Dashboard', 'Erro de inicialização:', e);
  }
});

// ── TABS & BIBLIOTECA ──

document.addEventListener('DOMContentLoaded', function () {
  var tabExt  = document.getElementById('btn-tab-extrator');
  var tabLib  = document.getElementById('btn-tab-library');
  var viewExt = document.getElementById('tab-extrator');
  var viewLib = document.getElementById('tab-library');
  var btnRefresh = document.getElementById('btn-refresh-lib');

  if (tabExt && tabLib) {
    tabExt.addEventListener('click', function () {
      tabExt.classList.add('active');
      tabLib.classList.remove('active');
      viewExt.style.display = '';
      viewLib.style.display = 'none';
    });
    tabLib.addEventListener('click', function () {
      tabLib.classList.add('active');
      tabExt.classList.remove('active');
      viewLib.style.display = '';
      viewExt.style.display = 'none';
      if (window.LibraryManager) window.LibraryManager.render();
    });
    if (btnRefresh) {
      btnRefresh.addEventListener('click', function () {
        if (window.LibraryManager) window.LibraryManager.render();
      });
    }
  }
});

// ── BOTÕES DE AÇÃO E MODAIS ──

document.getElementById('btn-compile-native').addEventListener('click', function () {
  window._tlConfig.enabled = false;
  window._tlConfig.manga   = false;
  handleExport();
});

document.getElementById('btn-compile-tl').addEventListener('click', function () {
  window._tlConfig.enabled = true;
  window._tlConfig.manga   = false;
  var sourceLang = document.getElementById('sel-source-lang');
  if (sourceLang && !sourceLang.value) sourceLang.value = 'auto';
  handleExport();
});

document.getElementById('btn-compile-comic').addEventListener('click', function () {
  window._tlConfig.enabled = false;
  window._tlConfig.manga   = true;
  var selFormat = document.getElementById('sel-format');
  if (selFormat && (selFormat.value === 'epub' || selFormat.value === 'txt' || selFormat.value === 'md')) {
    selFormat.value = 'cbz';
  }
  handleExport();
});

var modalSettings = document.getElementById('modal-tl-settings');
document.getElementById('btn-tl-settings').addEventListener('click', function () {
  modalSettings.style.display = 'flex';
});
document.getElementById('btn-tl-close').addEventListener('click', function () {
  modalSettings.style.display = 'none';
});
modalSettings.addEventListener('click', function (e) {
  if (e.target === modalSettings) modalSettings.style.display = 'none';
});

// ── Alternância de Tema ──
document.getElementById('btn-theme-toggle').addEventListener('click', function () {
  var isDark = document.body.classList.contains('theme-dark');
  if (isDark) {
    document.body.classList.replace('theme-dark', 'theme-light');
    this.textContent = '🌙';
    localStorage.setItem('novels_downloader_theme', 'light');
  } else {
    document.body.classList.replace('theme-light', 'theme-dark');
    this.textContent = '☀️';
    localStorage.setItem('novels_downloader_theme', 'dark');
  }
});

var savedTheme = localStorage.getItem('novels_downloader_theme');
if (savedTheme === 'light') {
  document.body.classList.replace('theme-dark', 'theme-light');
  var toggleBtn = document.getElementById('btn-theme-toggle');
  if (toggleBtn) toggleBtn.textContent = '🌙';
}
