/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file translator.js
 * @description Motor de tradução em cascata multi-engine (HTML Nativo, PA v1, GTX Legacy).
 *              Preserva formatação estrutural de parágrafos e tags HTML com
 *              controle de concorrência e fallbacks automáticos.
 *
 * @pipeline Dashboard (Worker Task) → Translator → Translated BookIR
 * @requires window.AgnesLog
 */

self.Translator = (function () {
  'use strict';

// ── Configurações Gerais do Tradutor ──

  const CONFIG = {
    // Engine 1: translateHtml — accepts raw HTML, returns translated HTML
    HTML_ENDPOINT: 'https://translate-pa.googleapis.com/v1/translateHtml',
    HTML_API_KEY: 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520',
    HTML_CHUNK_CHARS: 12000,  // Limite seguro por lote de HTML nativo (divide capítulos longos)

    // Engine 2: translate PA v1 — modern plain text (POST para evitar Erro 414)
    PA_ENDPOINT: 'https://translate-pa.googleapis.com/v1/translate',
    PA_API_KEY: 'AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA',

    // Engine 3: GTX legacy — classic GET endpoint (gratuito e altamente estável)
    GTX_ENDPOINT: 'https://translate.googleapis.com/translate_a/single',

    // Rate limiting & delays (otimizado para alta velocidade sem atingir 429)
    REQUEST_INTERVAL: 350,    // 350ms entre lotes (em vez de 1000ms)
    JITTER: 100,              // ±100ms jitter
    MAX_RETRIES: 2,           // 2 tentativas (1 normal + 1 retry rápido antes de chavear engine)
    BACKOFF_BASE: 1500,       // 1.5s initial backoff
    BACKOFF_MAX: 10000,       // 10s max backoff
    COOLDOWN_MS: 300000,      // 5 minutos de cooldown para engines inativos/bloqueados

    // Batching (limite seguro para GTX não retornar Erro 400 Bad Request)
    MAX_BATCH_CHARS: 1800,    // Max chars por lote (GTX bloqueia acima de ~2000-2500)
    MAX_PARA_CHARS:  1400     // Parágrafo único maior que isso é subdividido
  };

// ── CIRCUIT BREAKER & ENGINE HEALTH Evita desperdiçar 30s-60s por capítulo tentando engines offline repetidamente ──

  const engineState = {
    html: { cooldownUntil: 0, failures: 0, name: 'Engine 1 (translateHtml)' },
    pa:   { cooldownUntil: 0, failures: 0, name: 'Engine 2 (PA v1)' },
    gtx:  { cooldownUntil: 0, failures: 0, name: 'Engine 3 (GTX)' }
  };

  let lastWorkingBatchEngine = 'pa';

  function isEngineHealthy(key) {
    return Date.now() >= engineState[key].cooldownUntil;
  }

  function recordSuccess(key) {
    engineState[key].failures = 0;
    engineState[key].cooldownUntil = 0;
  }

  function recordFailure(key, statusCode) {
    engineState[key].failures++;
    // Se erro não-retryable (400, 401, 403, 404, 413) ou se falhou consecutivamente
    if (!isRetryable(statusCode) || engineState[key].failures >= 2) {
      engineState[key].cooldownUntil = Date.now() + CONFIG.COOLDOWN_MS;
      console.warn('[Translator] ' + engineState[key].name + ' colocado em cooldown por ' + (CONFIG.COOLDOWN_MS / 1000) + 's (status: ' + statusCode + ').');
    }
  }

// ── Motor 1: translateHtml (Primário — preserva estrutura HTML) ──

  function chunkHtmlContent(html, maxChunkChars) {
    var maxLen = maxChunkChars || CONFIG.HTML_CHUNK_CHARS || 12000;
    if (!html || html.length <= maxLen) return [html];

    // Quebra o HTML nas tags de fechamento de blocos mantendo a tag intacta
    var tokens = html.split(/(<\/(?:p|div|h[1-6]|blockquote|li|article|section)>)/i);
    var blocks = [];
    var temp = '';

    for (var i = 0; i < tokens.length; i++) {
      temp += tokens[i];
      if (/^<\/(?:p|div|h[1-6]|blockquote|li|article|section)>$/i.test(tokens[i])) {
        if (temp.trim()) blocks.push(temp.trim());
        temp = '';
      }
    }
    if (temp.trim()) blocks.push(temp.trim());

    // Se não encontrou tags de bloco (ex: texto puro com \n\n), divide por linhas duplas
    if (blocks.length <= 1) {
      blocks = html.split(/\n\s*\n/).filter(function (b) { return b.trim().length > 0; });
    }

    var chunks = [];
    var current = '';

    for (var j = 0; j < blocks.length; j++) {
      var block = blocks[j];
      if (current && (current.length + block.length + 1 > maxLen)) {
        chunks.push(current);
        current = block;
      } else {
        current = current ? current + '\n' + block : block;
      }
    }
    if (current) chunks.push(current);

    return chunks.length > 0 ? chunks : [html];
  }

  async function translateSingleHtmlChunk(htmlChunk, sourceLang, targetLang) {
    const body = JSON.stringify([
      [[htmlChunk], sourceLang, targetLang],
      'wt_lib'
    ]);

    const response = await fetch(CONFIG.HTML_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json+protobuf',
        'X-Goog-Api-Key': CONFIG.HTML_API_KEY
      },
      body: body
    });

    if (!response.ok) {
      const status = response.status;
      throw new TranslateError(`translateHtml returned ${status}`, status);
    }

    const data = await response.json();
    // Response format: [[translatedHtml]]
    if (Array.isArray(data) && data[0] && data[0][0]) {
      return data[0][0];
    }
    throw new TranslateError('translateHtml: unexpected response structure', 0);
  }

  async function translateViaHtml(htmlContent, sourceLang, targetLang) {
    const chunks = chunkHtmlContent(htmlContent, CONFIG.HTML_CHUNK_CHARS);
    if (chunks.length === 1) {
      return await translateSingleHtmlChunk(chunks[0], sourceLang, targetLang);
    }

    const results = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const res = await translateSingleHtmlChunk(chunks[ci], sourceLang, targetLang);
      results.push(res);
      if (ci < chunks.length - 1) {
        await wait(CONFIG.REQUEST_INTERVAL);
      }
    }
    return results.join('\n');
  }

