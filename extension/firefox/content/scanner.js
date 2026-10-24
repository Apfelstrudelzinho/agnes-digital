/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file scanner.js
 * @description Content script injetado nas páginas web.
 *              Realiza varredura inteligente do DOM, extração de índices e metadados,
 *              detecção de hierarquia/volumes, identificação de paywall e iframes invisíveis.
 *
 * @pipeline Web Page DOM → Smart Scanner → IPC Message → Dashboard
 * @requires chrome.runtime
 */

// ── Proteção contra reinjeção dupla do script ──

if (!window.__novelScannerInitialized) {
  window.__novelScannerInitialized = true;

  // Roteador único de mensagens IPC — todos os tipos de mensagem passam aqui.
  // Um único listener evita condição de corrida entre múltiplos addListener.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {

      // ── Scan da página de índice (chamado pelo Service Worker) ──
      case 'SCAN_INDEX_PAGE':
        (async () => {
          try {
            const result = await executeSmartScanner();
            sendResponse({ success: true, data: result });
          } catch (error) {
            console.error('[AgnesDigital] Scan error:', error);
            // Serializa o erro como string (objetos Error não trafegam por JSON no Chrome)
            sendResponse({ success: false, error: error.message || String(error) });
          }
        })();
        return true; // Mantém o canal aberto para resposta assíncrona

      // ── Ping de anti-duplicação (service-worker verifica se já está injetado) ──
      case 'PING':
        sendResponse({ pong: true });
        return false;

      // ── Fetch de capítulo Cherrymist via contexto da aba ativa (Bypass de CORS) ──
      case 'FETCH_CHERRYMIST_CHAPTER':
        (async () => {
          try {
            let chId = msg.chapterId;
            let chTitle = null;
            if (!chId && msg.slug) {
              const sRes = await fetch(`https://cherrymist.cafe/api/chapters/by-slug/${msg.slug}`, { credentials: 'include' });
              if (sRes.ok) {
                const sData = await sRes.json();
                chId = sData.id;
                chTitle = sData.title;
              }
            }
            if (!chId) throw new Error('Capítulo não identificado');
            const res = await fetch(`https://cherrymist.cafe/api/chapters/${chId}`, { credentials: 'include' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();

            // Se o corpo foi retido com revealTicket (Anti-Scraping / Liveness)
            if (data.bodyWithheld && data.revealTicket) {
              try {
                const ticket = data.revealTicket;
                const rawPayload = ticket.split('.')[1];
                const padded = rawPayload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - rawPayload.length % 4) % 4);
                const payload = JSON.parse(atob(padded));
                const jti = payload.jti;

                if (jti) {
                  const KEY = '457698978af0c511a6ebfd44efc0679651c0b0485fec76fe9a5acab91a26eb02';
                  const msgProof = `chapter-reveal.v1.${chId}.${jti}`;
                  const enc = new TextEncoder();
                  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
                  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msgProof));
                  const proof = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

                  const revRes = await fetch(`/api/chapters/${chId}/reveal`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                      'Content-Type': 'application/json',
                      'X-CM-Reader': '1'
                    },
                    body: JSON.stringify({
                      ticket: ticket,
                      frames: 40,
                      elapsedMs: 650,
                      visible: true,
                      focused: true,
                      proof: proof
                    })
                  });

                  if (revRes.ok) {
                    const revData = await revRes.json();
                    if (revData && revData.content) {
                      data.content = revData.content;
                      if (revData.foreword) data.foreword = revData.foreword;
                      if (revData.afterword) data.afterword = revData.afterword;
                      data.bodyWithheld = false;
                    }
                  }
                }
              } catch (revErr) {
                console.warn('[AgnesDigital] Erro no reveal do scanner:', revErr);
              }
            }

            // Fallback para DOM do leitor se estiver aberto na aba
            if (!data.content) {
              const readerEl = document.querySelector('[style*="--cm-cipher"]') || document.querySelector('.space-y-6');
              if (readerEl && readerEl.innerText && readerEl.innerText.trim().length > 100) {
                data.content = readerEl.innerHTML;
              }
            }

            if (chTitle && !data.title) data.title = chTitle;
            sendResponse({ success: true, data });
          } catch (err) {
            sendResponse({ success: false, error: err.message || String(err) });
          }
        })();
        return true;

      // ── Fetch via Iframe Sandboxado (bypass de CORS/Cloudflare) ──
      case 'FETCH_VIA_IFRAME':
        handleIframeFetch(msg, sendResponse);
        return true; // Resposta assíncrona

      default:
        return false;
    }
  });
}

// ── Motor de Auto-Expansão do DOM ──

// Rola até o rodapé e clica repetidamente nos botões de "Carregar mais"
// para garantir que sites com rolagem infinita ou paginação AJAX carreguem
// todos os capítulos no DOM antes da leitura do índice.

async function autoExpandDom() {
  console.log('[AgnesDigital] Starting Auto-Expander (Scroll/Click)...');
  let previousHeight = -1;
  let attemptsWithoutGrowing = 0;
  const MAX_ATTEMPTS      = 4;
  const POLL_INTERVAL_MS  = 300;  // Polling: aguarda crescimento real, não tempo fixo
  const MAX_SAFETY_HEIGHT = 250000; // Teto de segurança: ~250 KB de DOM

  const seletoresLoadMore = [
    '.load-more', '#load-more', '.btn-load-more', '.load-more-btn',
    'a.load-more', 'button.load-more', '.chap_more', '#btn-load-more',
    '[data-action="load-more"]', '.list-chapter-readmore',
    '.nav-previous > a', 'a.next.page-numbers', '#btn_sycn_chapter',
    '.btn-expand', '[data-show-more]', '.show-more-chapters', '.chapter-readmore',
    '.more-chapters', 'a.more', 'button.more'
  ];

  // Selectors agrupados em uma única query (Selector Grouping)
  const loadMoreSelector = seletoresLoadMore.join(',');

  while (attemptsWithoutGrowing < MAX_ATTEMPTS) {
    let clicked = false;

    document.querySelectorAll(loadMoreSelector).forEach(btn => {
      if (
        btn.offsetParent !== null &&
        !btn.disabled &&
        btn.style.display !== 'none'
      ) {
        // Previne navegação dura (hard-navigation): ignora links reais para outras páginas
        if (
          btn.tagName === 'A' &&
          btn.href &&
          !btn.href.includes('#') &&
          !btn.href.startsWith('javascript:') &&
          new URL(btn.href).origin === window.location.origin
        ) return;
        try { btn.click(); clicked = true; } catch (_e) {}
      }
    });

    // scrollIntoView no último filho visível é menos agressivo que window.scrollTo(0, Infinity)
    // e não quebra SPAs que recalculam posição após scroll forçado
    const lastChild = document.body.lastElementChild;
    if (lastChild) {
      try { lastChild.scrollIntoView({ behavior: 'instant', block: 'end' }); } catch (_e) {}
    }

    // Polling: aguarda até o DOM crescer (máximo MAX_ATTEMPTS × 300ms por rodada)
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const currentHeight = document.body.scrollHeight;
    if (currentHeight <= previousHeight && !clicked) {
      attemptsWithoutGrowing++;
    } else {
      attemptsWithoutGrowing = 0;
      previousHeight = currentHeight;
    }

    if (currentHeight > MAX_SAFETY_HEIGHT) break;
  }

  // Volta ao topo sem forçar scroll agressivo
  try { document.body.firstElementChild?.scrollIntoView({ block: 'start', behavior: 'instant' }); } catch (_e) {}
  console.log('[AgnesDigital] Auto-Expander complete. Final height:', document.body.scrollHeight);
}

// AUTO-PAGINATION ENGINE (Background Fetch)

/**
 * Localiza links de paginação tradicionais (ex: "Próxima Página") e realiza
 * requisições em segundo plano para consolidar a lista de capítulos.
 *
 * @param {Array} initialChapters - Lista inicial de capítulos
 * @param {string} hostname - Nome do host do site
 * @returns {Promise<Array>} Lista completa de capítulos consolidados
 */
