/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file epub-builder.js
 * @description Compilador EPUB 3.0 com suporte a EPUB 2 NCX retrocompatível.
 *              Gera sumários hierárquicos (nav.xhtml e toc.ncx), metadados OPF ricos,
 *              capas e embutimento de fontes e imagens.
 *
 * @pipeline BookIR → EpubBuilder → JSZip → Arquivo .epub
 * @requires window.JSZip
 */

self.EpubBuilder = (function () {
  'use strict';

  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function escapeXml(unsafe) {
    if (!unsafe) return '';
    return String(unsafe)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function sanitizeXhtmlContent(html) {
    if (!html) return '<p></p>';

    var content = String(html);

    // 1. Chars de controle ilegais em XML 1.0 — corrompem silenciosamente parsers XHTML
    // Proibidos: 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0xFFFE, 0xFFFF
    // eslint-disable-next-line no-control-regex
    content = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '');

    // 2. Lixo Microsoft Word / LibreOffice (mso-*, <o:p>, namespaces w:, v:)
    content = content.replace(/<o:p[^>]*>[\s\S]*?<\/o:p>/gi, '');
    content = content.replace(/<w:[^>]+>[\s\S]*?<\/w:[^>]+>/gi, '');
    content = content.replace(/\s+mso-[a-z-]+\s*:[^;"']*/gi, '');
    content = content.replace(/\s+class="Mso[^"]*"/gi, '');
    content = content.replace(/<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi, '');
    content = content.replace(/<\/?[a-z]+:[a-z]+[^>]*>/gi, '');

    // 3. Event handlers inline e URLs javascript: (XSS + EPUB security)
    content = content.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
    content = content.replace(/\s+(href|src|action)\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, '');

    // Conteúdo sem tags HTML — wrapa linhas em <p>
    if (!/\<\s*[a-z][\s\S]*\>/i.test(content)) {
      return content
        .split(/\n\s*\n|\n/)
        .map(function (line) { return line.trim(); })
        .filter(function (line) { return line.length > 0; })
        .map(function (line) { return '<p>' + escapeXml(line) + '</p>'; })
        .join('\n');
    }

    // 4. Fix void tags para self-closing XML (XHTML exige <br/>, não <br>)
    content = content.replace(/<(br|img|hr|input|meta|link)([^>]*?)(\/?)(\s*)>/gi, function (match, tag, attrs) {
      var cleanAttrs = attrs.trim();
      return '<' + tag + (cleanAttrs ? ' ' + cleanAttrs : '') + ' />';
    });

    // 5. Fix ampersands não escapados (XMLParseError no EpubCheck)
    content = content.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');

    // 6. Remove scripts, styles, iframes
    content = content.replace(/<script[\s\S]*?<\/script>/gi, '');
    content = content.replace(/<style[\s\S]*?<\/style>/gi, '');
    content = content.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');

    // 7. Corrige aninhamentos bloco-dentro-de-inline (viola XHTML 1.1, falha no EpubCheck)
    // <a><div>...</div></a> → <a>...</a>, <span><p>...</p></span> → <span>...</span>
    content = content.replace(/(<(?:a|span|em|strong|b|i|u)[^>]*>)([\s\S]*?)(<\/(?:a|span|em|strong|b|i|u)>)/gi,
      function(_, open, inner, close) {
        var cleaned = inner
          .replace(/<\/?(?:div|section|article|aside|header|footer|main|nav|figure|figcaption|blockquote)[^>]*>/gi, '')
          .replace(/<\/p>\s*<p[^>]*>/gi, '<br/>')
          .replace(/<\/?p[^>]*>/gi, '');
        return open + cleaned + close;
      });

    return content;
  }

// ── NOTAS DE RODAPÉ BIDIRECIONAIS (epub:type="noteref" / "footnote") Compatível com Kindle, Kobo, Apple Books e leitores EPUB 3 ──

  /**
   * Detecta links de nota de rodapé no HTML do capítulo e os converte para
   * marcação EPUB 3 nativa com epub:type="noteref" no texto e
   * epub:type="footnote" no bloco da nota.
   *
   * Padrões detectados:
   *   <a href="#fn1">[1]</a>         → noteref
   *   <a href="#note-1">[1]</a>      → noteref
   *   <div id="fn1">...</div>        → footnote aside
   *   <p id="fn1">...</p>            → footnote aside
   *
   * @param {string} html - conteúdo XHTML do capítulo
   * @param {string} chapterId - ID único do capítulo (ex: "chapter-001")
   * @returns {string} HTML com notas de rodapé convertidas para EPUB 3
   */
  function convertFootnotes(html, chapterId) {
    if (!html || !html.includes('href="#')) return html;

    var fnPattern = /href="#(fn|note[-_]?)([0-9]+)"/i;
    if (!fnPattern.test(html)) return html;

    // Passo 1: converte links de referência → noteref
    html = html.replace(
      /<a([^>]+)href="#(fn|note[-_]?)([0-9]+)"([^>]*)>([\s\S]*?)<\/a>/gi,
      function(_, preAttrs, prefix, num, postAttrs, linkText) {
        var noteId = chapterId + '-fn' + num;
        return '<a' + preAttrs + 'href="#' + noteId + '"' + postAttrs +
               ' epub:type="noteref" role="doc-noteref">' + linkText + '</a>';
      }
    );

    // Passo 2: converte containers de nota → aside epub:type="footnote"
    // Detecta: <div id="fn1">, <p id="fn1">, <li id="fn1">, <section id="footnote-1">
    html = html.replace(
      /<(div|p|li|section)([^>]+)id="(fn|note[-_]?)([0-9]+)"([^>]*)>([\s\S]*?)<\/>/gi,
      function(_, tag, preAttrs, prefix, num, postAttrs, noteContent) {
        var noteId = chapterId + '-fn' + num;
        return '<aside id="' + noteId + '" epub:type="footnote" role="doc-footnote">' +
               noteContent + '</aside>';
      }
    );

    return html;
  }

  function sanitizeFilename(name) {
    return (name || 'Novel')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .trim();
  }

// ── BUILDER PRINCIPAL (aceita formato antigo OU BookIR) ──

  /**
   * Constrói EPUB a partir do formato antigo (compatibilidade).
   */
  async function buildEpub(options) {
    var BookIRMod = self.BookIR;
    if (BookIRMod) {
      var ir = BookIRMod.createBookIR(
        {
          title: options.title,
          author: options.author,
          coverUrl: '',
          synopsis: options.synopsis || '',
          genres: options.genres || [],
          status: options.status || 'unknown',
          sourceUrl: options.sourceUrl || '',
          language: options.language || 'pt'
        },
        (options.chapters || []).map(function (ch) {
          return { title: ch.title, url: ch.url || ch.sourceUrl || '', content: ch.content || '' };
        })
      );
      return buildEpubFromIR(ir, { coverImageBlob: options.coverImageBlob });
    }
    // Fallback direto sem IR
    return buildEpubDirect(options);
  }

  /**
   * Constrói EPUB a partir de uma BookIR completa.
   */
  async function buildEpubFromIR(bookIR, options) {
    options = options || {};
    var meta = bookIR.metadata;
    var title = meta.title;
    var author = meta.author;
    var language = meta.language || 'pt';
    var coverImageBlob = options.coverImageBlob || null;

    if (!self.JSZip && !globalThis.JSZip) {
      throw new Error('JSZip library is not loaded.');
    }

    var zip = new (self.JSZip || globalThis.JSZip)();
    var uuid = generateUUID();
    var date = new Date().toISOString().split('T')[0];
    var modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    var safeTitle = escapeXml(title);
    var safeAuthor = escapeXml(author);

    // 1. mimetype
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

    // 2. META-INF/container.xml
    zip.folder('META-INF').file('container.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '  <rootfiles>\n' +
      '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
      '  </rootfiles>\n' +
      '</container>'
    );

    var oebps = zip.folder('OEBPS');

    // 3. Stylesheet
    oebps.folder('styles').file('style.css',
      '@charset "utf-8";\n' +
      'body { font-family: serif, "Times New Roman", Times; line-height: 1.65; margin: 5%; text-align: justify; }\n' +
      'h1, h2, h3, h4 { font-family: sans-serif, "Helvetica Neue", Helvetica, Arial; text-align: center; margin-top: 1.8em; margin-bottom: 1em; line-height: 1.3; }\n' +
      'h1 { font-size: 1.6em; }\n' +
      'h2 { font-size: 1.3em; }\n' +
      'h3 { font-size: 1.1em; }\n' +
      'p { margin-top: 0.6em; margin-bottom: 0.6em; text-indent: 1.5em; }\n' +
      'p.bilingual-translation { text-indent: 1.5em; color: #555; font-style: italic; margin-top: 0.2em; }\n' +
      'img { max-width: 100%; height: auto; display: block; margin: 1.5em auto; }\n' +
      '.cover-page { text-align: center; padding: 0; margin: 0; height: 100%; }\n' +
      '.cover-page img { height: 100%; max-width: 100%; object-fit: contain; }\n' +
      '.toc-page h1 { margin-bottom: 1.5em; }\n' +
      '.toc-page ol { list-style: none; padding-left: 0; }\n' +
      '.toc-page ol ol { padding-left: 1.5em; }\n' +
      '.toc-page li { margin-bottom: 0.4em; }\n' +
      '.toc-page a { text-decoration: none; color: inherit; }\n' +
      '.toc-page .volume-title { font-weight: bold; font-size: 1.1em; margin-top: 1em; }\n' +
      '.toc-page .arc-title { font-weight: bold; font-size: 1.0em; margin-top: 0.8em; color: #444; }\n' +
      '.synopsis { font-style: italic; margin: 1em 0; padding: 1em; border-left: 3px solid #ccc; }\n'
    );

    // 4. Cover
    var hasCover = false;
    var coverMediaType = 'image/jpeg';

    if (coverImageBlob) {
      hasCover = true;
      if (coverImageBlob.type) {
        coverMediaType = coverImageBlob.type;
      }
      var ext = coverMediaType.includes('png') ? 'png' : 'jpg';
      oebps.folder('images').file('cover.' + ext, coverImageBlob);

      oebps.file('cover.xhtml',
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE html>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml" lang="' + language + '" xml:lang="' + language + '">\n' +
        '<head>\n' +
        '  <meta charset="utf-8" />\n' +
        '  <title>Capa</title>\n' +
        '  <link rel="stylesheet" type="text/css" href="styles/style.css" />\n' +
        '</head>\n' +
        '<body>\n' +
        '  <div class="cover-page">\n' +
        '    <img src="images/cover.' + ext + '" alt="Capa" />\n' +
        '  </div>\n' +
        '</body>\n' +
        '</html>'
      );
    }

    // 5. Achata os capítulos hierárquicos para gravação dos arquivos XHTML
    var flatChapters = [];
    flattenForEpub(bookIR.structure, flatChapters, []);

    // Generate chapter XHTML files
    var manifestItems = '';
    var spineItems = '';

    for (var i = 0; i < flatChapters.length; i++) {
      var ch = flatChapters[i];
      var chIndex = i + 1;
      var chId = 'chapter-' + String(chIndex).padStart(3, '0');
      var chTitle = escapeXml(ch.title);
      var chBody = sanitizeXhtmlContent(ch.content);
      // Converte notas de rodapé para epub:type="noteref"/"footnote" (EPUB 3 nativo)
      chBody = convertFootnotes(chBody, chId);

      // Determine heading level based on hierarchy depth
      var headingTag = 'h2';
      if (ch.depth === 0 && ch.parentType === 'root') headingTag = 'h2';
      else if (ch.parentType === 'volume') headingTag = 'h3';
      else if (ch.parentType === 'arc') headingTag = 'h3';

      var xhtml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE html>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="' + language + '" xml:lang="' + language + '">\n' +
        '<head>\n' +
        '  <meta charset="utf-8" />\n' +
        '  <title>' + chTitle + '</title>\n' +
        '  <link rel="stylesheet" type="text/css" href="../styles/style.css" />\n' +
        '</head>\n' +
        '<body>\n' +
        '  <' + headingTag + '>' + chTitle + '</' + headingTag + '>\n' +
        '  ' + chBody + '\n' +
        '</body>\n' +
        '</html>';

      oebps.folder('chapters').file(chId + '.xhtml', xhtml);

      ch._fileId = chId;
      ch._fileName = 'chapters/' + chId + '.xhtml';

      manifestItems += '    <item id="' + chId + '" href="chapters/' + chId + '.xhtml" media-type="application/xhtml+xml"/>\n';
      spineItems += '    <itemref idref="' + chId + '"/>\n';
    }

    // 6. Inline TOC page (sumário no conteúdo)
    var tocPageHtml = buildInlineTocPage(bookIR, flatChapters, language);
    oebps.file('toc-page.xhtml', tocPageHtml);

    // 7. content.opf
    var coverMeta = '';
    var coverManifest = '';
    var coverSpine = '';
    var ext2 = coverMediaType.includes('png') ? 'png' : 'jpg';

    if (hasCover) {
      coverMeta = '    <meta name="cover" content="cover-image"/>\n';
      coverManifest =
        '    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>\n' +
        '    <item id="cover-image" href="images/cover.' + ext2 + '" media-type="' + coverMediaType + '" properties="cover-image"/>\n';
      coverSpine = '    <itemref idref="cover-page"/>\n';
    }

    // Imagens embutidas no conteúdo dos capítulos
    var inlineImageManifest = '';
    if (options.inlineImages) {
      var imageKeys = Object.keys(options.inlineImages);
      for (var j = 0; j < imageKeys.length; j++) {
        var imgData = options.inlineImages[imageKeys[j]];
        oebps.file('images/' + imgData.name, imgData.blob);
        var mime = imgData.blob.type || 'image/jpeg';
        var imgId = imgData.name.replace(/\.[^/.]+$/, "") + '-' + j;
        inlineImageManifest += '    <item id="img-' + imgId + '" href="images/' + imgData.name + '" media-type="' + mime + '"/>\n';
      }
    }

    // Rich metadata
    var descriptionMeta = '';
    if (meta.synopsis) {
      descriptionMeta = '    <dc:description>' + escapeXml(meta.synopsis) + '</dc:description>\n';
    }

    var subjectMeta = '';
    if (meta.genres && meta.genres.length > 0) {
      for (var g = 0; g < meta.genres.length; g++) {
        subjectMeta += '    <dc:subject>' + escapeXml(meta.genres[g]) + '</dc:subject>\n';
      }
    }

    var sourceMeta = '';
    if (meta.sourceUrl) {
      sourceMeta = '    <dc:source>' + escapeXml(meta.sourceUrl) + '</dc:source>\n';
    }

    var contentOpf =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="pub-id" version="3.0">\n' +
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      '    <dc:title>' + safeTitle + '</dc:title>\n' +
      '    <dc:creator>' + safeAuthor + '</dc:creator>\n' +
      '    <dc:language>' + language + '</dc:language>\n' +
      '    <dc:identifier id="pub-id">urn:uuid:' + uuid + '</dc:identifier>\n' +
      '    <dc:date>' + date + '</dc:date>\n' +
      '    <meta property="dcterms:modified">' + modified + '</meta>\n' +
      descriptionMeta +
      subjectMeta +
      sourceMeta +
      coverMeta +
      '  </metadata>\n' +
      '  <manifest>\n' +
      '    <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' +
      '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n' +
      '    <item id="style" href="styles/style.css" media-type="text/css"/>\n' +
      '    <item id="toc-page" href="toc-page.xhtml" media-type="application/xhtml+xml"/>\n' +
      coverManifest +
      inlineImageManifest +
      manifestItems +
      '  </manifest>\n' +
      '  <spine toc="ncx">\n' +
      coverSpine +
      '    <itemref idref="toc-page"/>\n' +
      spineItems +
      '  </spine>\n' +
      '</package>';

    oebps.file('content.opf', contentOpf);

    // 8. toc.xhtml (EPUB 3 Navigation — hierarchical)
    var navContent = buildHierarchicalNav(bookIR, flatChapters, language, hasCover);
    oebps.file('toc.xhtml', navContent);

    // 9. toc.ncx (EPUB 2 NCX — hierarchical)
    var ncxContent = buildHierarchicalNcx(bookIR, flatChapters, uuid, safeTitle, hasCover);
    oebps.file('toc.ncx', ncxContent);

    var outputType = (typeof window !== 'undefined' && typeof window.document !== 'undefined') ? 'blob' : 'uint8array';
    return zip.generateAsync({ type: outputType, mimeType: 'application/epub+zip' });
  }

// ── Achatamento de Nós para EPUB (preserva hierarquia) ──

  function flattenForEpub(nodes, result, pathStack) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.type === 'chapter') {
        result.push({
          title: node.title,
          content: node.content,
          order: node.order,
          sourceUrl: node.sourceUrl,
          depth: pathStack.length,
          parentType: pathStack.length > 0 ? pathStack[pathStack.length - 1].type : 'root',
          path: pathStack.map(function (p) { return p.title; })
        });
      } else if (node.children) {
        pathStack.push({ type: node.type, title: node.title });
        flattenForEpub(node.children, result, pathStack);
        pathStack.pop();
      }
    }
  }

// ── Sumário Hierárquico NAV.XHTML (EPUB 3) ──

  function buildHierarchicalNav(bookIR, flatChapters, language, hasCover) {
    var navOl = buildNavOlRecursive(bookIR.structure, flatChapters);

    var firstChId = flatChapters.length > 0 ? flatChapters[0]._fileId : 'chapter-001';

    var landmarksNav =
      '  <nav epub:type="landmarks" hidden="hidden">\n' +
      '    <h2>Referências</h2>\n' +
      '    <ol>\n' +
      (hasCover ? '      <li><a epub:type="cover" href="cover.xhtml">Capa</a></li>\n' : '') +
      '      <li><a epub:type="toc" href="toc-page.xhtml">Sumário</a></li>\n' +
      '      <li><a epub:type="bodymatter" href="chapters/' + firstChId + '.xhtml">Início do Texto</a></li>\n' +
      '    </ol>\n' +
      '  </nav>\n';

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="' + language + '" xml:lang="' + language + '">\n' +
      '<head>\n' +
      '  <meta charset="utf-8" />\n' +
      '  <title>Sumário</title>\n' +
      '  <link rel="stylesheet" type="text/css" href="styles/style.css"/>\n' +
      '</head>\n' +
      '<body>\n' +
      '  <nav epub:type="toc" id="toc">\n' +
      '    <h1>Sumário</h1>\n' +
      navOl +
      '  </nav>\n' +
      landmarksNav +
      '</body>\n' +
      '</html>';
  }

  function buildNavOlRecursive(nodes, flatChapters) {
    var html = '    <ol>\n';

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.type === 'chapter') {
        var flat = findFlatChapter(flatChapters, node.order);
        if (flat) {
          html += '      <li><a href="' + flat._fileName + '">' + escapeXml(node.title) + '</a></li>\n';
        }
      } else if (node.children && node.children.length > 0) {
        html += '      <li>\n';
        html += '        <span>' + escapeXml(node.title) + '</span>\n';
        html += buildNavOlRecursive(node.children, flatChapters);
        html += '      </li>\n';
      }
    }

    html += '    </ol>\n';
    return html;
  }

  function findFlatChapter(flatChapters, order) {
    for (var i = 0; i < flatChapters.length; i++) {
      if (flatChapters[i].order === order) return flatChapters[i];
    }
    return null;
  }

