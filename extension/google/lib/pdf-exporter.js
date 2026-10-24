/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file pdf-exporter.js
 * @description Exportador de PDF via jsPDF. Gera documentos formatados com
 *              capa, sumário visual, bookmarks/outlines nativos e paginação elegante.
 *
 * @pipeline BookIR → PdfExporter → jsPDF → Arquivo .pdf
 * @requires window.jspdf
 */

self.PdfExporter = (function () {
  'use strict';

// ── DECODIFICADOR DE ENTIDADES HTML ──

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
   * Decodifica entidades HTML (nomeadas e numéricas) para texto plano Unicode.
   * Cobre aspas tipograficas, travessoes, reticencias e simbolos comuns.
   * @param {string} str
   * @returns {string}
   */
  function decodeEntities(str) {
    if (!str || !str.includes('&')) return str;
    // Entidades numericas: &#160; ou &#xA0;
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

// ── STRIP HTML -> TEXTO PLANO ──

  function stripHtml(html) {
    if (!html) return '';
    var text = html
      .replace(/<\/p>/gi,      '\n\n')
      .replace(/<\/div>/gi,    '\n\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g,     '');
    text = decodeEntities(text);
    return text.replace(/\n{3,}/g, '\n\n').trim();
  }

// ── HELPERS DE IMAGEM ──

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () { resolve(reader.result); };
      reader.onerror   = reject;
      reader.readAsDataURL(blob);
    });
  }

  function getImageDimensions(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload  = function () { resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = reject;
      img.src     = dataUrl;
    });
  }

  function convertToJpegDataUrl(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/jpeg', 0.9));
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

// ── HELPER DE PÁGINA ──

  /**
   * Escrita de texto com quebra de página antecipada.
   * Calcula a altura necessária ANTES de escrever — se não couber na página
   * atual, adiciona nova página primeiro.
   *
   * @param {object}   doc         - instância jsPDF
   * @param {string[]} lines       - linhas já divididas por splitTextToSize()
   * @param {number}   x           - posição X
   * @param {number}   yRef        - objeto {y} passado por referência
   * @param {number}   lineH       - altura de cada linha em mm
   * @param {object}   pageLimits  - { pageHeight, margin }
   * @param {object}   pageCounter - { current } para contar páginas
   */
  function writeLines(doc, lines, x, yRef, lineH, pageLimits, pageCounter) {
    for (var li = 0; li < lines.length; li++) {
      // Calcula a posição FINAL desta linha antes de escrevê-la
      if (yRef.y + lineH > pageLimits.pageHeight - pageLimits.margin) {
        doc.addPage();
        pageCounter.current++;
        yRef.y = pageLimits.margin;
      }
      doc.text(lines[li], x, yRef.y);
      yRef.y += lineH;
    }
  }

// ── CAPA ──

  function renderTitlePage(doc, meta, pageWidth, pageHeight, margin, fontSize) {
    var centerY = pageHeight * 0.35;

    doc.setFontSize(fontSize.title);
    doc.setFont('helvetica', 'bold');
    var titleLines = doc.splitTextToSize(meta.title, pageWidth - margin * 2);
    doc.text(titleLines, pageWidth / 2, centerY, { align: 'center' });

    var authorY = centerY + titleLines.length * 9 + 10;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'italic');
    doc.text(meta.author, pageWidth / 2, authorY, { align: 'center' });

    if (meta.genres && meta.genres.length > 0) {
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.text(meta.genres.join(' \u2022 '), pageWidth / 2, authorY + 12, { align: 'center' });
    }

    if (meta.status && meta.status !== 'unknown') {
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      var statusText = meta.status === 'ongoing' ? 'Em Andamento' : 'Completa';
      doc.text(statusText, pageWidth / 2, pageHeight - margin, { align: 'center' });
    }
  }