async function fetchHiddenPages(initialChapters, hostname) {
  const allChapters = [...initialChapters];
  const MAX_PAGES   = 40;
  const visitedUrls = new Set([window.location.href.split('#')[0]]);

  const nextSelectors = [
    'a.next.page-numbers', '.nav-previous > a', 'a.next', 'li.next a',
    '.pagination .next', '.pagination-next a', 'a[rel="next"]'
  ];

  // Coleta TODAS as páginas de paginação de uma vez (em paralelo)
  // em vez de iterar serialmente (waterfall).
  let docContext = document;
  const pageUrls = new Set();

  // Segue a cadeia de paginação para coletar URLs (até MAX_PAGES)
  for (let page = 0; page < MAX_PAGES; page++) {
    let nextLink = null;
    for (const sel of nextSelectors) {
      const el = docContext.querySelector(sel);
      if (el?.href?.startsWith('http')) { nextLink = el.href; break; }
    }
    if (!nextLink || visitedUrls.has(nextLink)) break;
    visitedUrls.add(nextLink);
    pageUrls.add(nextLink);

    // Busca a próxima página para continuar a cadeia
    try {
      const res  = await fetch(nextLink);
      const html = await res.text();
      docContext = new DOMParser().parseFromString(html, 'text/html');
    } catch (_e) { break; }
  }

  if (pageUrls.size === 0) return allChapters;
  console.log(`[AgnesDigital] Auto-pagination: ${pageUrls.size} páginas para buscar em paralelo.`);

  // Busca todas as páginas em paralelo (Promise.all)
  const pageResults = await Promise.all(
    Array.from(pageUrls).map(async url => {
      try {
        const res     = await fetch(url);
        if (!res.ok) return [];
        const html    = await res.text();
        const doc     = new DOMParser().parseFromString(html, 'text/html');
        const found   = scanHighConfidenceSelectors(doc);
        return found.length > 0 ? found : scanLinkCluster(doc);
      } catch (_e) { return []; }
    })
  );

  for (const chapters of pageResults) {
    allChapters.push(...chapters);
  }

  return allChapters;
}

/**
 * @returns {Object} Complete novel data (metadata + chapters)
 */
async function executeSmartScanner() {
  const hostname = window.location.hostname.replace('www.', '').toLowerCase();

  await autoExpandDom();

  let result = await executeScanPipeline(hostname);

  // Fallback SPA: se nenhum capítulo foi encontrado, usa polling de 300ms
  // (até 4s) aguardando o framework renderizar o DOM completo.
  // Mais rápido que sleep fixo em conexões estáveis; mesmo resultado em lentas.
  if (!result.chapters || result.chapters.length === 0) {
    console.log('[AgnesDigital] 0 chapters on 1st try. Polling for SPA render...');
    const POLL_MS      = 300;
    const MAX_POLLS    = 13; // máx ~4s total
    let   polls        = 0;
    let   prevHeight   = document.body.scrollHeight;

    while (polls < MAX_POLLS) {
      await new Promise(r => setTimeout(r, POLL_MS));
      polls++;
      const newHeight = document.body.scrollHeight;
      // Se o DOM cresceu, o SPA ainda está renderizando — aguarda mais
      if (newHeight > prevHeight) { prevHeight = newHeight; continue; }
      // DOM estabilizou — tenta scan de novo
      result = await executeScanPipeline(hostname);
      if (result.chapters && result.chapters.length > 0) break;
    }
  }

  if (result.chapters && result.chapters.length > 0) {
    result.chapters = await fetchHiddenPages(result.chapters, hostname);
  }

  result.chapters    = sanitizeChapterList(result.chapters);
  result.totalFound  = result.chapters.length;

  return result;
}

// ── Pipeline de Varredura e Identificação ──

/**
 * Executa a esteira de identificação e extração de metadados e capítulos.
 *
 * @param {string} hostname - Nome do host do site (sem www)
 * @returns {Promise<Object>} Metadados e lista de capítulos encontrados
 */
async function executeScanPipeline(hostname) {
  let title = extractTitle(hostname);
  let author = extractAuthor(hostname);
  let coverUrl = extractCover(hostname);
  let synopsis = extractSynopsis(hostname);
  let genres = extractGenres(hostname);
  let status = extractStatus(hostname);
  const fandom = extractFandom(hostname);
  const warnings = extractWarnings(hostname);
  const relationships = extractRelationships(hostname);
  const rating = extractRating(hostname);

  let chapters = [];
  let structuredChapters = null;
  let strategyUsed = 'none';

  // ── Estratégia 1: Handler dedicado do site ──
  const handler = getSiteHandler(hostname);
  if (handler) {
    try {
      const handlerResult = await handler();
      if (handlerResult?.flat) {
        chapters = handlerResult.flat;
        structuredChapters = handlerResult.structured || null;
      } else if (handlerResult?.chapters) {
        chapters = handlerResult.chapters;
        structuredChapters = handlerResult.structuredChapters || null;
      } else if (Array.isArray(handlerResult)) {
        chapters = handlerResult;
      }

      if (handlerResult?.title) title = handlerResult.title;
      if (handlerResult?.author) author = handlerResult.author;
      if (handlerResult?.coverUrl) coverUrl = handlerResult.coverUrl;
      if (handlerResult?.synopsis) synopsis = handlerResult.synopsis;
      if (handlerResult?.genres && handlerResult.genres.length > 0) genres = handlerResult.genres;
      if (handlerResult?.status) status = handlerResult.status;

      if (chapters?.length > 0) {
        strategyUsed = `site-handler:${hostname}`;
      }
    } catch (error) {
      console.warn(`[AgnesDigital] Handler for ${hostname} failed:`, error);
    }
  }

  // ── Estratégia 2: Seletores de alta confiança ──
  if (!chapters?.length) {
    chapters = scanHighConfidenceSelectors();
    if (chapters?.length) strategyUsed = 'high-confidence-selectors';
  }

  // ── Estratégia 3: Inspeção de dados em memória do framework ──
  if (!chapters?.length) {
    chapters = scanFrameworkData();
    if (chapters?.length) strategyUsed = 'framework-memory';
  }

  // ── Estratégia 4: Heurística de agrupamento de links no DOM ──
  if (!chapters?.length) {
    chapters = scanLinkCluster();
    if (chapters?.length) strategyUsed = 'cluster-heuristic';
  }

  // ── Estratégia 5: Casamento amplo de padrões de URL ──
  if (!chapters?.length) {
    chapters = scanUrlPatterns();
    if (chapters?.length) strategyUsed = 'url-pattern-fallback';
  }

  console.log(`[AgnesDigital] Scan complete: ${hostname}. Strategy: ${strategyUsed}. Found: ${chapters.length}`);

  return {
    title: title, author: author, coverUrl: coverUrl, synopsis: synopsis,
    genres: genres, status, fandom, warnings: warnings,
    relationships: relationships, rating: rating,
    chapters: chapters, structuredChapters: structuredChapters,
    strategyUsed: strategyUsed, detectedSite: hostname
  };
}

// ── Extratores Dedicados por Site ──

/**
 * Retorna uma função de escaneamento específica para sites conhecidos.
 * Cada handler implementa a lógica de extração de capítulos particular
 * para aquele site (API, AJAX, selectors DOM específicos, etc.)
 *
 * @param {string} hostname - Hostname do site
 * @returns {Function|null} Função assíncrona de escaneamento ou null
 */
function getSiteHandler(hostname) {
  // ── Archive of Our Own (AO3) ──
  if (hostname.includes('archiveofourown.org')) {
    return createHandlerAO3();
  }

  // ── FanFiction.net ──
  if (hostname.includes('fanfiction.net')) {
    return createHandlerFanFictionNet();
  }

  // ── WebNovel.com ──
  if (hostname.includes('webnovel.com')) {
    return createHandlerWebNovel();
  }

  // ── Cherrymist Cafe (Nova Plataforma SPA / REST API) ──
  if (hostname.includes('cherrymist.cafe')) {
    return createHandlerCherrymist();
  }

  // ── Fictioneer Legacy (WordPress) ──
  if (document.querySelector('[data-controller="fictioneer"]')) {
    return createHandlerFictioneer();
  }

  // ── Mystorywave API (BotiTranslation, Mystorywave) ──
  if (hostname.includes('botitranslation.com') || hostname.includes('mystorywave.com')) {
    return createHandlerMystorywave();
  }

  // ── Manga Livre (WordPress Madara / AJAX) ──
  if (hostname.includes('mangalivre.blog')) {
    return createHandlerMadara();
  }

  // ── Woopread / BCA Translation (CSS Rules) ──
  if (hostname.includes('woopread.com') || hostname.includes('bcatranslation.com')) {
    return createHandlerWpManga();
  }

  // ── Weebsread (Blogger) ──
  if (hostname.includes('weebsread.com')) {
    return createHandlerBlogger();
  }

  // ── Novema (Japonês) ──
  if (hostname.includes('novema.jp')) {
    return createHandlerNovema();
  }

  // ── Lorepress / NovelFire / NovelArrow (APIs paginadas) ──
  if (hostname.includes('lorepress.net') || hostname.includes('novelfire.net') || hostname.includes('novelarrow.com')) {
    return createHandlerPaginatedApi(hostname);
  }

  // ── NovelFull e derivados (com AJAX e paginação) ──
  if (['novelfull.net', 'novelfull.com', 'readnovelfull.com', 'novelbin.com',
       'novelbin.net', 'novelbuddy.com', 'freewebnovel.com']
      .some(site => hostname.includes(site))) {
    return createHandlerNovelFull();
  }

  // ── StorySeedling ──
  if (hostname.includes('storyseedling.com')) {
    return createHandlerStorySeedling();
  }

  // ── Royal Road ──
  if (hostname.includes('royalroad.com')) {
    return createHandlerRoyalRoad();
  }

  // ── Scribble Hub ──
  if (hostname.includes('scribblehub.com')) {
    return createHandlerScribbleHub();
  }

  // ── LightNovelPub / LightNovelWorld ──
  if (hostname.includes('lightnovelpub.com') || hostname.includes('lightnovelworld.com')) {
    return createHandlerLightNovelPub();
  }

  // ── BoxNovel (WP-Manga) ──
  if (hostname.includes('boxnovel.com')) {
    return createHandlerBoxNovel();
  }

  return null;
}