// ── Sumário Hierárquico NCX (EPUB 2) ──

  function buildHierarchicalNcx(bookIR, flatChapters, uuid, safeTitle, hasCover) {
    var maxDepth = 1;
    var playOrderCounter = { value: hasCover ? 2 : 1 };
    var navPointsXml = buildNcxNavPointsRecursive(bookIR.structure, flatChapters, playOrderCounter);

    // Calculate depth
    calculateMaxDepth(bookIR.structure, 1, { max: 1 });

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
      '  <head>\n' +
      '    <meta name="dtb:uid" content="urn:uuid:' + uuid + '"/>\n' +
      '    <meta name="dtb:depth" content="' + maxDepth + '"/>\n' +
      '    <meta name="dtb:totalPageCount" content="0"/>\n' +
      '    <meta name="dtb:maxPageNumber" content="0"/>\n' +
      '  </head>\n' +
      '  <docTitle>\n' +
      '    <text>' + safeTitle + '</text>\n' +
      '  </docTitle>\n' +
      '  <navMap>\n' +
      navPointsXml +
      '  </navMap>\n' +
      '</ncx>';
  }

  function calculateMaxDepth(nodes, currentDepth, tracker) {
    if (currentDepth > tracker.max) tracker.max = currentDepth;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].children) {
        calculateMaxDepth(nodes[i].children, currentDepth + 1, tracker);
      }
    }
  }

  function buildNcxNavPointsRecursive(nodes, flatChapters, playOrderCounter) {
    var xml = '';

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];

      if (node.type === 'chapter') {
        var flat = findFlatChapter(flatChapters, node.order);
        if (flat) {
          var po = playOrderCounter.value++;
          xml += '    <navPoint id="navPoint-' + po + '" playOrder="' + po + '">\n';
          xml += '      <navLabel><text>' + escapeXml(node.title) + '</text></navLabel>\n';
          xml += '      <content src="' + flat._fileName + '"/>\n';
          xml += '    </navPoint>\n';
        }
      } else if (node.children && node.children.length > 0) {
        // Volume/Arc: use first child chapter as content target
        var firstChildChapter = findFirstChapterInSubtree(node.children, flatChapters);
        if (firstChildChapter) {
          var poGroup = playOrderCounter.value++;
          xml += '    <navPoint id="navPoint-' + poGroup + '" playOrder="' + poGroup + '">\n';
          xml += '      <navLabel><text>' + escapeXml(node.title) + '</text></navLabel>\n';
          xml += '      <content src="' + firstChildChapter._fileName + '"/>\n';
          xml += buildNcxNavPointsRecursive(node.children, flatChapters, playOrderCounter);
          xml += '    </navPoint>\n';
        }
      }
    }

    return xml;
  }

  function findFirstChapterInSubtree(nodes, flatChapters) {
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].type === 'chapter') {
        return findFlatChapter(flatChapters, nodes[i].order);
      }
      if (nodes[i].children) {
        var result = findFirstChapterInSubtree(nodes[i].children, flatChapters);
        if (result) return result;
      }
    }
    return null;
  }

