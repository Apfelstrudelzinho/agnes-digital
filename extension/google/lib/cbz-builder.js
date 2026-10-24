/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file cbz-builder.js
 * @description Exportador CBZ (Comic Book ZIP) para mangás, manhwas e webtoons.
 *              Embala imagens com numeração padded consistente e metadados ComicInfo.xml.
 *
 * @pipeline BookIR → CbzBuilder → JSZip → Arquivo .cbz
 * @requires window.JSZip
 */

self.CbzBuilder = (function () {
  'use strict';

  // Zero-padding de 4 dígitos
  function padNum(num, digits) {
    return String(num).padStart(digits || 4, '0');
  }

  // Extrai extensão de arquivo a partir do MIME type ou nome de arquivo.
  function extFromMime(mimeType, fallbackName) {
    const mimeMap = {
      'image/jpeg': 'jpg', 'image/jpg': 'jpg',
      'image/png':  'png', 'image/gif': 'gif',
      'image/webp': 'webp','image/avif': 'avif',
    };
    if (mimeType && mimeMap[mimeType.toLowerCase()]) {
      return mimeMap[mimeType.toLowerCase()];
    }
    // Fallback: extrai do nome do arquivo
    if (fallbackName) {
      const parts = fallbackName.split('.');
      if (parts.length > 1) return parts.pop().toLowerCase();
    }
    return 'jpg';
  }

  /**
   * Gera o XML de metadados ComicInfo.xml
   */
  function buildComicInfoXml(meta, totalImages) {
    const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      '           xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
      `  <Title>${esc(meta.title)}</Title>`,
      `  <Writer>${esc(meta.author)}</Writer>`,
      `  <Genre>${esc((meta.genres || []).join(', '))}</Genre>`,
      `  <Summary>${esc(meta.synopsis)}</Summary>`,
      `  <PageCount>${totalImages}</PageCount>`,
      // Manga mode: "YesAndRightToLeft" = leitura esquerda→direita (manhwa/webtoon/manhua)
      // "Yes" = direita→esquerda (manga japonês), "No" = ocidental
      // Leitores como Komga e Kavita ativam rolagem vertical contínua com YesAndRightToLeft
      `  <Manga>${esc(meta.mangaMode || 'Yes')}</Manga>`,
      `  <LanguageISO>${esc(meta.language || 'pt')}</LanguageISO>`,
      '</ComicInfo>'
    ].join('\n');
  }

  /**
   * Gera um arquivo CBZ a partir de um BookIR com imagens inline.
   * @param {Object} bookIR
   * @param {Object} [options]
   * @param {Object} [options.inlineImages] - Mapa de imagens { name, blob, mimeType }
   * @returns {Promise<Blob>}
   */
  async function buildCbz(bookIR, options) {
    options = options || {};
    const zip          = new JSZip();
    const inlineImages = options.inlineImages || {};
    let   totalImages  = 0;

    // ── Constrói índice O(1) de imagens por nome ─
    const imageIndex = new Map();
    Object.values(inlineImages).forEach(img => {
      if (img && img.name) imageIndex.set(img.name, img);
    });

    const meta         = bookIR.metadata || {};
    const flatChapters = (self.BookIR ? self.BookIR.flattenIR(bookIR) : null)
      || bookIR.structure
      || [];

    for (let ci = 0; ci < flatChapters.length; ci++) {
      const ch = flatChapters[ci];
      if (!ch.content) continue;

      // Pasta do capítulo com zero-padding de 4 dígitos
      const safeName   = (ch.title || `Capitulo_${ci + 1}`)
        .replace(/[^a-z0-9\-_ ]/gi, '_')
        .substring(0, 60);
      const folderName = `${padNum(ci + 1)}_${safeName}`;

      // ── Regex com lastIndex resetado para evitar bug de estado global ─
      const imgRegex = /<img[^>]+src=["'](?:\.\.\/images\/)?([^"']+)["'][^>]*>/gi;
      imgRegex.lastIndex = 0;

      let imgIndexInChapter = 0;
      let match;

      while ((match = imgRegex.exec(ch.content)) !== null) {
        const imgName    = match[1];
        const sessionImg = imageIndex.get(imgName); // O(1) via Map

        if (sessionImg && sessionImg.blob) {
          imgIndexInChapter++;
          totalImages++;

          // Extensão correta a partir do MIME type real do blob
          const ext      = extFromMime(sessionImg.blob.type || sessionImg.mimeType, sessionImg.name);
          const fileName = `${padNum(imgIndexInChapter)}.${ext}`;

          zip.file(`${folderName}/${fileName}`, sessionImg.blob);
        }
      }
    }

    if (totalImages === 0) {
      throw new Error('Nenhuma imagem encontrada para gerar o arquivo CBZ.');
    }

    // ── ComicInfo.xml na raiz ──
    const comicInfoXml = buildComicInfoXml(meta, totalImages);
    zip.file('ComicInfo.xml', comicInfoXml);

    return await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  }

  return { buildCbz };
})();