// ── Implementações dos handlers de cada site ──

/** Cria handler para Archive of Our Own — navega para /works/ID/navigate para obter list completa */
function createHandlerAO3() {
  return async () => {
    const chapters = [];
    let navUrl = window.location.href;

    if (!navUrl.includes('/navigate')) {
      const match = navUrl.match(/works\/(\d+)/);
      if (match) navUrl = `https://archiveofourown.org/works/${match[1]}/navigate`;
    }

    try {
      const res = await fetch(navUrl);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('ol.chapter.index.group a[href*="/chapters/"]').forEach(a => {
        chapters.push({
          title: extractCleanTitleFromLink(a),
          url: new URL(a.getAttribute('href'), 'https://archiveofourown.org').href
        });
      });
      if (chapters.length > 0) return { chapters: chapters, structuredChapters: null };
    } catch (e) {
      console.warn('Falha no handler AO3:', e);
    }
    return null;
  };
}

/** Cria handler para FanFiction.net — extrai capítulos do dropdown <select> */
function createHandlerFanFictionNet() {
  return async () => {
    const chapters = [];
    const select = document.querySelector('#chap_select, select[name="chapter"]');
    if (!select) return null;

    const baseMatch = window.location.href.match(/(https?:\/\/[^\/]+\/s\/\d+\/)/);
    if (!baseMatch) return null;

    const baseUrl = baseMatch[1];
    Array.from(select.options).forEach(opt => {
      chapters.push({ title: opt.textContent.trim(), url: baseUrl + opt.value });
    });

    // Deduplicação (FF.net duplica o select no topo e rodapé da página)
    const dedup = Array.from(new Map(chapters.map(c => [c.url, c])).values());
    return dedup.length > 0 ? { chapters: dedup, structuredChapters: null } : null;
  };
}

/** Cria handler para WebNovel — tenta API JSON oficial, fallback para DOM */
function createHandlerWebNovel() {
  return async () => {
    const pathname = window.location.pathname;
    const bookIdMatch = pathname.match(/_(\d+)/) || pathname.match(/\/book\/(\d+)/);
    const bookId = bookIdMatch?.[1];

    if (bookId) {
      // Tenta a API JSON oficial do WebNovel
      const apiUrls = [
        `https://www.webnovel.com/go/pcm/chapter/get-chapter-list?bookId=${bookId}`,
        `https://www.webnovel.com/go/pcm/book/get-catalog?bookId=${bookId}`
      ];

      for (const apiUrl of apiUrls) {
        try {
          const res = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
          if (!res.ok) continue;

          const json = await res.json();
          const { flat, structured } = processWebNovelResponse(json, bookId);
          if (flat.length > 0) {
            // Retorna estrutura hierárquica se houver múltiplos volumes
            if (structured.length > 1 || (structured.length === 1 && structured[0].title !== 'Volume 1')) {
              return { flat, structured };
            }
            return flat;
          }
        } catch (e) {
          console.warn('[WebNovel] Erro na API:', e);
        }
      }
    }

    // Fallback: extração via DOM
    return extractWebNovelChaptersDOM();
  };
}

/**
 * Processa a resposta JSON da API do WebNovel em listas flat e estruturada.
 *
 * @param {Object} json - API response
 * @param {string} bookId - Book ID
 * @returns {{ flat: Array, structured: Array }}
 */
function processWebNovelResponse(json, bookId) {
  const flat = [];
  const structured = [];
  const data = json.data || json;
  const volumeItems = data.volumeItems || (data.chapterItems ? [{ chapterItems: data.chapterItems }] : []);

  let ordemGlobal = 0;

  for (const vol of volumeItems) {
    const volNode = {
      type: 'volume',
      title: vol.volumeName || vol.name || ('Volume ' + (structured.length + 1)),
      children: []
    };

    for (const ch of (vol.chapterItems || [])) {
      const chId = ch.chapterId || ch.id;
      const nome = ch.chapterName || ch.name || `Chapter ${ch.chapterIndex || ''}`;
      if (!chId) continue;

      const url = `https://www.webnovel.com/book/${bookId}/${chId}`;
      flat.push({ title: nome.trim(), url });
      volNode.children.push({
        type: 'chapter', title: nome.trim(), url, order: ordemGlobal++
      });
    }

    if (volNode.children.length > 0) structured.push(volNode);
  }

  return { flat, structured };
}

/** Extrai capítulos do WebNovel via DOM como fallback */
function extractWebNovelChaptersDOM() {
  const links = document.querySelectorAll('ol.content-list li a, .volume-item a, .j_catalog_list a, a[href*="/book/"]');
  const list = [];

  links.forEach(a => {
    if (!a.href || a.href.endsWith('/catalog') || a.href.endsWith('/about') || isNavigationLink(a.href)) return;
    const text = a.textContent.trim();
    if (text && (text.toLowerCase().includes('chapter') || /\d+/.test(text))) {
      list.push({ title: text, url: a.href });
    }
  });

  return list;
}