// ── Página de Sumário Embutida no Livro ──

  function buildInlineTocPage(bookIR, flatChapters, language) {
    var tocList = buildInlineTocListRecursive(bookIR.structure, flatChapters);

    var metadataHtml = '';
    var meta = bookIR.metadata;
    
    if (meta.fandom) {
      metadataHtml += '  <p><strong>Fandom:</strong> ' + escapeXml(meta.fandom) + '</p>\n';
    }
    if (meta.relationships && meta.relationships.length > 0) {
      metadataHtml += '  <p><strong>Casais/Relacionamentos:</strong> ' + escapeXml(meta.relationships.join(', ')) + '</p>\n';
    }
    if (meta.warnings && meta.warnings.length > 0) {
      metadataHtml += '  <p><strong>Avisos:</strong> ' + escapeXml(meta.warnings.join(', ')) + '</p>\n';
    }
    if (meta.rating) {
      metadataHtml += '  <p><strong>Classificação Indicativa:</strong> ' + escapeXml(meta.rating) + '</p>\n';
    }
    
    if (meta.synopsis) {
      metadataHtml +=
        '  <div class="synopsis">\n' +
        '    <p>' + escapeXml(meta.synopsis) + '</p>\n' +
        '  </div>\n';
    }

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" lang="' + language + '" xml:lang="' + language + '">\n' +
      '<head>\n' +
      '  <meta charset="utf-8" />\n' +
      '  <title>Sumário</title>\n' +
      '  <link rel="stylesheet" type="text/css" href="styles/style.css" />\n' +
      '</head>\n' +
      '<body class="toc-page">\n' +
      '  <h1>' + escapeXml(meta.title) + '</h1>\n' +
      '  <p><em>' + escapeXml(meta.author) + '</em></p>\n' +
      metadataHtml +
      '  <h2>Sumário</h2>\n' +
      tocList +
      '</body>\n' +
      '</html>';
  }

  function buildInlineTocListRecursive(nodes, flatChapters) {
    var html = '  <ol>\n';

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.type === 'chapter') {
        var flat = findFlatChapter(flatChapters, node.order);
        if (flat) {
          html += '    <li><a href="' + flat._fileName + '">' + escapeXml(node.title) + '</a></li>\n';
        }
      } else if (node.children && node.children.length > 0) {
        var cssClass = node.type === 'volume' ? 'volume-title' : 'arc-title';
        html += '    <li class="' + cssClass + '">' + escapeXml(node.title) + '\n';
        html += buildInlineTocListRecursive(node.children, flatChapters);
        html += '    </li>\n';
      }
    }

    html += '  </ol>\n';
    return html;
  }

