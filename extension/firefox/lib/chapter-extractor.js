/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file chapter-extractor.js
 * @description Motor central de extração, limpeza e sanitização de capítulos.
 *              Trata seletores prioritários, integrações especializadas
 *              (Cherrymist, Fictioneer, Madara, WebNovel), fallback para
 *              Readability e estratégias de bypass (Hidden Tab, Iframe).
 *
 * @pipeline Dashboard (Worker Pool) → ChapterExtractor → BookIR
 * @requires window.AgnesLog, window.MESSAGE_TYPES, window.CherrymistDecoder, window.FictioneerDecoder
 */

'use strict';

(function () {
  const api = typeof browser !== 'undefined' ? browser : chrome;

  // JUNK_SELECTORS: Seletores para remoção de lixo, anúncios e navegação
  const JUNK_SELECTORS = [
    'script', 'style', 'noscript', 'iframe', 'button', 'input', 'form',
    'svg', 'canvas', 'audio', 'video', 'nav', 'footer', 'header', 'aside',
    '.chapter-nav', '.nav-links', '.navigation', '.next-chapter', '.prev-chapter',
    '.pager', '.nav-buttons', 'a[rel="prev"]', 'a[rel="next"]',
    '.ad', '.ads', '.advert', '.adsbygoogle', 'div[id^="ad-"]', 'div[class*="banner"]',
    '.sharedaddy', '.social-share', '.social-icons', '#comments', '.comments-area',
    '.patreon-widget', '.ko-fi', 'span[hidden]', '[style*="display:none"]',
    '.wp-post-navigation', '.post-tags', '.entry-footer',
    // Widgets interativos de rodapé de novels (comentários, votos, presentes)
    '.j_bottom_comment_area', '.bottom-comment', '.comment-wrap', '.j_para_comment', '.para-comment',
    '.cha-bts', '.cha-ft', '.bottom-btn', '.bottom-bar', '.vote-wrap', '.j_vote_btn',
    '.gift-wrap', '.send-gift', '.j_send_gift', '.admire-wrap', '.user-links-wrap',
    '.g_ad_ph', '.guide-wrap', '.cha-score', '.review-count', '.pirate',
    'a[href^="javascript"]', 'a[href="#"]', 'a:not([href])'
  ];

  function escapeXml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  /**
   * Limpa resíduos de HTML, tags desconhecidas órfãs e links mortos de widgets do site.
   * Garante que apenas o conteúdo narrativo legítimo vá para a tradução e para o livro final.
   * @param {string} html
   * @returns {string}
   */
  function cleanChapterHtml(html) {
    if (!html) return '';

    var clean = html;

    // 1. Remove tags customizadas e restos de markup malformados (<annotations>, <pirate>, etc.)
    clean = clean
      .replace(/<\/?(?:annotations|pirate|guide-wrap|para-comment|c-para|span-comment)[^>]*>/gi, '')
      .replace(/&lt;\/?(?:annotations|pirate|guide-wrap|para-comment|c-para|span-comment)[^&]*&gt;/gi, '')
      // Remove tags de fechamento de lista soltas no final de parágrafos (ex: </li></ol>)
      .replace(/<\/(?:li|ol|ul)>(?!\s*<(?:li|ol|ul))/gi, '');

    // 2. Remove links mortos e botões de interação web (comentários, votos, presentes, doações)
    clean = clean.replace(/<a\b[^>]*href=[\"'](?:javascript:[^\"']*|#)?[\"'][^>]*>[\s\S]*?<\/a>/gi, function (match) {
      if (/(?:coment[aá]rio|comment|voto|vote|presente|gift|enviar|send|review|avalia[çc][aã]o|power stone|pedra de poder|doar|donate|tip|report|reportar)/i.test(match)) {
        return '';
      }
      // Para outros links mortos, remove a tag <a> e preserva apenas o texto interno
      return match.replace(/<[^>]+>/g, '').trim();
    });

    // 3. Remove parágrafos que contenham apenas palavras de botões residuais
    clean = clean.replace(/<p\b[^>]*>\s*(?:coment[aá]rio\s*\d*\+?\s*coment[aá]rio|voto|vote|enviar presente|send gift|power stone|pedra de poder)\s*<\/p>/gi, '');

    // 4. Remove parágrafos vazios residuais
    clean = clean.replace(/<p\b[^>]*>\s*(?:&nbsp;|\s)*<\/p>/gi, '');

    return clean.trim();
  }

  function extractFallbackTitle(doc) {
    const selectors = ['h1', 'h2', '.chapter-title', '.title', '#chapter-title'];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return doc.title || 'Capítulo';
  }

  function mergeBilingual(originalHtml, translatedHtml) {
    const origParagraphs  = originalHtml.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];
    const transParagraphs = translatedHtml.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];

    if (origParagraphs.length === 0) {
      return originalHtml + '\n<hr />\n' + translatedHtml;
    }

    const parts  = [];
    const maxLen = Math.max(origParagraphs.length, transParagraphs.length);
    for (let j = 0; j < maxLen; j++) {
      if (j < origParagraphs.length) parts.push(origParagraphs[j]);
      if (j < transParagraphs.length) {
        const inner = transParagraphs[j]
          .replace(/^<p[^>]*>/i, '')
          .replace(/<\/p>$/i, '');
        parts.push('<p class="bilingual-translation"><em>' + inner + '</em></p>');
      }
    }
    return parts.join('\n');
  }

  // ── Bypass via Hidden Tab (delegado ao Service Worker) ──
  async function fetchViaHiddenTab(url, selector) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type:     (window.MESSAGE_TYPES && window.MESSAGE_TYPES.FETCH_VIA_HIDDEN_TAB) || 'FETCH_VIA_HIDDEN_TAB',
        url:      url,
        selector: selector
      }, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response ? response.error : 'Erro desconhecido no Hidden Tab.'));
        }
      });
    });
  }

  // ── Bypass via Iframe na aba ativa (fallback local para sites com CORS) ──
  async function fetchViaIframeInActiveTab(url, selector) {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({}, function (tabs) {
        const targetDomain = new URL(url).hostname;
        const siteTab = tabs.find(t => t.url && t.url.includes(targetDomain));
        if (!siteTab) {
          reject(new Error('Aba original não encontrada para injetar o Iframe.'));
          return;
        }

        chrome.tabs.sendMessage(siteTab.id, {
          type:     (window.MESSAGE_TYPES && window.MESSAGE_TYPES.FETCH_VIA_IFRAME) || 'FETCH_VIA_IFRAME',
          url:      url,
          selector: selector
        }, function (response) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            resolve(response.data);
          } else {
            reject(new Error(response ? escapeXml(response.error) : 'Erro desconhecido no Iframe.'));
          }
        });
      });
    });
  }

  // ── Cloudflare Manual Bypass (abre aba para o usuário resolver CAPTCHA) ──
  function resolveBlocker(url) {
    return new Promise(function (resolve, reject) {
      api.tabs.create({ url: url, active: true }, function (tab) {
        var tabId     = tab.id;
        var isResolved = false;

        var timeout = setTimeout(function () {
          if (!isResolved) {
            try { api.tabs.remove(tabId); } catch (e) {}
            api.tabs.onUpdated.removeListener(listener);
            reject(new Error('Timeout na resolução do CAPTCHA'));
          }
        }, 35000);

        function listener(updatedTabId, info) {
          if (updatedTabId === tabId && info.status === 'complete') {
            isResolved = true;
            setTimeout(function () {
              api.tabs.onUpdated.removeListener(listener);
              clearTimeout(timeout);
              try { api.tabs.remove(tabId); } catch (e) {}
              resolve();
            }, 2000);
          }
        }
        api.tabs.onUpdated.addListener(listener);
      });
    });
  }

  function fetchWithTimeout(fetchUrl, options = {}, timeoutMs = 20000) {
    const opts = { ...options };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(timeoutMs);
    }
    return fetch(fetchUrl, opts);
  }

  /**
   * Extrai o conteúdo e título de um capítulo da URL especificada.
   * Roteia para decodificadores específicos ou executa cascade heurístico com fallbacks.
   * @param {string} url
   * @returns {Promise<{title: string, content: string}>}
   */
  async function fetchAndExtractChapter(url) {
    // ── Handler Cherrymist Cafe (REST API + Font Cipher Decrypt) ──
    if (url.includes('cherrymist.cafe') && window.CherrymistDecoder) {
      return await window.CherrymistDecoder.extract(url);
    }

    // ── Handler Universal WP-Manga / Madara / Fictioneer / Heurístico ──
    try {
      const initialRes = await fetchWithTimeout(url, { credentials: 'include' }, 20000);
      if (!initialRes.ok) {
        if (initialRes.status === 403 || initialRes.status === 503) {
          throw { block: true, status: initialRes.status, url };
        }
        throw new Error('HTTP ' + initialRes.status + ': ' + initialRes.statusText);
      }

      const html = await initialRes.text();

      // ── Decriptação Fictioneer (ROT13 + Base64) ──
      const decryptedFictioneer = window.FictioneerDecoder
        ? window.FictioneerDecoder.decrypt(html)
        : null;

      if (decryptedFictioneer) {
        if (typeof AgnesLog !== 'undefined') {
          AgnesLog.info('Fictioneer', 'Capítulo ofuscado descriptografado com sucesso.');
        }
        const tempDoc = new DOMParser().parseFromString(html, 'text/html');
        return { title: extractFallbackTitle(tempDoc), content: decryptedFictioneer };
      }

      const doc = new DOMParser().parseFromString(html, 'text/html');

      // ── Handler Madara: detecta pelo marcador DOM universal ──
      const chapterIdEl = doc.querySelector('#wp-manga-chapter-id');
      if (chapterIdEl && chapterIdEl.value) {
        try {
          const formData = new URLSearchParams();
          formData.append('action',     'manga_get_reading_content');
          formData.append('chapter_id', chapterIdEl.value);
          const ajaxRes = await fetchWithTimeout(new URL('/wp-admin/admin-ajax.php', url).href, {
            method: 'POST', body: formData, credentials: 'include'
          }, 15000);
          const ajaxHtml = await ajaxRes.text();
          if (ajaxHtml && ajaxHtml.length > 50) {
            return { title: extractFallbackTitle(doc), content: ajaxHtml };
          }
        } catch (e) {
          if (typeof AgnesLog !== 'undefined') {
            AgnesLog.warn('Madara', 'Falha no AJAX bypass, tentando extração padrão:', e);
          }
        }
      }

      // ── Handler Fictioneer via WP REST API ──
      const fictioneerJsonLink = doc.querySelector('link[rel="alternate"][type="application/json"][href*="fcn_chapter"]');
      if (fictioneerJsonLink) {
        try {
          const apiRes = await fetch(fictioneerJsonLink.href, { credentials: 'include' });
          if (apiRes.ok) {
            const apiJson = await apiRes.json();
            if (apiJson && apiJson.content && apiJson.content.rendered) {
              if (typeof AgnesLog !== 'undefined') {
                AgnesLog.info('Fictioneer', 'Extraído via WP REST API.');
              }
              const title = extractFallbackTitle(doc) || (apiJson.title && apiJson.title.rendered) || 'Capítulo';
              return { title, content: apiJson.content.rendered };
            }
          }
        } catch (e) {
          if (typeof AgnesLog !== 'undefined') {
            AgnesLog.warn('Fictioneer', 'Erro na API REST:', e);
          }
        }
      }

      // Corrige URLs relativas de imagens
      doc.querySelectorAll('img[src]').forEach(function (img) {
        try { img.src = new URL(img.getAttribute('src'), url).href; } catch (e) {}
      });

      // ── Handler WebNovel: detecta chapInfo embutido em <script> ──
      const scripts = doc.querySelectorAll('script');
      for (const s of scripts) {
        const txt = s.textContent || '';
        if (txt.includes('var chapInfo=')) {
          try {
            const start = txt.indexOf('var chapInfo=') + 'var chapInfo='.length;
            const end = txt.lastIndexOf('};') !== -1 ? txt.lastIndexOf('};') + 1 : txt.length;
            const jsonStr = txt.slice(start, end).trim().replace(/;$/, '');
            const parsed = JSON.parse(jsonStr);
            if (parsed && parsed.chapterInfo && parsed.chapterInfo.contents) {
              const title = (parsed.chapterInfo.chapterName || '').trim() || extractFallbackTitle(doc);
              const contentHtml = parsed.chapterInfo.contents
                .map(c => '<p>' + escapeXml(c.content || '') + '</p>')
                .join('\n');
              if (contentHtml && contentHtml.length > 50) {
                return { title, content: cleanChapterHtml(contentHtml) };
              }
            }
          } catch (_e) {}
        }
      }

      // ── Auto-Detect Manga / Comic ──
      const isMangaForced = window._tlConfig && window._tlConfig.manga;
      const images  = doc.querySelectorAll('img[src]');
      const textLen = doc.body ? doc.body.textContent.trim().length : 0;
      if (isMangaForced || (images.length > 3 && textLen < 500)) {
        let imgHtml = '';
        images.forEach(function (img) {
          if (!img.src.includes('logo') && !img.src.includes('avatar') && !img.src.includes('icon')) {
            imgHtml += '<img src="' + escapeXml(img.src) + '" />\n';
          }
        });
        if (imgHtml) {
          return { title: extractFallbackTitle(doc), content: '<div class="manga-page">' + imgHtml + '</div>' };
        }
      }

      // ── Remoção de Lixo + Deofuscação ──
      const elementsToRemove = [];

      // Tags customizadas desconhecidas (ex: <annotations>, <pirate>) → desempacota nós filhos
      doc.querySelectorAll('*').forEach(function (elem) {
        if (elem.constructor.name === 'HTMLUnknownElement') {
          while (elem.firstChild) {
            elem.parentNode.insertBefore(elem.firstChild, elem);
          }
          elem.parentNode && elem.parentNode.removeChild(elem);
        }
      });

      // Deofuscação: elementos ocultos por CSS inline
      doc.querySelectorAll('span, div, p, font').forEach(function (el) {
        const s = el.style;
        if (!s) return;
        if (
          s.display    === 'none'        ||
          s.visibility === 'hidden'      ||
          s.opacity    === '0'           ||
          s.fontSize   === '0px'         ||
          s.color      === 'transparent' ||
          s.color      === 'rgba(0, 0, 0, 0)'
        ) {
          elementsToRemove.push(el);
        } else if (el.getAttribute('aria-hidden') === 'true') {
          elementsToRemove.push(el);
        }
      });

      // JUNK_SELECTORS
      JUNK_SELECTORS.forEach(function (sel) {
        try {
          doc.querySelectorAll(sel).forEach(el => elementsToRemove.push(el));
        } catch (e) {}
      });

      // Remoção em lote (um único reflow)
      elementsToRemove.forEach(function (el) {
        try { el.parentNode && el.parentNode.removeChild(el); } catch (e) {}
      });

      // ── Seletores Prioritários de Conteúdo ──
      const contentSelectors = [
        'div.chapter_content', '.chapter_content', '.cha-content', '.cha-words', '.j_chapterBox',
        '.epcontent', '.epcontent.entry-content', '#chapter-content', '.chapter-content',
        '.reading-content', '.entry-content', '.text-left', '#chr-content', '.chr-c',
        '.read-container', '.content-area', '#content',
        '.post-content', '.ep-content', '.text-content', '.chapter-body', 'article', 'main'
      ];

      for (const sel of contentSelectors) {
        const el = doc.querySelector(sel);
        if (el && el.textContent.trim().length > 80) {
          return { title: extractFallbackTitle(doc), content: cleanChapterHtml(el.innerHTML.trim()) };
        }
      }

      // ── Fallback: Readability ──
      if (typeof Readability !== 'undefined') {
        try {
          const reader  = new Readability(doc.cloneNode(true), { charThreshold: 30 });
          const article = reader.parse();
          if (article && article.content && article.textContent.trim().length > 80) {
            return { title: article.title || extractFallbackTitle(doc), content: cleanChapterHtml(article.content) };
          }
        } catch (err) {
          if (typeof AgnesLog !== 'undefined') {
            AgnesLog.warn('ChapterExtractor', 'Readability fallback error:', err);
          }
        }
      }

      // ── Último recurso: body limpo ──
      if (doc.body) {
        return { title: extractFallbackTitle(doc), content: cleanChapterHtml(doc.body.innerHTML.trim()) };
      }

      throw new Error('Conteúdo não encontrado na página.');

    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        if (typeof AgnesLog !== 'undefined') {
          AgnesLog.warn('ChapterExtractor', 'Timeout de rede (20s) atingido para ' + url + ', acionando fallback.');
        }
        throw { block: true, timeout: true, url };
      }
      if (err && err.block) throw err;
      throw err;
    }
  }

  // Exportação no escopo global
  window.ChapterExtractor = {
    JUNK_SELECTORS: JUNK_SELECTORS,
    cleanHtml: cleanChapterHtml,
    cleanChapterHtml: cleanChapterHtml,
    extract: fetchAndExtractChapter,
    extractFallbackTitle: extractFallbackTitle,
    mergeBilingual: mergeBilingual,
    fetchViaHiddenTab: fetchViaHiddenTab,
    fetchViaIframeInActiveTab: fetchViaIframeInActiveTab,
    resolveBlocker: resolveBlocker
  };

  // Compatibilidade com código legado
  window.cleanChapterHtml = cleanChapterHtml;
  window.extractFallbackTitle = extractFallbackTitle;
  window.mergeBilingual = mergeBilingual;
  window.fetchViaHiddenTab = fetchViaHiddenTab;
  window.fetchViaIframeInActiveTab = fetchViaIframeInActiveTab;
  window.resolveBlocker = resolveBlocker;
  window.fetchAndExtractChapter = fetchAndExtractChapter;
  window.JUNK_SELECTORS = JUNK_SELECTORS;
})();