/** Cria handler para Cherrymist Cafe (Nova Plataforma SPA / REST API) */
function createHandlerCherrymist() {
  return async () => {
    try {
      const pathname = window.location.pathname;
      let seriesSlug = null;
      let seriesId = null;

      // 1. Caso o usuário esteja em um capítulo (/chapter/{slug} ou /chapters/{slug})
      const chapterMatch = pathname.match(/\/(?:chapter|chapters)\/([^/?#]+)/i);
      if (chapterMatch) {
        const chapterSlug = chapterMatch[1];
        try {
          const chRes = await fetch(`https://cherrymist.cafe/api/chapters/by-slug/${chapterSlug}`, { credentials: 'include' });
          if (chRes.ok) {
            const chData = await chRes.json();
            if (chData) {
              seriesSlug = chData.series_slug || null;
              seriesId   = chData.series_id || null;
            }
          }
        } catch (e) {
          console.warn('[AgnesDigital] Erro ao resolver capítulo Cherrymist por slug:', e);
        }
      }

      // 2. Caso o usuário esteja na página da série (/series/{slug} ou /story/{slug} ou /novel/{slug})
      if (!seriesSlug) {
        const seriesMatch = pathname.match(/\/(?:series|story|novel)\/([^/?#]+)/i);
        if (seriesMatch) {
          seriesSlug = seriesMatch[1];
        } else {
          const parts = pathname.split('/').filter(Boolean);
          if (parts.length > 0 && !['about', 'contact', 'login', 'register', 'home', 'search'].includes(parts[0])) {
            seriesSlug = parts[parts.length - 1];
          }
        }
      }

      // 3. Busca metadados da série via API
      let seriesData = null;
      if (seriesSlug) {
        try {
          const sRes = await fetch(`https://cherrymist.cafe/api/series/${seriesSlug}`, { credentials: 'include' });
          if (sRes.ok) {
            seriesData = await sRes.json();
            if (seriesData && seriesData.id) {
              seriesId = seriesData.id;
            }
          }
        } catch (e) {
          console.warn('[AgnesDigital] Erro ao buscar série Cherrymist:', e);
        }
      }

      if (!seriesId && !seriesSlug) {
        return null;
      }

      // 4. Busca lista de capítulos via API
      let chaptersList = [];
      if (seriesId) {
        const chListRes = await fetch(`https://cherrymist.cafe/api/chapters?series_id=${seriesId}`, { credentials: 'include' });
        if (chListRes.ok) {
          chaptersList = await chListRes.json();
        }
      }

      if (!Array.isArray(chaptersList) || chaptersList.length === 0) {
        return null;
      }

      // 5. Mapeia capítulos
      const flat = [];
      for (const item of chaptersList) {
        const chNum = item.chapter_number != null ? `Chapter ${item.chapter_number}` : '';
        const title = (item.title || chNum || `Chapter ${item.id}`).trim();
        const slug  = item.slug || item.id;
        const url   = `https://cherrymist.cafe/chapter/${slug}?id=${item.id}`;

        flat.push({
          title: title,
          url: url,
          chapterId: item.id,
          chapterNumber: item.chapter_number,
          isLocked: item.is_locked === 1,
          priceType: item.price_type || 'free'
        });
      }

      // 6. Prepara metadados para preencher o Dashboard
      let coverUrl = '';
      if (seriesData && seriesData.cover_image_url) {
        try {
          coverUrl = new URL(seriesData.cover_image_url, 'https://cherrymist.cafe').href;
        } catch (_) {
          coverUrl = seriesData.cover_image_url;
        }
      }

      const author = seriesData ? (seriesData.author_name || seriesData.original_author || '').trim() : '';
      const title = seriesData && seriesData.title ? seriesData.title.trim() : '';
      const synopsis = seriesData && seriesData.synopsis ? seriesData.synopsis.trim() : '';
      let genres = [];
      if (seriesData && seriesData.genres) {
        genres = Array.isArray(seriesData.genres)
          ? seriesData.genres
          : String(seriesData.genres).split(',').map(g => g.trim()).filter(Boolean);
      }

      return {
        flat,
        title,
        author,
        coverUrl,
        synopsis,
        genres
      };
    } catch (err) {
      console.error('[AgnesDigital] Erro no handler Cherrymist:', err);
      return null;
    }
  };
}

/** Cria handler para Cherry Mist / Fictioneer — links com /chapter/ */
function createHandlerFictioneer() {
  return async () => {
    const chapters = [];
    const seenUrls = new Set();

    // 1. Tenta desdobrar capítulos ocultos no DOM atual clicando nos botões "Show X more"
    document.querySelectorAll('.chapter-group__folding-toggle').forEach(btn => {
      try { btn.click(); } catch (e) {}
    });
    await new Promise(r => setTimeout(r, 100)); // Aguarda renderização

    // 2. Coleta capítulos do DOM (agora possivelmente desdobrado)
    const extrairDoDom = (context) => {
      context.querySelectorAll('a[href*="/chapter/"]').forEach(a => {
        if (a.href.includes('#comment')) return;
        const href = a.href.split('#')[0].split('?')[0];
        if (!seenUrls.has(href) && !isNavigationLink(href) && !href.includes('fictioneer-logout')) {
          seenUrls.add(href);
          chapters.push({ title: extractCleanTitleFromLink(a), url: href });
        }
      });
    };

    extrairDoDom(document);

    // 3. Fallback: Se ainda faltarem capítulos, tenta buscar o HTML original via fetch
    // (O JS do Fictioneer pode deletar elementos do DOM, o fetch pega o código puro, se o Cloudflare deixar)
    try {
      const res = await fetch(window.location.href);
      if (res.ok) {
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        extrairDoDom(doc);
      }
    } catch (e) {
      console.warn('Fictioneer fallback HTML original falhou (Cloudflare?). Usando apenas DOM.');
    }

    return chapters.length > 0 ? { chapters: chapters, structuredChapters: null } : null;
  };
}

/** Cria handler Super Parser para BotiTranslation / Mystorywave API (Ignorando DOM) */
function createHandlerMystorywave() {
  return async () => {
    try {
      const match = window.location.pathname.match(/\/book\/(\d+)/);
      if (!match) return null;
      
      const bookid = match[1];
      const apiUrl = `https://api.mystorywave.com/story-wave-backend/api/v1/content/chapters/page?sortDirection=ASC&bookId=${bookid}&pageNumber=1&pageSize=`;
      
      // Busca primeira página para descobrir o TotalCount
      let res = await fetch(apiUrl + '100');
      let data = await res.json();
      
      const totalCount = data.data.totalCount;
      if (totalCount > 100) {
          res = await fetch(apiUrl + totalCount);
          data = await res.json();
      }
      
      const domain = window.location.origin;
      const chapters = data.data.list.map(a => ({
          title: a.title,
          url: `${domain}/chapter/${a.id}`,
          locked: (a.paywallStatus !== "free" || a.tier > 0)
      })).filter(c => !c.locked); // Extrai apenas capítulos grátis por enquanto
      
      return chapters.length > 0 ? { chapters: chapters, structuredChapters: null } : null;
    } catch (e) {
      console.error('[AgnesDigital] Falha no Super Parser Mystorywave:', e);
      return null;
    }
  };
}

/** Cria handler para BotiTranslation (WordPress Madara com AJAX) */
function createHandlerMadara() {
  return async () => {
    try {
      const mangaIdEl = document.querySelector('.wp-manga-action-button');
      const mangaId = mangaIdEl?.getAttribute('data-post');
      if (!mangaId) return null;

      const formData = new URLSearchParams();
      formData.append('action', 'manga_get_chapters');
      formData.append('manga', mangaId);

      const res = await fetch('/wp-admin/admin-ajax.php', { method: 'POST', body: formData });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      const chapters = [];
      doc.querySelectorAll('li.wp-manga-chapter a').forEach(a => {
        chapters.push({ title: a.textContent.trim(), url: a.href });
      });

      // Madara geralmente list capítulos em ordem decrescente
      chapters.reverse();
      return chapters.length > 0 ? { chapters: chapters, structuredChapters: null } : null;
    } catch (_e) {
      return null;
    }
  };
}

/** Cria handler para Woopread / BCA Translation (selectors WP-Manga) */
function createHandlerWpManga() {
  return async () => {
    const chapters = [];
    document.querySelectorAll('.wp-manga-chapter a, .lcp_catlist li a, #chapters a').forEach(a => {
      chapters.push({ title: a.textContent.trim(), url: a.href });
    });

    // Temas Madara listam capítulos em ordem decrescente
    if (document.querySelector('.wp-manga-chapter')) chapters.reverse();
    return chapters.length > 0 ? { chapters: chapters, structuredChapters: null } : null;
  };
}

/** Cria handler para Weebsread (plataforma Blogger) */
function createHandlerBlogger() {
  return async () => {
    const chapters = [];
    document.querySelectorAll('.post-body a').forEach(a => {
      if (!a.href.includes('/search/label/') && !a.href.includes('/archive')) {
        chapters.push({ title: a.textContent.trim() || a.href, url: a.href });
      }
    });
    return chapters.length > 0 ? { chapters: chapters, structuredChapters: null } : null;
  };
}

/** Cria handler para Novema (plataforma japonesa) */
function createHandlerNovema() {
  return async () => {
    const chapters = [];
    document.querySelectorAll('ul.c-partList__list a, .episode-list a').forEach(a => {
      chapters.push({ title: a.textContent.trim(), url: a.href });
    });
    return chapters.length > 0 ? { chapters: chapters, structuredChapters: null } : null;
  };
}

/** Cria handler para sites com API paginada (NovelFire, NovelArrow, Lorepress) */
function createHandlerPaginatedApi(hostname) {
  return async () => {
    const chapters = [];
    let apiUrl = '';

    // Tenta detectar a URL da API nativa
    if (hostname.includes('novelfire.net') || hostname.includes('novelarrow.com')) {
      const novelId = document.querySelector('[data-novel-id]')?.getAttribute('data-novel-id');
      if (novelId) apiUrl = `/ajax/chapter-archive?novelId=${novelId}`;
    }

    if (apiUrl) {
      try {
        const res = await fetch(apiUrl);
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('ul.chapter-list a, .chapter-item a').forEach(a => {
          chapters.push({ title: a.getAttribute('title') || a.textContent.trim(), url: a.href });
        });
        if (chapters.length > 0) return { chapters: chapters, structuredChapters: null };
      } catch (_e) {}
    }

    // Fallback: selectors genéricos no DOM
    document.querySelectorAll('.chapter-list a, .chp-item a, ul.chapters a').forEach(a => {
      chapters.push({ title: a.textContent.trim(), url: a.href });
    });
    return chapters.length > 0 ? { chapters: chapters, structuredChapters: null } : null;
  };
}

/** Cria handler para NovelFull e derivados — AJAX + paginação */
function createHandlerNovelFull() {
  return async () => {
    const list = [];

    // Passo 1: Busca o novel ID para carregar capítulos via AJAX
    let novelId = document.querySelector('#rating[data-novel-id], [data-novel-id], input#novelId')
      ?.getAttribute('data-novel-id');

    if (!novelId) {
      const match = document.documentElement.innerHTML.match(/novelId\s*=\s*['"]?(\d+)['"]?/i) ||
                    document.documentElement.innerHTML.match(/data-novel-id=['"](\d+)['"]/i);
      if (match) novelId = match[1];
    }

    // Tenta endpoints AJAX
    if (novelId) {
      const endpoints = [
        `/ajax/chapter-archive?novelId=${novelId}`,
        `/ajax-chapter-archive?novelId=${novelId}`,
        `/ajax-chapter-option?novelId=${novelId}`
      ];

      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint);
          if (!res.ok) continue;

          const html = await res.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          doc.querySelectorAll('.list-chapter a, ul.list-chapter a, .panel-body a, select option, a[href]').forEach(el => {
            if (el.tagName === 'OPTION') {
              const val = el.value || el.getAttribute('value');
              if (val) {
                const url = val.startsWith('http') ? val : new URL(val, window.location.origin).href;
                list.push({ title: el.textContent.trim(), url });
              }
            } else if (el.href && !isNavigationLink(el.href)) {
              list.push({ title: el.textContent.trim() || 'Chapter', url: el.href });
            }
          });

          if (list.length > 0) return list;
        } catch (_e) {}
      }
    }

    // Passo 2: Seletores DOM diretos
    const seletoresDOM = [
      '#list-chapter .list-chapter li a', '#list-chapter a', '.list-chapter a',
      'ul.list-chapter a', '#tab-chapters a', '.row-content-chapter a', '.chapter-chs a'
    ];

    for (const sel of seletoresDOM) {
      const matches = document.querySelectorAll(sel);
      if (matches.length > 0) {
        matches.forEach(a => {
          if (a.href && !isNavigationLink(a.href)) {
            list.push({ title: extractCleanTitleFromLink(a), url: a.href });
          }
        });
        if (list.length > 0) break;
      }
    }

    // Passo 3: Busca capítulos em páginas subsequentes (paginação)
    if (list.length > 0) {
      await fetchSubsequentPages(list);
    }

    return list;
  };
}

/**
 * Busca capítulos em páginas de paginação subsequentes (até 10 páginas).
 *
 * @param {Array} list - Array of chapters to add the results to
 */
async function fetchSubsequentPages(list) {
  const paginationLinks = document.querySelectorAll('ul.pagination li a:not(.disabled), .pagination a');
  const pageURLs = new Set();

  paginationLinks.forEach(a => {
    if (a.href && !a.href.includes('javascript:') && a.href !== window.location.href) {
      pageURLs.add(a.href);
    }
  });

  const pages = Array.from(pageURLs).slice(0, 10);
  for (const urlPage of pages) {
    try {
      const res = await fetch(urlPage);
      if (!res.ok) continue;

      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('#list-chapter a, .list-chapter a, ul.list-chapter a').forEach(a => {
        if (a.href && !isNavigationLink(a.href)) {
          list.push({ title: extractCleanTitleFromLink(a), url: a.href });
        }
      });
    } catch (_e) {}
  }
}

/** Cria handler para StorySeedling */
function createHandlerStorySeedling() {
  return async () => {
    const list = [];

    const selectors = [
      '[x-data*="toc"] a[href*="/series/"]', '[x-data*="toc"] ul a',
      'section a[href*="/series/"][href*="/v"]', 'section a[href*="/series/"][href*="/chapter"]',
      'ul.grid a[href*="/series/"]', '#chapters a', '.table-of-contents a'
    ];

    for (const sel of selectors) {
      const matches = document.querySelectorAll(sel);
      if (matches.length > 0) {
        matches.forEach(a => {
          if (a.href && !isNavigationLink(a.href) && a.href !== window.location.href) {
            list.push({ title: extractCleanTitleFromLink(a), url: a.href });
          }
        });
        if (list.length > 0) break;
      }
    }

    // Fallback: busca links que estendem o path da série atual
    if (list.length === 0) {
      const seriesPath = window.location.pathname.replace(/\/$/, '');
      document.querySelectorAll(`a[href*="${seriesPath}/"]`).forEach(a => {
        if (a.href && a.href !== window.location.href && !isNavigationLink(a.href)) {
          list.push({ title: extractCleanTitleFromLink(a), url: a.href });
        }
      });
    }

    return list;
  };
}

/** Cria handler para Royal Road */
function createHandlerRoyalRoad() {
  return async () => {
    const list = [];
    document.querySelectorAll('table#chapters tbody tr td:first-child a, .chapter-row a, #chapters a').forEach(a => {
      if (a.href && !isNavigationLink(a.href)) {
        list.push({ title: a.textContent.trim(), url: a.href });
      }
    });
    return list;
  };
}

/** Cria handler para Scribble Hub */
function createHandlerScribbleHub() {
  return async () => {
    const list = [];
    document.querySelectorAll('.wi_fic_table .toc_ol a, #main_story a, .toc_ol a, .chapter-title a').forEach(a => {
      if (a.href && !isNavigationLink(a.href)) {
        list.push({ title: a.textContent.trim(), url: a.href });
      }
    });
    return list;
  };
}

/** Cria handler para LightNovelPub / LightNovelWorld */
function createHandlerLightNovelPub() {
  return async () => {
    const list = [];
    document.querySelectorAll('.chapter-list a, ul.chapter-list a, .chapter-list li a').forEach(a => {
      if (a.href && !isNavigationLink(a.href)) {
        list.push({ title: a.textContent.trim(), url: a.href });
      }
    });
    return list;
  };
}

/** Cria handler para BoxNovel (tema WP-Manga) */
function createHandlerBoxNovel() {
  return async () => {
    const list = [];
    document.querySelectorAll('.wp-manga-chapter a, .version-chap a, .chapter-link a').forEach(a => {
      if (a.href && !isNavigationLink(a.href)) {
        list.push({ title: a.textContent.trim(), url: a.href });
      }
    });
    return list;
  };
}

// ── ESTRATÉGIA 2: SELETORES DE ALTA CONFIANÇA ──

/**
 * Escaneia o DOM usando uma list curada de selectors CSS que são
 * amplamente utilizados em sites de novels para listar capítulos.
 *
 * @returns {Array} Lista de capítulos matches
 */
function scanHighConfidenceSelectors(doc = document) {
  const selectors = [
    // WordPress Manga / Novel plugins
    '.wp-manga-chapter a', '.listing-chapters_wrap a', 'ul.sub-chap a', '.version-chap a',
    // Containers TOC padrão
    '#list-chapter a', '.list-chapter a', '.chapter-list a', 'ul.chapter-list a',
    'ol.chapter-list a', '#chapter-list a', '.chapters-list a', '#chapters a',
    '.chapters a', '#toc a', '.toc a', '.table-of-contents a', 'table.table-chapter-list a',
    // WebNovel / Qidian
    'ol.content-list a', '.volume-item a', '.j_catalog_list a', '.catalog-list a',
    // NovelBin, NovelBuddy, FreeWebNovel
    '.chapter-chs a', '.m-newest2 a', '.row-content-chapter a', '#tab-chapters a',
    '.manga-chapters a', '.box-chapters a', '.list-chapters a', '.chapter-group__list-item-link'
  ];

  const chapterMap = new Map();

  for (const sel of selectors) {
    try {
      const matches = doc.querySelectorAll(sel);
      if (matches.length > 0) {
        matches.forEach(a => {
          if (isValidChapterLink(a) && !chapterMap.has(a.href)) {
            chapterMap.set(a.href, { title: extractCleanTitleFromLink(a), url: a.href });
          }
        });
        if (chapterMap.size >= 3) break; // Lista sólida encontrada
      }
    } catch (_e) {}
  }

  return Array.from(chapterMap.values());
}

// ── ESTRATÉGIA 3: INSPEÇÃO DE FRAMEWORKS ──

/**
 * @returns {Array<{title: string, url: string}>} Extracted chapter list
 */
function scanFrameworkData() {
  const chapters = [];

  try {
    // Inspect Alpine.js components containing x-data
    const alpineElements = document.querySelectorAll('[x-data]');

    for (const el of alpineElements) {
      const dataStack = el._x_dataStack ||
        (window.Alpine?.$data ? [window.Alpine.$data(el)] : []);

      for (const state of dataStack) {
        const items = state.items || state.chapters || state.releases || state.chapterList;
        if (!Array.isArray(items) || items.length === 0) continue;

        items.forEach(item => {
          const url = item.url || item.link || item.href;
          const title = item.title || item.name || item.chapterName || `Chapter ${item.index ?? item.number ?? ''}`;

          if (url) {
            const fullUrl = new URL(url, window.location.href).href;
            chapters.push({ title: String(title).trim(), url: fullUrl });
          }
        });

        if (chapters.length > 0) return chapters;
      }
    }
  } catch (error) {
    console.warn('[AgnesDigital] Framework inspection error:', error);
  }

  return chapters;
}

// ── ESTRATÉGIA 4: CLUSTERING HEURÍSTICO DE LINKS ──

/**
 * Agrupa links do DOM por elemento father em comum (cluster) e seleciona
 * o cluster com mais links válidos de capítulo.
 *
 * @returns {Array} Lista de capítulos do maior cluster encontrado
 */
function scanLinkCluster(doc = document) {
  const allLinks = Array.from(doc.querySelectorAll('a[href]'));
  const clusters = new Map();

  for (const a of allLinks) {
    if (!isValidChapterLink(a)) continue;

    // Agrupa pelo father ou avô
    const father = a.parentElement;
    let grouper = father;
    if (father?.tagName === 'LI' || father?.tagName === 'P' || father?.tagName === 'H2' || father?.tagName === 'H3' || father?.tagName === 'H4' || father?.tagName === 'DIV') {
      grouper = father.parentElement;
    }
    if (!grouper) continue;

    if (!clusters.has(grouper)) clusters.set(grouper, []);
    clusters.get(grouper).push(a);
  }

  // Encontra o melhor cluster (Score = Quantidade + density de Regex)
  let bestCluster = [];
  let maxScore = -1;

  const regexChapter = /cap[íi]tulo|chapter|ep\s*\d+|ch\s*\d+|\b\d{1,4}\b/i;

  for (const [, links] of clusters.entries()) {
    let score = links.length;

    let chapterMatches = 0;
    links.forEach(a => {
      if (regexChapter.test(a.textContent)) chapterMatches++;
    });

    const density = chapterMatches / links.length;
    
    // Penalidade severa se não parece ser uma list de capítulos e for um widget enorme
    if (density < 0.1) {
      score = score * 0.1;
    } else if (density > 0.5) {
      score = score * 2; // Bônus se a maioria obedece a regex
    }

    if (score > maxScore) {
      maxScore = score;
      bestCluster = links;
    }
  }

  if (bestCluster.length < 3) return [];

  const chapterMap = new Map();
  bestCluster.forEach(a => {
    if (!chapterMap.has(a.href)) {
      chapterMap.set(a.href, { title: extractCleanTitleFromLink(a), url: a.href });
    }
  });

  return Array.from(chapterMap.values());
}

// ── ESTRATÉGIA 5: MATCHER DE PADRÕES DE URL ──

/**
 * @returns {Array} Lista de capítulos baseada em padrões de URL
 */
function scanUrlPatterns() {
  const allLinks = document.querySelectorAll('a[href]');
  const chapterMap = new Map();

  const regexChapter = /(chapter|capitulo|capítulo|ep[-_]?\d+|ch[-_]?\d+|\/c\d+|\/v\d+\/\d+|\/read\/|\/p\/\d+)/i;

  for (const a of allLinks) {
    if (!isValidChapterLink(a)) continue;

    const url = a.href;
    const text = a.textContent.trim();
    const isChapterLink = regexChapter.test(url) || (/\d+/.test(text) && regexChapter.test(text));

    if (isChapterLink && !chapterMap.has(url)) {
      chapterMap.set(url, { title: extractCleanTitleFromLink(a), url });
    }
  }

  return Array.from(chapterMap.values());
}

// ── EXTRATORES DE METADADOS ──

/**
 * Extrai o título da novel usando metadados OG, tags H1 e selectors específicos.
 *
 * @param {string} _hostname - Hostname (não utilizado atualmente, reservado)
 * @returns {string} Título limpo da novel
 */
function extractTitle(hostname) {
  // ── Prioridade 0: Handlers específicos para sites com estruturas peculiares ──
  if (hostname && hostname.includes('archiveofourown.org')) {
    const ao3Title = document.querySelector('#workskin .title.heading, .preface .title.heading, h2.title.heading');
    if (ao3Title && ao3Title.textContent.trim()) {
      return ao3Title.textContent.trim();
    }
  }

  if (hostname && hostname.includes('webnovel.com')) {
    const wnTitle = document.querySelector('.det-hd-detail h1, .book-info h1, h1.pt4, h1.font-bold');
    if (wnTitle && wnTitle.textContent.trim()) {
      return wnTitle.textContent.trim();
    }
  }

  // ── Prioridade 1: Schema JSON-LD (SEO canônico — mais confiável) ──
  try {
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of ldScripts) {
      try {
        const data = JSON.parse(script.textContent);
        const name = data.name || data.headline || (Array.isArray(data) && data[0]?.name);
        if (name && name.length > 2 && name.length < 200) return String(name).trim();
      } catch (_e) {}
    }
  } catch (_e) {}

  // ── Prioridade 2: Seletores DOM específicos (h1, h2 e meta antes de h3) ──
  // Nota: 'h3.title' foi removido propositalmente — em sites como AO3, 'h3.title'
  // é a tag de cada capítulo individual, o que causava o título do capítulo substituir o livro.
  const selectors = [
    'h1.manga-title', '.manga-title', '.post-title h1', '.post-title', '.novel-title', '.series-title',
    '.book-title', '.book-name', 'h1[property="name"]', '.fic-title h1', '.rate-title',
    'h1.font-bold', 'h1.pt4', 'h1.tit',
    'meta[property="og:title"]', 'meta[name="twitter:title"]',
    'h1', 'h2', 'h3.fic-title'
  ];

  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        const valor = el.tagName === 'META' ? el.content : el.textContent;
        const cleanText = valor?.replace(/Novel$|Manga$|Read/i, '').trim();
        if (cleanText && cleanText.length > 2 && cleanText.length < 150) {
          return cleanText;
        }
      }
    } catch (_e) {}
  }
  return document.title.split('-')[0].trim() || 'Novel Desconhecida';
}

/**
 * Remove sufixos de nomes de sites e prefixos genéricos do título da novel.
 *
 * @param {string} raw - Título raw extraído
 * @returns {string} Título limpo
 */
function cleanNovelTitle(raw) {
  return raw
    .replace(/\s*[-–|•]\s*(Story Seedling|NovelFull|Webnovel|Royal Road|Scribble Hub|Light Novel Pub|Read Novel Full|Fenrir Realm).*$/i, '')
    .replace(/\s*[-–|•]\s*Read (Online|Light Novel|Web Novel).*$/i, '')
    .replace(/\s*[-–|]\s*[A-Za-z0-9\s]+(?:Novel|Translations|Scans)\s*$/i, '')
    .replace(/^\s*Read\s+/i, '')
    .trim();
}

/**
 * Extrai o nome do author da novel.
 *
 * @param {string} hostname - Hostname
 * @returns {string} Nome do author ou 'Unknown Author'
 */
function extractAuthor(hostname) {
  // ── Prioridade 0: Handlers específicos por site ──
  if (hostname && hostname.includes('archiveofourown.org')) {
    const ao3Author = document.querySelector('#workskin .byline.heading a[rel="author"], .preface .byline.heading a[rel="author"], a[rel="author"]');
    if (ao3Author && ao3Author.textContent.trim()) {
      return ao3Author.textContent.trim();
    }
  }

  if (hostname && hostname.includes('webnovel.com')) {
    const wnAuthor = document.querySelector('.det-hd-detail address a, .det-hd-detail address span, .author-name, .author a');
    if (wnAuthor && wnAuthor.textContent.trim()) {
      const cleanWn = wnAuthor.textContent.trim().replace(/(?:Translator|Editor|Tradutor|Revisor)\s*:.*$/i, '').trim();
      if (cleanWn.length > 1) return cleanWn;
    }
  }

  // ── Prioridade 1: JSON-LD ──
  try {
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of ldScripts) {
      try {
        const data = JSON.parse(script.textContent);
        const author = data.author?.name || (Array.isArray(data.author) && data.author[0]?.name);
        if (author && author.length > 1 && author.length < 80) {
          return String(author).trim().replace(/(?:Translator|Editor|Tradutor|Revisor)\s*:.*$/i, '').trim();
        }
      } catch (_e) {}
    }
  } catch (_e) {}

  // ── Prioridade 2: Seletores DOM ──
  // Nota: ':contains()' foi removido — é pseudo-seletor jQuery e lança DOMException
  // no querySelector nativo. Substituído por busca textual na seção de fallback.
  const selectors = [
    'a[rel="author"]', '.author-content a', '.manga-author a', '.novel-author a', 'a[href*="/author/"]', 'a[href*="/manga-author/"]',
    '.info a[href*="author"]', 'a[href*="/user/"]', 'span[itemprop="author"]', 'h4 span[property="name"] a',
    'meta[property="books:author"]', 'meta[name="author"]',
    '.det-hd-detail address a', 'h2.author-name', '.author-name', '.author'
  ];

  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        const valor = el.tagName === 'META' ? el.content : el.textContent;
        const text = valor?.trim().replace(/(?:Translator|Editor|Tradutor|Revisor)\s*:.*$/i, '').trim();
        if (text && text.length > 2 && text.length < 80) return text;
      }
    } catch (_e) {}
  }

  // ── Fallback textual: busca "Author:" no texto da página ──
  const bodyText = document.body?.innerText || '';
  const authorMatch = bodyText.match(/(?:Author|Autor)\s*[:\-]\s*([^\n\r,]{2,60})/i);
  if (authorMatch) return authorMatch[1].trim();

  return 'Autor Desconhecido';
}