// ── Geração Direta Legada (Fallback sem BookIR) ──

  async function buildEpubDirect(options) {
    var title = options.title || 'Downloaded Novel';
    var author = options.author || 'Unknown Author';
    var language = options.language || 'en';
    var coverImageBlob = options.coverImageBlob || null;
    var chapters = options.chapters || [];

    if (!self.JSZip && !globalThis.JSZip) {
      throw new Error('JSZip library is not loaded.');
    }

    var zip = new (self.JSZip || globalThis.JSZip)();
    var uuid = generateUUID();
    var date = new Date().toISOString().split('T')[0];
    var modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    var safeTitle = escapeXml(title);
    var safeAuthor = escapeXml(author);

    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

    zip.folder('META-INF').file('container.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '  <rootfiles>\n' +
      '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
      '  </rootfiles>\n' +
      '</container>'
    );

    var oebps = zip.folder('OEBPS');

    oebps.folder('styles').file('style.css',
      '@charset "utf-8";\nbody { font-family: serif; line-height: 1.65; margin: 5%; text-align: justify; }\n' +
      'h1, h2, h3 { font-family: sans-serif; text-align: center; margin-top: 1.8em; margin-bottom: 1em; }\n' +
      'p { margin-top: 0.6em; margin-bottom: 0.6em; text-indent: 1.5em; }\n' +
      'p.bilingual-translation { color: #555; font-style: italic; margin-top: 0.2em; }\n' +
      'img { max-width: 100%; height: auto; display: block; margin: 1.5em auto; }\n' +
      '.cover-page { text-align: center; padding: 0; margin: 0; height: 100%; }\n' +
      '.cover-page img { height: 100%; max-width: 100%; object-fit: contain; }\n'
    );

    var hasCover = false;
    var coverMediaType = 'image/jpeg';

    if (coverImageBlob) {
      hasCover = true;
      if (coverImageBlob.type) coverMediaType = coverImageBlob.type;
      var ext = coverMediaType.includes('png') ? 'png' : 'jpg';
      oebps.folder('images').file('cover.' + ext, coverImageBlob);
      oebps.file('cover.xhtml',
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml" lang="' + language + '" xml:lang="' + language + '">\n' +
        '<head><meta charset="utf-8" /><title>Capa</title><link rel="stylesheet" type="text/css" href="styles/style.css" /></head>\n' +
        '<body><div class="cover-page"><img src="images/cover.' + ext + '" alt="Capa" /></div></body>\n</html>'
      );
    }

    var manifestItems = '';
    var spineItems = '';
    var navLis = '';
    var ncxNavPoints = '';

    for (var i = 0; i < chapters.length; i++) {
      var chapter = chapters[i];
      var chIndex = i + 1;
      var chId = 'chapter-' + String(chIndex).padStart(3, '0');
      var chTitle = escapeXml(chapter.title || 'Capítulo ' + chIndex);
      var chBody = sanitizeXhtmlContent(chapter.content);

      oebps.folder('chapters').file(chId + '.xhtml',
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="' + language + '" xml:lang="' + language + '">\n' +
        '<head><meta charset="utf-8" /><title>' + chTitle + '</title><link rel="stylesheet" type="text/css" href="../styles/style.css" /></head>\n' +
        '<body><h2>' + chTitle + '</h2>\n' + chBody + '\n</body>\n</html>'
      );

      manifestItems += '    <item id="' + chId + '" href="chapters/' + chId + '.xhtml" media-type="application/xhtml+xml"/>\n';
      spineItems += '    <itemref idref="' + chId + '"/>\n';
      navLis += '        <li><a href="chapters/' + chId + '.xhtml">' + chTitle + '</a></li>\n';
      var playOrder = hasCover ? chIndex + 1 : chIndex;
      ncxNavPoints +=
        '    <navPoint id="navPoint-' + chIndex + '" playOrder="' + playOrder + '">\n' +
        '      <navLabel><text>' + chTitle + '</text></navLabel>\n' +
        '      <content src="chapters/' + chId + '.xhtml"/>\n' +
        '    </navPoint>\n';
    }

    var coverMeta2 = '';
    var coverManifest2 = '';
    var coverSpine2 = '';
    var ext3 = coverMediaType.includes('png') ? 'png' : 'jpg';
    if (hasCover) {
      coverMeta2 = '    <meta name="cover" content="cover-image"/>\n';
      coverManifest2 = '    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>\n' +
        '    <item id="cover-image" href="images/cover.' + ext3 + '" media-type="' + coverMediaType + '" properties="cover-image"/>\n';
      coverSpine2 = '    <itemref idref="cover-page"/>\n';
    }

    var inlineImageManifest2 = '';
    if (options.inlineImages) {
      var imageKeys2 = Object.keys(options.inlineImages);
      for (var k = 0; k < imageKeys2.length; k++) {
        var imgData2 = options.inlineImages[imageKeys2[k]];
        oebps.file('images/' + imgData2.name, imgData2.blob);
        var mime2 = imgData2.blob.type || 'image/jpeg';
        var imgId2 = imgData2.name.replace(/\.[^/.]+$/, "") + '-' + k;
        inlineImageManifest2 += '    <item id="img-' + imgId2 + '" href="images/' + imgData2.name + '" media-type="' + mime2 + '"/>\n';
      }
    }

    oebps.file('content.opf',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="pub-id" version="3.0">\n' +
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      '    <dc:title>' + safeTitle + '</dc:title>\n' +
      '    <dc:creator>' + safeAuthor + '</dc:creator>\n' +
      '    <dc:language>' + language + '</dc:language>\n' +
      '    <dc:identifier id="pub-id">urn:uuid:' + uuid + '</dc:identifier>\n' +
      '    <dc:date>' + date + '</dc:date>\n' +
      '    <meta property="dcterms:modified">' + modified + '</meta>\n' +
      coverMeta2 +
      '  </metadata>\n' +
      '  <manifest>\n' +
      '    <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' +
      '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n' +
      '    <item id="style" href="styles/style.css" media-type="text/css"/>\n' +
      coverManifest2 +
      inlineImageManifest2 +
      manifestItems +
      '  </manifest>\n' +
      '  <spine toc="ncx">\n' +
      coverSpine2 +
      spineItems +
      '  </spine>\n' +
      '</package>'
    );

    oebps.file('toc.xhtml',
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="' + language + '" xml:lang="' + language + '">\n' +
      '<head><meta charset="utf-8" /><title>Sumário</title><link rel="stylesheet" type="text/css" href="styles/style.css"/></head>\n' +
      '<body><nav epub:type="toc" id="toc"><h1>Sumário</h1><ol>\n' + navLis + '</ol></nav></body>\n</html>'
    );

    oebps.file('toc.ncx',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
      '  <head><meta name="dtb:uid" content="urn:uuid:' + uuid + '"/><meta name="dtb:depth" content="1"/>' +
      '<meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>\n' +
      '  <docTitle><text>' + safeTitle + '</text></docTitle>\n' +
      '  <navMap>\n' + ncxNavPoints + '  </navMap>\n</ncx>'
    );

    var outputType = (typeof window !== 'undefined' && typeof window.document !== 'undefined') ? 'blob' : 'uint8array';
    return zip.generateAsync({ type: outputType, mimeType: 'application/epub+zip' });
  }

  return {
    buildEpub: buildEpub,
    buildEpubFromIR: buildEpubFromIR,
    sanitizeFilename: sanitizeFilename
  };
})();
