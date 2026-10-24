/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file md-builder.js
 * @description Exportador de Markdown (MD) com YAML Front Matter,
 *              suporte a imagens locais e conversão estruturada de HTML para Markdown.
 *
 * @pipeline BookIR → MdBuilder → Blob → Arquivo .md
 */

self.MdBuilder = (function () {
  'use strict';

  // Tabela de entidades nomeadas mais comuns em texto de novel
  var HTML_ENTITIES = {
    '&amp;':   '&',  '&lt;':    '<',  '&gt;':    '>',
    '&quot;':  '"',  '&#39;':   "'",  '&apos;':  "'",
    '&nbsp;':  ' ',  '&mdash;': '—',  '&ndash;': '–',
    '&ldquo;': '"',  '&rdquo;': '"',
    '&lsquo;': '\u2018', '&rsquo;': '\u2019',
    '&hellip;':'…',  '&copy;':  '\u00A9',
    '&reg;':   '\u00AE', '&trade;': '\u2122',
    '&bull;':  '\u2022', '&middot;':'\u00B7',
    '&laquo;': '\u00AB', '&raquo;': '\u00BB'
  };

  // ── Decodificador de entidades HTML ──────────────────────────────────────────
  // Decodifica entidades nomeadas e numéricas sem uso de innerHTML.
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

  // ── HTML → Markdown ───────────────────────────────────────────────────────────
  // Usa ([\s\S]*?) em vez de (.*?) para capturar parágrafos com quebra de linha.
  // Usa array de partes + join() para evitar string += O(n²).
  function htmlToMarkdown(html) {
    if (!html) return '';

    const parts = [];
    let md = html;

    // Remove scripts e styles (segurança básica)
    md = md.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    md = md.replace(/<style\b[\s\S]*?<\/style>/gi, '');

    // Cabeçalhos ([\s\S]*? para capturar quebras de linha internas)
    md = md.replace(/<h1[\s\S]*?>([\s\S]*?)<\/h1>/gi, '\n# $1\n\n');
    md = md.replace(/<h2[\s\S]*?>([\s\S]*?)<\/h2>/gi, '\n## $1\n\n');
    md = md.replace(/<h3[\s\S]*?>([\s\S]*?)<\/h3>/gi, '\n### $1\n\n');
    md = md.replace(/<h4[\s\S]*?>([\s\S]*?)<\/h4>/gi, '\n#### $1\n\n');
    md = md.replace(/<h5[\s\S]*?>([\s\S]*?)<\/h5>/gi, '\n##### $1\n\n');
    md = md.replace(/<h6[\s\S]*?>([\s\S]*?)<\/h6>/gi, '\n###### $1\n\n');

    // Formatação inline ([\s\S]*? para spans multi-linha)
    md = md.replace(/<(b|strong)[\s\S]*?>([\s\S]*?)<\/\1>/gi, '**$2**');
    md = md.replace(/<(i|em)[\s\S]*?>([\s\S]*?)<\/\1>/gi, '_$2_');
    md = md.replace(/<(s|strike|del)[\s\S]*?>([\s\S]*?)<\/\1>/gi, '~~$2~~');

    // Blockquotes
    md = md.replace(/<blockquote[\s\S]*?>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
      return inner.split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
    });

    // Quebras e parágrafos
    md = md.replace(/<br\s*\/?>/gi, '  \n');
    md = md.replace(/<\/p>/gi, '\n\n');
    md = md.replace(/<\/div>/gi, '\n\n');

    // Imagens
    md = md.replace(/<img[^>]+alt="([^"]*)"[^>]+src="([^"]+)"[^>]*>/gi, '![$1]($2)');
    md = md.replace(/<img[^>]+src="([^"]+)"[^>]*>/gi, '![image]($1)');

    // Links
    md = md.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

    // Remove todas as tags restantes
    md = md.replace(/<[^>]+>/g, '');

    // Decodifica entidades
    md = decodeEntities(md);

    // Normaliza espaços e quebras
    parts.push(md.replace(/\n{3,}/g, '\n\n').trim());

    return parts.join('');
  }

  // ── Higieniza texto para uso em YAML Front Matter ─────────────────────────────
  function yamlEscape(str) {
    if (!str) return '""';
    // Se contém aspas simples, usa aspas duplas e escapa as duplas internas
    if (str.includes('"')) return `'${str.replace(/'/g, "''")}'`;
    return `"${str}"`;
  }

  /**
   * Gera um arquivo Markdown a partir de um BookIR.
   * @param {Object} bookIR
   * @param {Object} [options]
   * @param {boolean} [options.includeSynopsis] - Incluir sinopse (padrão: true)
   * @param {boolean} [options.frontMatter]     - Gerar YAML front matter (padrão: true)
   * @returns {Promise<Blob>}
   */
  async function buildMd(bookIR, options) {
    options = options || {};
    const includeFrontMatter = options.frontMatter !== false;
    const chunks = [];

    // BOM UTF-8: garante que Notion, Obsidian e Word abram sem texto corrompido
    chunks.push('\uFEFF');

    const meta = bookIR.metadata || {};

    // ── YAML Front Matter ──────────────────────────────────────────────────────
    // Compatível com Obsidian, Hugo, Jekyll, Pandoc, Logseq
    if (includeFrontMatter) {
      chunks.push('---\n');
      chunks.push(`title: ${yamlEscape(meta.title || 'Sem Título')}\n`);
      if (meta.author)  chunks.push(`author: ${yamlEscape(meta.author)}\n`);
      if (meta.status)  chunks.push(`status: ${yamlEscape(meta.status)}\n`);
      if (meta.genres && meta.genres.length) {
        chunks.push(`tags:\n`);
        meta.genres.forEach(g => chunks.push(`  - ${g}\n`));
      }
      chunks.push(`generator: "Agnes Digital"\n`);
      chunks.push('---\n\n');
    }

    // ── Cabeçalho principal ────────────────────────────────────────────────────
    chunks.push(`# ${meta.title || 'Sem Título'}\n\n`);
    if (meta.author) chunks.push(`**Autor:** ${meta.author}  \n`);
    if (meta.status) chunks.push(`**Status:** ${meta.status}  \n`);
    if (meta.genres && meta.genres.length) {
      chunks.push(`**Gêneros:** ${meta.genres.join(', ')}  \n`);
    }
    chunks.push('\n');

    // ── Sinopse ────────────────────────────────────────────────────────────────
    if (options.includeSynopsis !== false && meta.synopsis) {
      // Higieniza a sinopse antes de injetar (remove tags HTML)
      const cleanSynopsis = meta.synopsis.replace(/<[^>]+>/g, '').trim();
      chunks.push(`## Sinopse\n\n${decodeEntities(cleanSynopsis)}\n\n`);
    }

    chunks.push('---\n\n');

    // ── Capítulos ──────────────────────────────────────────────────────────────
    const flatChapters = (self.BookIR ? self.BookIR.flattenIR(bookIR) : null)
      || bookIR.structure
      || [];

    for (let ci = 0; ci < flatChapters.length; ci++) {
      const ch = flatChapters[ci];

      chunks.push(`## ${ch.title || `Capítulo ${ci + 1}`}\n\n`);

      if (ch.content) {
        chunks.push(htmlToMarkdown(ch.content));
        chunks.push('\n\n');
      }

      // Separador entre capítulos (exceto no último)
      if (ci < flatChapters.length - 1) {
        chunks.push('---\n\n');
      }
    }

    // join() final: um único alloc em vez de n reallocations
    const mdContent = chunks.join('');
    return new Blob([mdContent], { type: 'text/markdown;charset=utf-8' });
  }

  return { buildMd };
})();
