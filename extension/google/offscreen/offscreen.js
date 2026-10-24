/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file offscreen.js
 * @description Documento Offscreen (Manifest V3 Chromium).
 *              Permite execução de parseamento DOM, Readability e sanitização
 *              em ambiente com acesso a APIs DOM sem interferir na UI principal.
 *
 * @pipeline Service Worker → Offscreen Document → Chapter Cleaning
 * @requires chrome.runtime, Readability
 */

// ── Seletores de Conteúdo Indesejado (Limpeza e Sanitização) ──

const JUNK_SELECTORS = [
  // Elementos ativos e interativos
  'script', 'style', 'noscript', 'iframe', 'button', 'input', 'form',
  'svg', 'canvas', 'audio', 'video', 'textarea', 'select',
  // Ruído estrutural
  'nav', 'footer', 'header', 'aside',
  // Navegação e paginação
  '.chapter-nav', '.nav-links', '.navigation', '.next-chapter', '.prev-chapter',
  '.pager', '.nav-single', '.chapter-navigation', '.nav-buttons',
  'a[rel="prev"]', 'a[rel="next"]',
  '.pagination', '.page-nav', '.post-navigation',
  // Publicidade e anúncios
  '.ad', '.ads', '.advert', '.advertisement', '.inline-ad', '.code-block',
  '.adsbygoogle', 'div[id^="ad-"]', 'div[class*="banner"]',
  'ins.adsbygoogle', '[id*="google_ads"]',
  // Widgets sociais e de compartilhamento
  '.sharedaddy', '.jp-relatedposts', '.social-share', '.social-icons',
  '.share-buttons', '.sharing-buttons', '.social-links',
  // Comentários e comunidade
  '#comments', '.comments-area', '#disqus_thread', '.post-discussion',
  '.review-box', '.comment-section',
  // Patreon / Ko-fi / monetização
  '.patreon-widget', '.ko-fi', '[class*="patreon"]', '[class*="ko-fi"]',
  '.donate-section', '.support-author',
  // Ocultos / marca d'água / metadados
  'span[hidden]', '[style*="display:none"]', '[style*="display: none"]',
  '[style*="visibility:hidden"]', '[style*="visibility: hidden"]',
  '.screen-reader-text', '.watermark', '[aria-hidden="true"]',
  // Ruído comum de temas WordPress
  '.wp-post-navigation', '.post-tags', '.tag-links', '.entry-meta',
  '.entry-footer', '.post-footer', '.related-posts',
  // Avisos e alertas genéricos
  '.alert', '.notice', '.announcement', '.banner-top'
];

// ── Motor de Sanitização do Documento ──

function sanitizeDocument(doc) {
  const combinedSelector = JUNK_SELECTORS.join(', ');
  try {
    doc.querySelectorAll(combinedSelector).forEach(function (el) {
      el.remove();
    });
  } catch (e) {
    // Se o seletor combinado falhar, faz fallback para remoção individual
    JUNK_SELECTORS.forEach(function (sel) {
      try {
        doc.querySelectorAll(sel).forEach(function (el) { el.remove(); });
      } catch (ignored) {}
    });
  }

  // Remove manipuladores de evento inline (onclick, onload, etc.)
  doc.querySelectorAll('*').forEach(function (el) {
    var attrs = Array.from(el.attributes || []);
    attrs.forEach(function (attr) {
      if (attr.name.startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    });
    // Remove estilos inline que ocultam conteúdo
    var style = el.getAttribute('style');
    if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) {
      el.remove();
    }
  });
}

// ── Tratamento de Mensagens IPC ──

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === 'EXTRACT_CHAPTER_OFFSCREEN') {
    handleExtractChapter(message.url)
      .then(function (res) { sendResponse({ success: true, content: res.content, title: res.title }); })
      .catch(function (error) {
        console.error('[Offscreen] Extraction error for', message.url, error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

// ── Pipeline de Extração de Capítulos ──

async function handleExtractChapter(url) {
  var response = await fetch(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error('Fetch failed: ' + response.status + ' ' + response.statusText);
  }

  var html = await response.text();
  var parser = new DOMParser();
  var doc = parser.parseFromString(html, 'text/html');

  // Ajusta URLs relativas de imagens para absolutas
  doc.querySelectorAll('img[src]').forEach(function (img) {
    try {
      img.src = new URL(img.getAttribute('src'), url).href;
    } catch (e) {}
  });

  // ── PASSO 1: Higieniza o lixo do DOM ANTES do Readability ──
  sanitizeDocument(doc);

  // ── PASSO 2: Tenta extração via Readability ──
  var article = null;
  try {
    if (typeof Readability !== 'undefined') {
      var docClone = doc.cloneNode(true);
      var reader = new Readability(docClone, { charThreshold: 30 });
      article = reader.parse();
    }
  } catch (err) {
    console.warn('[Offscreen] Readability parse failed:', err);
  }

  if (article && article.content && article.textContent && article.textContent.trim().length > 80) {
    return {
      title: article.title || extractFallbackTitle(doc),
      content: article.content
    };
  }

  // ── PASSO 3: Fallback para seletores comuns de plataformas de novels ──
  var contentSelectors = [
    '#chapter-content', '.chapter-content', '.reading-content', '.entry-content',
    '.text-left', '#chr-content', '.chr-c', '.cha-content', '.cha-words',
    '.read-container', '.content-area', '#content', '.post-content',
    '.ep-content', '.text-content', '.chapter-body', 'article', 'main'
  ];

  var mainElement = null;
  for (var i = 0; i < contentSelectors.length; i++) {
    var el = doc.querySelector(contentSelectors[i]);
    if (el && el.textContent.trim().length > 80) {
      mainElement = el;
      break;
    }
  }

  if (mainElement) {
    return {
      title: extractFallbackTitle(doc),
      content: mainElement.innerHTML.trim()
    };
  }

  // ── PASSO 4: Usa o corpo (body) higienizado como último recurso ──
  if (doc.body) {
    return {
      title: extractFallbackTitle(doc),
      content: doc.body.innerHTML.trim()
    };
  }

  throw new Error('Unable to extract chapter content from page');
}

function extractFallbackTitle(doc) {
  var titleSelectors = ['h1', 'h2', '.chapter-title', '.title', '#chapter-title'];
  for (var i = 0; i < titleSelectors.length; i++) {
    var el = doc.querySelector(titleSelectors[i]);
    if (el && el.textContent.trim()) {
      return el.textContent.trim();
    }
  }
  return doc.title || 'Chapter';
}