// ── Motor 2: translate PA v1 (Fallback 1 — texto plano) ──

  async function translateViaPA(text, sourceLang, targetLang) {
    // POST em vez de GET: evita Erro 414 (Request-URI Too Long) em textos longos.
    // A API translate-pa aceita o mesmo payload via POST/body.
    const body = JSON.stringify({
      params: { client: 'gtx' },
      query: {
        source_language: sourceLang,
        target_language: targetLang,
        display_language: 'en-US',
        text: text
      },
      data_types: ['TRANSLATION'],
      key: CONFIG.PA_API_KEY
    });

    const response = await fetch(CONFIG.PA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': CONFIG.PA_API_KEY,
        'Accept': 'application/json'
      },
      body: body
    });

    if (!response.ok) {
      throw new TranslateError(`PA v1 returned ${response.status}`, response.status);
    }

    const data = await response.json();
    if (data && data.translation) {
      return data.translation;
    }
    throw new TranslateError('PA v1: unexpected response structure', 0);
  }

// ── Motor 3: GTX Legacy (Fallback 2 — endpoint GET estável) ──

  async function translateViaGTX(text, sourceLang, targetLang) {
    const sl = sourceLang || 'auto';
    const tl = targetLang;
    const url = `${CONFIG.GTX_ENDPOINT}?client=gtx&dt=t&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`;

    const response = await fetch(url, {
      method: 'GET'
    });

    if (!response.ok) {
      throw new TranslateError(`GTX returned ${response.status}`, response.status);
    }

    const data = await response.json();

    // Classic nested array format: [[[trans, orig], ...]]
    if (Array.isArray(data) && Array.isArray(data[0])) {
      return data[0]
        .filter(function (item) { return item && item[0]; })
        .map(function (item) { return item[0]; })
        .join('');
    }

    // dj=1 format fallback if returned: { sentences: [{ trans: "..." }, ...] }
    if (data && data.sentences) {
      return data.sentences
        .filter(function (s) { return s.trans; })
        .map(function (s) { return s.trans; })
        .join('');
    }

    throw new TranslateError('GTX: unexpected response structure', 0);
  }