/**
 * Extrai a URL da imagem de capa da novel.
 *
 * @param {string} _hostname - Hostname
 * @returns {string} URL da capa ou string vazia
 */
function extractCover(_hostname) {
  const selectors = [
    'meta[property="og:image"]', 'meta[name="twitter:image"]',
    '.series-cover img', '.book img', '.det-hd-media img', '.g_thumb img',
    '.book-img img', '.novel-cover img', 'img.cover', '.summary_image img',
    '.fic-header img', '.aspect-w-3 img', 'img[alt*="cover" i]',
    '.cover-container img', '.book-cover img'
  ];

  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        // Suporte a lazy-loading: data-src, data-lazy-src, data-original têm prioridade sobre src vazio
        const src = el.tagName === 'META'
          ? el.content
          : (el.dataset.lazySrc || el.dataset.src || el.dataset.original || el.src);
        if (src?.startsWith('http')) return src;
      }
    } catch (_e) {}
  }

  return '';
}

/**
 * Extrai a synopsis/descrição da novel.
 *
 * @param {string} _hostname - Hostname
 * @returns {string} Sinopse (até 2000 caracteres) ou string vazia
 */
function extractSynopsis(_hostname) {
  const selectors = [
    'meta[property="og:description"]', 'meta[name="description"]',
    'meta[name="twitter:description"]', '.summary__content p', '.summary__content',
    '.description', '.novel-desc', '#editdescription', '.summary_content p',
    '.summary_content', '.synp p', '.novel-summary p', '.series-synops',
    '.series-summary', '.fic-desc p', '.desc', '[itemprop="description"]',
    '#about-panel.synopsis', '#about-panel', '.synopsis', '#synopsis', '.book-synopsis'
  ];

  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        const valor = el.tagName === 'META' ? el.content : el.textContent;
        if (valor?.trim().length > 20) {
          return valor.trim().replace(/\s+/g, ' ').substring(0, 2000);
        }
      }
    } catch (_e) {}
  }

  return '';
}