// ── SUMÁRIO ──

  function buildTocEntries(nodes, entries, depth) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.type === 'chapter') {
        entries.push({ title: node.title, depth: depth, isGroup: false });
      } else if (node.children) {
        entries.push({ title: node.title, depth: depth, isGroup: true });
        buildTocEntries(node.children, entries, depth + 1);
      }
    }
  }

// ── FALLBACK: percorrer estrutura manualmente (sem BookIR global) ──

  function walkForPdf(nodes, result, currentPath) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.type === 'chapter') {
        result.push({
          order:     node.order,
          title:     node.title,
          content:   node.content,
          sourceUrl: node.sourceUrl,
          path:      currentPath.slice()
        });
      } else if (node.children) {
        var newPath = currentPath.concat([node.title]);
        walkForPdf(node.children, result, newPath);
      }
    }
  }

// ── EXPORTADOR PRINCIPAL ──

  /**
   * Exporta uma BookIR como arquivo PDF com capa, sumário, outline e capítulos.
   *
   * @param {object} bookIR   - A BookIR completa com conteúdo nos capítulos
   * @param {object} [options] - { coverImageBlob, inlineImages }
   * @returns {Promise<Blob>} PDF blob
   */
  async function exportPdf(bookIR, options) {
    options = options || {};

    if (!self.jspdf && !self.jsPDF) {
      throw new Error('jsPDF library não carregada.');
    }

    var jsPDFClass = (self.jspdf && self.jspdf.jsPDF) || self.jsPDF;
    var doc = new jsPDFClass({
      orientation: 'portrait',
      unit:        'mm',
      format:      'a4'
    });

    var meta        = bookIR.metadata || {};
    var pageWidth   = doc.internal.pageSize.getWidth();
    var pageHeight  = doc.internal.pageSize.getHeight();
    var margin      = 20;
    var contentWidth = pageWidth - margin * 2;
    var lineHeight   = 6;

    var fontSize = {
      title:          22,
      volumeHeading:  16,
      arcHeading:     14,
      chapterHeading: 13,
      body:           11,
      toc:            10,
      tocHeading:     14,
      meta:           9
    };

    var pageLimits  = { pageHeight: pageHeight, margin: margin };
    var pageCounter = { current: 1 };

    // PDF metadata
    doc.setProperties({
      title:    meta.title   || '',
      author:   meta.author  || '',
      subject:  meta.synopsis || '',
      keywords: (meta.genres || []).join(', '),
      creator:  'Novels Downloader & Translator'
    });

// ── 1. CAPA ──

    if (options.coverImageBlob) {
      try {
        var imgData = await blobToDataUrl(options.coverImageBlob);
        var imgType = options.coverImageBlob.type.includes('png') ? 'PNG' : 'JPEG';

        var maxImgWidth  = pageWidth  - margin * 2;
        var maxImgHeight = pageHeight * 0.6;
        var dims  = await getImageDimensions(imgData);
        var scale = Math.min(maxImgWidth / dims.width, maxImgHeight / dims.height);
        var imgW  = dims.width  * scale;
        var imgH  = dims.height * scale;
        var imgX  = (pageWidth - imgW) / 2;
        var imgY  = margin;

        doc.addImage(imgData, imgType, imgX, imgY, imgW, imgH);

        var titleY = imgY + imgH + 15;
        doc.setFontSize(fontSize.title);
        doc.setFont('helvetica', 'bold');
        var titleLines = doc.splitTextToSize(meta.title || '', contentWidth);
        doc.text(titleLines, pageWidth / 2, titleY, { align: 'center' });

        var authorY = titleY + titleLines.length * 8 + 5;
        doc.setFontSize(12);
        doc.setFont('helvetica', 'italic');
        doc.text(meta.author || '', pageWidth / 2, authorY, { align: 'center' });

      } catch (coverErr) {
        console.warn('[PDF] Falha ao inserir capa:', coverErr);
        renderTitlePage(doc, meta, pageWidth, pageHeight, margin, fontSize);
      }
    } else {
      renderTitlePage(doc, meta, pageWidth, pageHeight, margin, fontSize);
    }

// ── 2. SUMÁRIO ──

    doc.addPage();
    pageCounter.current++;

    doc.setFontSize(fontSize.tocHeading);
    doc.setFont('helvetica', 'bold');
    doc.text('Sum\u00E1rio', pageWidth / 2, margin + 5, { align: 'center' });

    var tocY = margin + 18;

    if (meta.synopsis) {
      doc.setFontSize(fontSize.meta);
      doc.setFont('helvetica', 'italic');
      var synopsisLines = doc.splitTextToSize(decodeEntities(meta.synopsis), contentWidth);
      var maxSynLines   = Math.min(synopsisLines.length, 8);
      for (var si = 0; si < maxSynLines; si++) {
        doc.text(synopsisLines[si], margin, tocY);
        tocY += 4;
      }
      tocY += 6;
    }

    doc.setFontSize(fontSize.toc);
    var tocEntries = [];
    buildTocEntries(bookIR.structure, tocEntries, 0);

    for (var ti = 0; ti < tocEntries.length; ti++) {
      var entry  = tocEntries[ti];
      var indent = margin + entry.depth * 8;

      if (tocY > pageHeight - margin) {
        doc.addPage();
        pageCounter.current++;
        tocY = margin + 5;
      }

      doc.setFont('helvetica', entry.isGroup ? 'bold' : 'normal');
      doc.text(entry.title, indent, tocY);
      tocY += 5;
    }

// ── 3. CAPÍTULOS com Outline (Bookmarks) ──

    var flatChapters = [];
    if (self.BookIR) {
      flatChapters = self.BookIR.flattenIR(bookIR);
    } else {
      walkForPdf(bookIR.structure, flatChapters, []);
    }

    // Outline raiz do documento (bookmarks clicáveis no leitor PDF).
    // Suportado por Adobe Acrobat, Evince, SumatraPDF, Chrome PDF Viewer.
    // jsPDF expõe outline via doc.outline (disponível em jsPDF >= 2.x).
    var outlineRoot = null;
    if (doc.outline && typeof doc.outline.add === 'function') {
      outlineRoot = doc.outline;
    }

    // Mapa de grupos do outline por caminho hierárquico (volume/arco)
    var outlineGroups = {};

    var currentVolumeTitle = '';

    for (var ci = 0; ci < flatChapters.length; ci++) {
      var ch = flatChapters[ci];

      doc.addPage();
      pageCounter.current++;

      var yRef = { y: margin };

      // Volume/arc heading se o caminho hierárquico mudou
      if (ch.path && ch.path.length > 0) {
        var pathStr = ch.path.join(' > ');
        if (pathStr !== currentVolumeTitle) {
          currentVolumeTitle = pathStr;
          doc.setFontSize(fontSize.volumeHeading);
          doc.setFont('helvetica', 'bold');
          var volLines = doc.splitTextToSize(pathStr, contentWidth);
          // Calcula altura antes de escrever (quebra de página antecipada)
          var volHeight = volLines.length * 7;
          if (yRef.y + volHeight > pageHeight - margin) {
            doc.addPage();
            pageCounter.current++;
            yRef.y = margin;
          }
          doc.text(volLines, pageWidth / 2, yRef.y, { align: 'center' });
          yRef.y += volHeight + 5;
        }
      }

      // Título do capítulo
      doc.setFontSize(fontSize.chapterHeading);
      doc.setFont('helvetica', 'bold');
      var chTitleLines = doc.splitTextToSize(ch.title || '', contentWidth);
      var chTitleHeight = chTitleLines.length * 6;
      if (yRef.y + chTitleHeight + 8 > pageHeight - margin) {
        doc.addPage();
        pageCounter.current++;
        yRef.y = margin;
      }
      doc.text(chTitleLines, pageWidth / 2, yRef.y, { align: 'center' });
      yRef.y += chTitleHeight + 8;

      // ── Outline: adiciona bookmark para este capítulo ──────────────────────
      // Os bookmarks ficam visíveis no painel de navegação dos leitores PDF.
      if (outlineRoot) {
        try {
          var pathKey     = ch.path && ch.path.length > 0 ? ch.path.join('/') : '';
          var parentNode  = outlineRoot;

          // Cria nós de grupo (volume/arco) no outline se ainda não existem
          if (pathKey) {
            if (!outlineGroups[pathKey]) {
              outlineGroups[pathKey] = outlineRoot.add(null, ch.path[ch.path.length - 1]);
            }
            parentNode = outlineGroups[pathKey];
          }

          parentNode.add(null, ch.title || ('Cap\u00EDtulo ' + (ci + 1)));
        } catch (_e) {
          // jsPDF < 2.x não tem outline.add — ignora silenciosamente
        }
      }

      // ── Imagens de mangá/cómic (full-page) ────────────────────────────────
      if (ch.content && ch.content.includes('<div class="manga-page">') && options.inlineImages) {
        var imgRegex   = /<img[^>]+src=["'](?:\.\.\/images\/)?([^"']+)["'][^>]*>/gi;
        var hasImages  = false;
        var mMatch;   // declaração explícita — evita ReferenceError em 'use strict'

        while ((mMatch = imgRegex.exec(ch.content)) !== null) {
          hasImages = true;
          var imgName   = mMatch[1];
          var sessionImg = Object.values(options.inlineImages).find(function (si) {
            return si.name === imgName;
          });

          if (sessionImg && sessionImg.blob) {
            try {
              var mData = await blobToDataUrl(sessionImg.blob);
              // WebP/AVIF/GIF: jsPDF não suporta — converte para JPEG via Canvas
              if (/image\/(webp|avif|gif)/.test(mData)) {
                mData = await convertToJpegDataUrl(mData);
              }
              var mType = mData.indexOf('image/png') !== -1 ? 'PNG' : 'JPEG';
              var mDims = await getImageDimensions(mData);

              doc.addPage();
              pageCounter.current++;

              var mScale = Math.min(pageWidth / mDims.width, pageHeight / mDims.height);
              var mW = mDims.width  * mScale;
              var mH = mDims.height * mScale;
              var mX = (pageWidth  - mW) / 2;
              var mY = (pageHeight - mH) / 2;

              doc.addImage(mData, mType, mX, mY, mW, mH);
            } catch (imgErr) {
              console.warn('[PDF] Erro ao inserir imagem mangá:', imgErr);
            }
          }
        }
        if (hasImages) continue;
      }

      // ── Texto do capítulo ──────────────────────────────────────────────────
      doc.setFontSize(fontSize.body);
      doc.setFont('helvetica', 'normal');

      var bodyText   = stripHtml(ch.content || '');
      var paragraphs = bodyText.split(/\n\s*\n+/).filter(function (p) { return p.trim().length > 0; });

      for (var pi = 0; pi < paragraphs.length; pi++) {
        var para      = paragraphs[pi].trim();
        var paraLines = doc.splitTextToSize(para, contentWidth);

        // writeLines: calcula altura ANTES de escrever cada linha
        writeLines(doc, paraLines, margin, yRef, lineHeight, pageLimits, pageCounter);
        yRef.y += 2; // espaçamento entre parágrafos
      }
    }

// ── 4. NUMERAÇÃO DE PÁGINAS ──

    var totalPages = doc.internal.getNumberOfPages();
    for (var p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(150);
      doc.text(String(p) + ' / ' + String(totalPages), pageWidth / 2, pageHeight - 8, { align: 'center' });
      doc.setTextColor(0);
    }

    return doc.output('blob');
  }

  return {
    exportPdf: exportPdf
  };
})();
