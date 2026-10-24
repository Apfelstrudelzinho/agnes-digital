/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file txt-builder.js
 * @description Exportador de Texto Plano (TXT) UTF-8 com BOM.
 *              Formatação limpa com separadores customizáveis e deofuscação de entidades HTML.
 *
 * @pipeline BookIR → TxtBuilder → Blob → Arquivo .txt
 */

self.TxtBuilder = (function () {
  'use strict';

  // Separadores configuráveis -- personalize via options.chapterSeparator ao chamar buildTxt()
  var DEFAULT_SEPARATOR = '\u2500'.repeat(48);

  /**
   * Decodifica entidades HTML usando um textarea do browser.
   * Cobre aspas tipograficas (ldquo), travessoes (mdash), etc.
   * Evita o uso de DOMParser (mais pesado) para decodificacao simples.
   * @param {string} str
   * @returns {string}
   */
  function decodeEntities(str) {
    if (!str || !str.includes('&')) return str;
    try {
      // textarea.value resolve entidades sem executar JS (seguro)
      var ta = document.createElement('textarea');
      ta.innerHTML = str;
      return ta.value;
    } catch (_e) {
      // Fallback manual para ambientes sem DOM (testes Node)
      return str
        .replace(/&amp;/g,   '&')
        .replace(/&lt;/g,    '<')
        .replace(/&gt;/g,    '>')
        .replace(/&quot;/g,  '"')
        .replace(/&#39;/g,   "'")
        .replace(/&apos;/g,  "'")
        .replace(/&nbsp;/g,  ' ')
        .replace(/&mdash;/g, '\u2014')
        .replace(/&ndash;/g, '\u2013')
        .replace(/&ldquo;/g, '\u201C')
        .replace(/&rdquo;/g, '\u201D')
        .replace(/&lsquo;/g, '\u2018')
        .replace(/&rsquo;/g, '\u2019')
        .replace(/&hellip;/g, '\u2026');
    }
  }

  /**
   * Converte HTML de capitulo em texto plano legivel.
   * Usa array de partes + join() para evitar picos de RAM com strings gigantes.
   * @param {string} html
   * @returns {string}
   */
  function stripHtml(html) {
    if (!html) return '';

    var parts = [];
    // Preserva quebras de paragrafo antes de remover tags
    var processed = html
      .replace(/<br\s*\/?>/gi,    '\n')
      .replace(/<\/p>/gi,         '\n\n')
      .replace(/<\/div>/gi,       '\n\n')
      .replace(/<\/h[1-6]>/gi,    '\n\n')
      .replace(/<[^>]+>/g,        '');   // Remove todas as outras tags

    parts.push(decodeEntities(processed));

    return parts.join('')
      .replace(/\n{3,}/g, '\n\n')  // Normaliza multiplas linhas em branco
      .trim();
  }

  /**
   * Gera um arquivo TXT a partir de um BookIR.
   * @param {Object} bookIR
   * @param {Object} [options]
   * @param {string}  [options.chapterSeparator]  - Separador entre capitulos (padrao: linha)
   * @param {boolean} [options.includeSynopsis]   - Incluir sinopse (padrao: true)
   * @returns {Promise<Blob>}
   */
  async function buildTxt(bookIR, options) {
    options = options || {};
    var sep = options.chapterSeparator || DEFAULT_SEPARATOR;

    // Usa array de chunks para evitar string += O(n^2)
    var chunks = [];

    // BOM UTF-8: garante que Notepad, Word e Notion abram sem texto arruinado
    chunks.push('\uFEFF');

    var meta = bookIR.metadata || {};

    // Cabecalho
    chunks.push(meta.title || 'Sem Titulo');
    chunks.push('\n');
    if (meta.author)                       chunks.push('Autor: ' + meta.author + '\n');
    if (meta.genres && meta.genres.length) chunks.push('Generos: ' + meta.genres.join(', ') + '\n');
    if (meta.status)                       chunks.push('Status: ' + meta.status + '\n');
    chunks.push('\n');

    if (options.includeSynopsis !== false && meta.synopsis) {
      chunks.push('Sinopse:\n' + meta.synopsis + '\n\n');
    }

    chunks.push(sep + '\n\n');

    // Capitulos
    var flatChapters = (self.BookIR ? self.BookIR.flattenIR(bookIR) : null)
      || bookIR.structure
      || [];

    for (var ci = 0; ci < flatChapters.length; ci++) {
      var ch = flatChapters[ci];

      chunks.push('\n' + sep + '\n');
      chunks.push('  ' + (ch.title || ('Capitulo ' + (ci + 1))) + '\n');
      chunks.push(sep + '\n\n');

      if (ch.content) {
        chunks.push(stripHtml(ch.content));
        chunks.push('\n\n');
      }
    }

    // join() final: um unico alloc em vez de n reallocations
    var txtContent = chunks.join('');
    return new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
  }

  return { buildTxt: buildTxt };
})();
