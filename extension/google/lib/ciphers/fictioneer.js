/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file fictioneer.js
 * @description Módulo de deofuscação para temas WordPress Fictioneer.
 *              Decodifica atributos multipart data-poly utilizando rotação ROT13
 *              e decodificação Base64/URI.
 *
 * @pipeline Scanner / Dashboard → FictioneerDecoder → ChapterExtractor
 * @requires window.AgnesLog
 */

'use strict';

(function () {
  /**
   * Decodifica conteúdo protegido por tema Fictioneer (ROT13 + Base64 multipart).
   * @param {string} htmlString - HTML bruto contendo tags data-poly e data-total.
   * @returns {string|null} HTML do capítulo deofuscado ou null se não for Fictioneer.
   */
  function decryptFictioneerContent(htmlString) {
    if (!htmlString || typeof htmlString !== 'string') return null;

    const polyMatch  = htmlString.match(/data-poly="([^"]+)"/);
    const totalMatch = htmlString.match(/data-total="(\d+)"/);
    if (!polyMatch || !totalMatch) return null;

    const prefix = polyMatch[1];
    const total  = parseInt(totalMatch[1], 10);
    let encryptedText = '';

    for (let i = 0; i < total; i++) {
      const chunkRegex = new RegExp(`data-${prefix}-${i}="([^"]+)"`);
      const chunkMatch = htmlString.match(chunkRegex);
      if (chunkMatch) encryptedText += chunkMatch[1];
    }

    function rot13(str) {
      return str.replace(/[a-zA-Z]/g, function (c) {
        const base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
      });
    }

    try {
      return decodeURIComponent(atob(rot13(encryptedText)));
    } catch (e) {
      if (typeof AgnesLog !== 'undefined') {
        AgnesLog.error('Fictioneer', 'Falha na conversão Base64/URI:', e);
      }
      return null;
    }
  }

  // Exportação no escopo global
  window.FictioneerDecoder = {
    decrypt: decryptFictioneerContent
  };

  // Compatibilidade com código legado
  window.decryptFictioneerContent = decryptFictioneerContent;
})();