// ── Tipos de Erro Customizados ──

  function TranslateError(message, statusCode) {
    this.message = message;
    this.statusCode = statusCode;
    this.name = 'TranslateError';
  }
  TranslateError.prototype = Object.create(Error.prototype);
  TranslateError.prototype.constructor = TranslateError;

// ── Controle de Taxa e Lógica de Retentativa ──

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function jitteredDelay() {
    return CONFIG.REQUEST_INTERVAL + (Math.random() * 2 - 1) * CONFIG.JITTER;
  }

  function backoffDelay(attempt) {
    var base = CONFIG.BACKOFF_BASE * Math.pow(2, attempt);
    var capped = Math.min(base, CONFIG.BACKOFF_MAX);
    return capped * (0.5 + Math.random() * 0.5);
  }

  function isRetryable(statusCode) {
    return statusCode === 429 || statusCode === 503 || statusCode === 500;
  }

// ── Utilitários de Loteamento (Motores de texto plano) ──

  function extractParagraphs(html) {
    // Limpa caracteres invisíveis de ofuscação (Zero-Width Spaces)
    var cleanInput = (html || '').replace(/[\u200B-\u200D\uFEFF]/g, '');

    // Divide o HTML em parágrafos individuais
    var stripped = cleanInput
      .replace(/<\/p>/gi, '</p>\n\n')
      .replace(/<\/div>/gi, '</div>\n\n')
      .replace(/<\/h[1-6]>/gi, function (m) { return m + '\n\n'; })
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");

    return stripped
      .split(/\n\s*\n+/)
      .map(function (p) {
        var clean = p.trim();
        // Remove números isolados de contadores de comentários colados no fim da frase ou parágrafo (ex: "hello world. 15" -> "hello world.")
        clean = clean.replace(/([.!?,"'”’)]?)\s*\d+\s*$/, '$1').trim();
        clean = clean.replace(/\s+\d+$/, '').trim();
        return clean;
      })
      .filter(function (p) {
        // Ignora parágrafos vazios ou que sejam apenas números isolados (ex: "12")
        return p.length > 0 && !/^\d+$/.test(p);
      });
  }

  function buildBatches(paragraphs) {
    var batches     = [];
    var currentBatch = [];
    var currentLen   = 0;

    for (var i = 0; i < paragraphs.length; i++) {
      var para = paragraphs[i];

      // Particionamento semântico: um parágrafo único maior que MAX_PARA_CHARS
      // é subdividido em fronteiras de frase (., !, ?) em vez de por byte.
      // Isso preserva a coerência gramatical na tradução — o Google Translate
      // performa muito melhor em sentenças completas do que em fragmentos cortados.
      if (para.length > CONFIG.MAX_PARA_CHARS) {
        var subParts = splitAtSentenceBoundary(para, CONFIG.MAX_PARA_CHARS);
        subParts.forEach(function(sub) {
          paragraphs.splice(i + 1, 0, sub); // injeta de volta na fila
        });
        para = paragraphs[i]; // re-lê o primeiro fragmento
      }

      if (currentLen + para.length + 2 > CONFIG.MAX_BATCH_CHARS && currentBatch.length > 0) {
        batches.push(currentBatch.join('\n\n'));
        currentBatch = [para];
        currentLen   = para.length;
      } else {
        currentBatch.push(para);
        currentLen += para.length + 2;
      }
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch.join('\n\n'));
    }

    return batches;
  }

  /**
   * Divide um texto longo em segmentos menores cortando em fronteiras de frase.
   * Preferência: ". " → "! " → "? " → ", " → " " → corte forçado.
   * @param {string} text
   * @param {number} maxLen
   * @returns {string[]}
   */
  function splitAtSentenceBoundary(text, maxLen) {
    var parts = [];
    var remaining = text;

    while (remaining.length > maxLen) {
      var slice   = remaining.substring(0, maxLen);
      var cutPos  = -1;

      // Tenta cortar na fronteira de frase mais próxima (buscando de trás para frente)
      var sentenceEnds = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
      for (var si = 0; si < sentenceEnds.length; si++) {
        var idx = slice.lastIndexOf(sentenceEnds[si]);
        if (idx > maxLen * 0.5) { // não corta no primeiro 50% — fragmento seria muito pequeno
          cutPos = idx + sentenceEnds[si].length;
          break;
        }
      }

      // Fallback: corta na última vírgula ou espaço
      if (cutPos === -1) {
        cutPos = slice.lastIndexOf(', ');
        if (cutPos === -1 || cutPos < maxLen * 0.5) {
          cutPos = slice.lastIndexOf(' ');
        }
      }

      // Último recurso: corte forçado sem critério semântico
      if (cutPos <= 0) cutPos = maxLen;

      parts.push(remaining.substring(0, cutPos).trim());
      remaining = remaining.substring(cutPos).trim();
    }

    if (remaining.length > 0) parts.push(remaining);
    return parts;
  }

  function wrapInParagraphs(text) {
    return text
      .split(/\n\s*\n+/)
      .map(function (p) { return p.trim(); })
      .filter(function (p) { return p.length > 0; })
      .map(function (p) {
        return '<p>' + escapeHtml(p) + '</p>';
      })
      .join('\n');
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

// ── API Pública: translateText (Cascata de Três Motores) ──

  /**
   * Translates HTML content through a cascade of 3 Google Translate engines.
   * @param {string} htmlContent - The HTML chapter content to translate
   * @param {string} sourceLang - Source language code ('auto' or ISO 639-1)
   * @param {string} targetLang - Target language code (ISO 639-1)
   * @returns {Promise<string>} Translated HTML content
   */
  async function translateText(htmlContent, sourceLang, targetLang) {
    if (!htmlContent || !targetLang) return htmlContent;
    if (sourceLang === targetLang) return htmlContent;

    var src = sourceLang || 'auto';

    // ── Motor 1: translateHtml (Nativo para HTML) ──
    // Só tenta se estiver saudável (fora de cooldown). Capítulos grandes são divididos internamente em chunks.
    if (isEngineHealthy('html')) {
      for (var attempt = 0; attempt < CONFIG.MAX_RETRIES; attempt++) {
        try {
          var result = await translateViaHtml(htmlContent, src, targetLang);
          if (result && result.length > 0) {
            recordSuccess('html');
            return result;
          }
        } catch (err) {
          console.warn('[Translator] Engine 1 (translateHtml) tentativa ' + (attempt + 1) + ' falhou:', err.message);
          if (isRetryable(err.statusCode) && attempt < CONFIG.MAX_RETRIES - 1) {
            await wait(backoffDelay(attempt));
            continue;
          }
          recordFailure('html', err.statusCode);
          break; // Fall through rápido para Engines 2 & 3
        }
        await wait(jitteredDelay());
      }
    }

    // ── ENGINES 2 & 3: texto plano com retry por chunk e circuit breaker ──
    try {
      var translated = await translateBatchedPlainText(
        htmlContent, src, targetLang,
        translateViaPA,
        [translateViaGTX]
      );
      if (translated) return translated;
    } catch (err2) {
      console.error('[Translator] Todos os engines falharam. Retornando conteúdo original.');
    }

    return htmlContent;
  }

  /**
   * Traduz conteúdo HTML em lotes extraindo parágrafos, traduzindo em blocos
   * e reconstruindo os parágrafos em XHTML.
   *
   * Fast-fail & Circuit Breaker:
   * Lembra o último engine funcional (ex: GTX) e não repete chamadas para engines
   * em cooldown (ex: PA v1 quando chave/cota estiver esgotada).
   */
  async function translateBatchedPlainText(htmlContent, sourceLang, targetLang, engineFn, fallbackEngines) {
    var paragraphs = extractParagraphs(htmlContent);
    if (paragraphs.length === 0) return htmlContent;

    var batches          = buildBatches(paragraphs);
    var translatedParts  = [];
    var fallbackList     = fallbackEngines || [];

    var enginesList = [
      { key: 'pa',  fn: engineFn,        name: 'Engine 2 (PA v1)' },
      { key: 'gtx', fn: fallbackList[0] || translateViaGTX, name: 'Engine 3 (GTX)' }
    ];

    for (var i = 0; i < batches.length; i++) {
      var batch      = batches[i];
      var translated = null;

      // Ordena engines dando prioridade ao que comprovadamente funcionou
      var activeEngines = enginesList.slice();
      if (lastWorkingBatchEngine === 'gtx' || !isEngineHealthy('pa')) {
        activeEngines = [enginesList[1], enginesList[0]];
      }

      engineLoop:
      for (var ei = 0; ei < activeEngines.length; ei++) {
        var currentEng = activeEngines[ei];

        // Se o engine está em cooldown e há outro na fila, pula imediatamente (0ms de atraso)
        if (!isEngineHealthy(currentEng.key) && ei < activeEngines.length - 1) {
          continue;
        }

        for (var attempt = 0; attempt < CONFIG.MAX_RETRIES; attempt++) {
          try {
            translated = await currentEng.fn(batch, sourceLang, targetLang);
            if (translated) {
              recordSuccess(currentEng.key);
              lastWorkingBatchEngine = currentEng.key;
              break engineLoop; // Sucesso — sai dos loops e avança para o próximo chunk
            }
          } catch (err) {
            var retryable = isRetryable(err.statusCode);
            var lastAttempt = attempt >= CONFIG.MAX_RETRIES - 1;
            console.warn(
              '[Translator] Chunk ' + (i + 1) + '/' + batches.length +
              ' ' + currentEng.name + ' tentativa ' + (attempt + 1) + ' falhou:',
              err.message || err
            );
            if (retryable && !lastAttempt) {
              await wait(backoffDelay(attempt));
            } else {
              recordFailure(currentEng.key, err.statusCode);
              break; // Pula para o próximo engine da cascata
            }
          }
        }
      }

      // Se todos os engines falharam neste chunk: preserva texto original.
      if (translated) {
        translatedParts.push(translated);
      } else {
        console.warn('[Translator] Chunk ' + (i + 1) + ' não traduzido — preservando original.');
        translatedParts.push(batch);
      }

      // Rate limit otimizado entre batches
      if (i < batches.length - 1) {
        await wait(jitteredDelay());
      }
    }

    var fullTranslation = translatedParts.join('\n\n');
    return wrapInParagraphs(fullTranslation);
  }

// ── Exportações Públicas ──

  return {
    translateText: translateText,
    // Expostos para testes unitários dos motores
    translateViaHtml: translateViaHtml,
    translateViaPA: translateViaPA,
    translateViaGTX: translateViaGTX,
    extractParagraphs: extractParagraphs,
    buildBatches: buildBatches,
    getEngineStatus: function () {
      return {
        engineState: Object.assign({}, engineState),
        lastWorkingBatchEngine: lastWorkingBatchEngine
      };
    },
    resetCooldowns: function () {
      engineState.html.cooldownUntil = 0;
      engineState.pa.cooldownUntil = 0;
      engineState.gtx.cooldownUntil = 0;
    }
  };
})();