/**
 * Extrai os gêneros/tags da novel.
 *
 * @param {string} _hostname - Hostname
 * @returns {Array<string>} Lista de gêneros (até 20)
 */
function extractGenres(_hostname) {
  const wrappers = document.querySelectorAll('.novel-info, .post-content, .summary_content, .fictioneer-story, .manga-info, .summary-content, .profile-manga, .tab-summary, main, article');
  
  const selectors = [
    '.genres a', '.tags a', 'a[rel="tag"]', '.novel-info .genre a', 'a[href*="/genre/"]',
    '.post-content_item a[href*="/novel-genre/"]', '.fic-genres a',
    '.tag-list a', '.novel-tags a', '.info a[href*="/tag/"]',
    '.story_tags a', '.fiction-tags a', 'a[href*="/category/"]'
  ];

  const genres = new Set();
  const trash = ['rss', 'previous', 'next', 'home', 'page', 'admin'];

  const slugToTitle = (slug) => {
    return slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  const processElement = (el) => {
    let text = el.textContent.trim();
    
    try {
      const url = new URL(el.href, window.location.href);
      if (url.pathname.includes('/genre/') || url.pathname.includes('/tag/') || url.pathname.includes('/category/') || url.searchParams.has('genre') || url.searchParams.has('tag')) {
        const parts = url.pathname.split('/').filter(Boolean);
        let slug = parts[parts.length - 1];
        if (url.searchParams.has('genre')) slug = url.searchParams.get('genre');
        else if (url.searchParams.has('tag')) slug = url.searchParams.get('tag');
        
        if (slug && slug.toLowerCase() !== 'genre' && slug.toLowerCase() !== 'tag' && slug.toLowerCase() !== 'category') {
           text = slugToTitle(slug);
        }
      }
    } catch(e) {}

    if (text.length > 1 && text.length < 30) {
      if (!trash.some(l => text.toLowerCase().includes(l))) {
        genres.add(text);
      }
    }
  };

  if (wrappers.length > 0) {
    for (const wrapper of wrappers) {
      for (const sel of selectors) {
        try {
          wrapper.querySelectorAll(sel).forEach(processElement);
          if (genres.size > 0) break;
        } catch (_e) {}
      }
      if (genres.size > 0) break;
    }
  }

  if (genres.size === 0) {
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach(processElement);
        if (genres.size > 0) break;
      } catch (_e) {}
    }
  }

  return Array.from(genres).slice(0, 15);
}

