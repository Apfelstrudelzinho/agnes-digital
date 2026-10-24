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

  // Tabela de entidades nomeadas mais comuns em texto de novel
  var HTML_ENTITIES = {
    '&amp;':   '&',  '&lt;':    '<',  '&gt;':    '>',
    '&quot;':  '"',  '&#39;':   "'",  '&apos;':  "'",
    '&nbsp;':  ' ',  '&mdash;': '\u2014', '&ndash;': '\u2013',
    '&ldquo;': '\u201C', '&rdquo;': '\u201D',
    '&lsquo;': '\u2018', '&rsquo;': '\u2019',
    '&hellip;':'\u2026', '&copy;':  '\u00A9',
    '&reg;':   '\u00AE', '&trade;': '\u2122',
    '&bull;':  '\u2022', '&middot;':'\u00B7',
    '&laquo;': '\u00AB', '&raquo;': '\u00BB'
  };

  /**
   * Decodifica entidades HTML para texto plano Unicode sem usar innerHTML.
   * Evita alertas de segurança em linters de extensões (AMO/Mozilla).
   * @param {string} str
   * @returns {string}
   */
  function decodeEntities(str) {
    if (!str || !str.includes('&')) return str;
    // Entidades numericas: &#x160; ou &#160;
    str = str.replace(/&#x([0-9a-f]+);/gi, function(_, hex) {
      return String.fromCodePoint(parseInt(hex, 16));
    });
    str = str.replace(/&#([0-9]+);/g, function(_, dec) {
      return String.fromCodePoint(parseInt(dec, 10));
    });
    // Entidades nomeadas da tabela
    str = str.replace(/&[a-z]+;/gi, function(ent) {
      return HTML_ENTITIES[ent] || ent;
    });
    return str;
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