/**
 * Detecta o status da novel (ongoing, completed, unknown).
 *
 * @param {string} _hostname - Hostname
 * @returns {string} 'completed', 'ongoing' ou 'unknown'
 */
function extractStatus(_hostname) {
  // ── Seletores sem :contains (que lança DOMException no Chrome) ──
  const statusSelectors = [
    '.novel-info .status', '.info-status', '.novel-status',
    '.story-status', '.half_content .status', '.post-content_item .status'
  ];

  for (const sel of statusSelectors) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        const text = el.textContent.toLowerCase();
        if (/complet|finished|ended|tamat/i.test(text))   return 'completed';
        if (/ongoing|active|publishing|releasing|em andamento/i.test(text)) return 'ongoing';
      }
    } catch (_e) {}
  }

  // ── Fallback: busca em elementos dt/dd (sem :contains) ──
  document.querySelectorAll('dt, .info-item-head, .post-content_item h5').forEach(dt => {
    if (/status/i.test(dt.textContent)) {
      const dd = dt.nextElementSibling;
      if (dd) {
        const t = dd.textContent.toLowerCase();
        if (/complet|finish/i.test(t))        window.__statusDetected = 'completed';
        else if (/ongoing|active/i.test(t))   window.__statusDetected = 'ongoing';
      }
    }
  });
  if (window.__statusDetected) {
    const s = window.__statusDetected;
    delete window.__statusDetected;
    return s;
  }

  // ── Último fallback: regex no texto da página ──
  const textPage = document.body?.innerText || '';
  const match = textPage.match(/Status\s*[:\-]?\s*(Ongoing|Completed|Finished|Active|Hiatus|Dropped|Cancelled)/i);
  if (match) {
    const s = match[1].toLowerCase();
    if (/complet|finish/i.test(s)) return 'completed';
    if (/ongoing|active/i.test(s)) return 'ongoing';
  }

  return 'unknown';
}

// ── EXTRATORES DE METADADOS DE FANFIC (AO3, FF.net) ──

/** Extrai o fandom da fanfic (AO3 e FanFiction.net) */
function extractFandom(hostname) {
  if (hostname.includes('archiveofourown.org')) {
    return document.querySelector('.fandom.tags a')?.textContent.trim() || null;
  }
  if (hostname.includes('fanfiction.net')) {
    return document.querySelector('#pre_story_links a:last-child')?.textContent.trim() || null;
  }
  return null;
}

/** Extrai os warnings/warnings da fanfic (apenas AO3) */
function extractWarnings(hostname) {
  if (hostname.includes('archiveofourown.org')) {
    return Array.from(document.querySelectorAll('dd.warning.tags a, dd.warning.tags .tag'))
      .map(el => el.textContent.trim());
  }
  return [];
}

/** Extrai os relationships/casais da fanfic (apenas AO3) */
function extractRelationships(hostname) {
  if (hostname.includes('archiveofourown.org')) {
    return Array.from(document.querySelectorAll('dd.relationship.tags a, dd.relationship.tags .tag'))
      .map(el => el.textContent.trim());
  }
  return [];
}

/** Extrai a classificação indicativa (AO3 e FanFiction.net) */
function extractRating(hostname) {
  if (hostname.includes('archiveofourown.org')) {
    return document.querySelector('dd.rating.tags a, dd.rating.tags .tag')?.textContent.trim() || null;
  }
  if (hostname.includes('fanfiction.net')) {
    const txt = document.querySelector('.xgray.xcontrast_txt');
    if (txt) {
      const match = txt.textContent.match(/Rated:\s*(.+?)\s*-/);
      return match ? match[1].trim() : null;
    }
  }
  return null;
}

// ── UTILITÁRIOS DE VALIDAÇÃO E LIMPEZA ──

/**
 * Verifica se um link é um link válido de capítulo (não é navegação,
 * não é a página atual, não é javascript:, etc.)
 *
 * @param {HTMLAnchorElement} a - Elemento <a> a verificar
 * @returns {boolean} true se for um link de capítulo válido
 */
function isValidChapterLink(a) {
  if (!a?.href) return false;
  const href = a.href.trim();

  if (href === '' || href === '#' || href.startsWith('javascript:') ||
      href.startsWith('mailto:') || href.startsWith('tel:')) {
    return false;
  }

  // Descarta se for a mesma página atual
  const hrefClean = href.split('#')[0].replace(/\/$/, '');
  const currentClean = window.location.href.split('#')[0].replace(/\/$/, '');
  if (hrefClean === currentClean) return false;

  return !isNavigationLink(href);
}

/**
 * Verifica se uma URL pertence a uma seção de navegação ou recurso estático.
 *
 * @param {string} url - URL a verificar
 * @returns {boolean} true se for um link de navegação/recurso
 */
function isNavigationLink(url) {
  const navigationPatterns = [
    /\/(login|register|signup|signin|logout|user|account|profile|settings|faq|about|contact|privacy|terms|search|browse|ranking|popular|latest|donate|discord|recruitment)/i,
    /\/(css|js|img|images|assets|static|fonts|media|wp-content|wp-includes)\//i,
    /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|webp)(\?|$)/i,
    /(discord\.gg|twitter\.com|facebook\.com|reddit\.com|patreon\.com|ko-fi\.com|paypal\.com)/i
  ];

  return navigationPatterns.some(p => p.test(url));
}

// ── LIMPEZA DE TÍTULOS DE CAPÍTULOS ──

/** Padrões de ruído configuráveis para remoção dos títulos de capítulos */
const TITLE_NOISE_PATTERNS = [
  // Datas no final: "June 21, 2026", "2024-01-15"
  /\s*\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s*\d{2,4}\s*$/i,
  /\s*\d{4}[-\/]\d{2}[-\/]\d{2}\s*$/,
  // Contadores de visualização: "(5.2k views)"
  /\s*[\(\[]?\d[\d,.]*k?\s*(?:views?|leituras?)[\)\]]?\s*$/i,
  // Ícones de cadeado/premium
  /\s*[🔒🔐💎⭐🌟👑]\s*$/,
  // Marcas d'água de sites
  /\s*[-–|•]\s*(NovelFull|Webnovel|Royal Road|Scribble Hub|Light Novel Pub|BoxNovel|ReadNovelFull|FreeWebNovel|NovelBin|NovelBuddy).*$/i,
  // Badges "NEW" / "HOT" / "FREE"
  /\s*[\(\[]?\s*(?:NEW|HOT|FREE|PREMIUM|VIP|LOCKED)\s*[\)\]]?\s*$/i,
  // Separadores no início e final
  /^\s*[-–—:]\s*/,
  /\s*[-–—:]\s*$/
];

/**
 * Extrai e limpa o título de um link de capítulo, removendo
 * datas, contadores de views, badges e outros ruídos.
 *
 * @param {HTMLAnchorElement} linkElement - Elemento <a> do capítulo
 * @returns {string} Título limpo do capítulo
 */
function extractCleanTitleFromLink(linkElement) {
  const span = linkElement.querySelector('.chapter-text, .name, .chapter-title, .title, span');
  let title = span?.textContent.trim() || linkElement.title || linkElement.textContent.trim();

  if (!title) return 'Capítulo Sem Título';

  // Limpa ruído básico: quebras de linha, tabs, espaços múltiplos
  title = title.replace(/[\n\r\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // Aplica cada padrão de ruído configurável
  for (const pattern of TITLE_NOISE_PATTERNS) {
    title = title.replace(pattern, '');
  }

  return title.trim() || 'Capítulo Sem Título';
}

/**
 * Deduplicaa e sanitiza uma list de capítulos, removendo entradas
 * duplicadas (por URL normalizada) e capítulos sem URL.
 *
 * @param {Array} chapters - Lista bruta de capítulos
 * @returns {Array} Lista limpa e deduplicada
 */
function sanitizeChapterList(chapters) {
  if (!Array.isArray(chapters)) return [];

  const seenUrls = new Set();
  let cleanList = [];

  for (const cap of chapters) {
    if (!cap?.url) continue;
    const normalizedUrl = cap.url.split('#')[0].trim();

    if (!seenUrls.has(normalizedUrl)) {
      seenUrls.add(normalizedUrl);
      cleanList.push({
        title: cap.title || `Chapter ${cleanList.length + 1}`,
        url: normalizedUrl
      });
    }
  }

  // Ordenação Inteligente: Checa se a ordem está decrescente (ex: Madara Themes)
  if (cleanList.length > 2) {
    const parseChapterNum = (text) => {
      const match = text.match(/(?:cap[íi]tulo|chapter|ch|ep|epis[óo]dio)\s*[\.\-]?\s*(\d+(?:\.\d+)?)/i) || text.match(/\b(\d+)\b/);
      return match ? parseFloat(match[1]) : null;
    };

    const firstNum = parseChapterNum(cleanList[0].title);
    const midNum = parseChapterNum(cleanList[Math.floor(cleanList.length / 2)].title);
    const lastNum = parseChapterNum(cleanList[cleanList.length - 1].title);

    // Se o primeiro for maior que o último e o meio for consistente com decrescente
    if (firstNum !== null && lastNum !== null && firstNum > lastNum) {
      if (midNum === null || (firstNum > midNum && midNum > lastNum)) {
        console.log(`[AgnesDigital] Ordem decrescente detectada (${firstNum} -> ${lastNum}). Invertendo automaticamente.`);
        cleanList.reverse();
      }
    }
  }

  return cleanList;
}

// ── MOTOR DE DEOBFUSCAÇÃO DE FONTES / text ──
/**
 * Remove trash injetado via CSS e text invisível (Font Obfuscation leve e Anti-Scrape).
 * O Readability.js geralmente é enganado por spans com { display: none } ou { opacity: 0 }.
 * @param {Element} node - Nó de conteúdo a ser limpo
 */
function decodeObfuscatedText(node) {
  if (!node) return;

  // Acumula todos os elementos a remover ANTES de remover qualquer um.
  // Remover inline dentro do forEach causa Layout Thrashing: o browser
  // recalcula o layout a cada remove(), O(n²) em páginas grandes.
  const toRemove = [];

  node.querySelectorAll('span, div, p, font').forEach(el => {
    const style = window.getComputedStyle(el);

    // ── Detecção via propriedades CSS ──
    if (
      style.display    === 'none'   ||
      style.visibility === 'hidden' ||
      style.opacity    === '0'      ||
      style.fontSize   === '0px'    ||
      style.color      === 'rgba(0, 0, 0, 0)' ||
      style.color      === 'transparent'
    ) {
      toRemove.push(el);
      return;
    }

    // ── Detecção Geométrica: elemento existe mas ocupa 0 pixels ──
    // Cobre casos onde display/visibility estão "visíveis" mas o elemento
    // está redimensionado para 0 via width:0;height:0;overflow:hidden
    if (el.offsetHeight === 0 && el.offsetWidth === 0 && el.textContent.trim().length > 0) {
      toRemove.push(el);
      return;
    }

    // ── Detecção de aria-hidden="true" (conteúdo explicitamente oculto para a11y) ──
    if (el.getAttribute('aria-hidden') === 'true') {
      toRemove.push(el);
      return;
    }

    // ── Texto de watermark anti-scrape (não remove, mas marca) ──
    // Remover agressivamente pode cortar texto real em alguns sites.
    // Por ora, apenas loga para diagnóstico.
    const text = el.textContent.toLowerCase();
    if (text.includes('read on') || text.includes('stolen from') || text.includes('support us at')) {
      console.debug('[AgnesDigital] Watermark detectada:', el.textContent.substring(0, 50));
    }
  });

  // Remoção em lote: um único reflow após todas as remoções
  toRemove.forEach(el => {
    try { el.parentNode?.removeChild(el); } catch (_e) {}
  });
}

// ── IFRAME SANDBOXING (BYPASS CLOUDFLARE) ──
// ── handleIframeFetch: chamada pelo switch unificado no topo do arquivo ──
// Cria um iframe invisível com a URL alvo e aguarda o conteúdo carregar,
// usando polling em vez de setInterval fixo (mais leve e cancelável).
// Usa MutationObserver para detectar mudanças no DOM do iframe assim que
// elas acontecerem — muito mais eficiente que setInterval em conexões lentas.
function handleIframeFetch(msg, sendResponse) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'display:none;width:0;height:0;border:0;';
  iframe.src = msg.url;

  let resolved    = false;
  let pollCount   = 0;
  const MAX_POLLS = 30; // 15 segundos (30 × 500ms)
  let   intervalId;

  function cleanup() {
    clearInterval(intervalId);
    try { iframe.remove(); } catch (_e) {}
  }

  iframe.onload = () => {
    intervalId = setInterval(() => {
      pollCount++;
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        const el  = doc.querySelector(msg.selector || '.chapter-content, .reading-content, #chapter-content, .cha-words');

        const hasText  = el && el.innerText && el.innerText.trim().length > 200;
        const hasImgs  = el && el.querySelectorAll('img').length > 0;

        if (hasText || hasImgs) {
          resolved = true;
          cleanup();
          sendResponse({ success: true, data: {
            title:   doc.title,
            html:    el.innerHTML,
            content: el.innerHTML,
            text:    el.innerText.trim()
          }});
        } else if (pollCount >= MAX_POLLS) {
          cleanup();
          sendResponse({ success: false, error: 'Timeout aguardando conteúdo no Iframe.' });
        }
      } catch (_e) {
        if (pollCount >= MAX_POLLS) {
          cleanup();
          sendResponse({ success: false, error: 'Cross-Origin ou Timeout no Iframe.' });
        }
      }
    }, 500);
  };

  iframe.onerror = () => {
    cleanup();
    sendResponse({ success: false, error: 'Falha ao carregar iframe.' });
  };

  document.body.appendChild(iframe);
}

