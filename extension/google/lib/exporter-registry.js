/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file exporter-registry.js
 * @description Registro genérico extensível de exportadores de livros.
 *              Permite plugar e desacoplar formatos (EPUB, PDF, CBZ, TXT, MD)
 *              sem alterar a arquitetura central da aplicação.
 *
 * @pipeline Dashboard → ExporterRegistry ⇄ Specific Exporter
 */

self.ExporterRegistry = (function () {
  'use strict';

  var exporters = {};

  /**
   * Registra um exportador.
   * IDs são normalizados para minúsculas para evitar duplicatas por capitalização.
   *
   * @param {string} formatId - Identificador único (ex: 'epub', 'pdf', 'txt')
   * @param {object} config
   * @param {string}   config.label     - Nome legível (ex: 'EPUB 3.0')
   * @param {string}   config.extension - Extensão do arquivo (ex: '.epub')
   * @param {string}   config.icon      - Emoji ou ícone (ex: '📚')
   * @param {function} config.exportFn  - Função async (bookIR, options) => Blob
   */
  function register(formatId, config) {
    if (!formatId || !config || typeof config.exportFn !== 'function') {
      throw new Error('ExporterRegistry.register: formatId e exportFn são obrigatórios.');
    }

    // Normalização: todos os IDs são lowercase para evitar 'EPUB' vs 'epub'
    var id = String(formatId).toLowerCase();

    // Aviso ao sobrescrever exportador existente (hot-reload em dev)
    if (exporters[id]) {
      console.warn(
        '[ExporterRegistry] Sobrescrevendo exportador existente: "' + id + '".' +
        ' Se isso não for intencional, verifique duplicatas no registro.'
      );
    }

    exporters[id] = {
      id:        id,
      label:     config.label     || id.toUpperCase(),
      extension: config.extension || ('.' + id),
      icon:      config.icon      || '\u{1F4C4}',
      exportFn:  config.exportFn
    };
  }

  /**
   * Remove um exportador do registry.
   * Útil em hot-reload de desenvolvimento ou para desativar formatos dinamicamente.
   *
   * @param {string} formatId
   * @returns {boolean} true se existia e foi removido
   */
  function unregister(formatId) {
    var id = String(formatId).toLowerCase();
    if (exporters[id]) {
      delete exporters[id];
      return true;
    }
    return false;
  }

  /**
   * Lista todos os exportadores registrados.
   *
   * @returns {Array<{id, label, extension, icon}>}
   */
  function list() {
    return Object.keys(exporters).map(function (key) {
      var exp = exporters[key];
      return {
        id:        exp.id,
        label:     exp.label,
        extension: exp.extension,
        icon:      exp.icon
      };
    });
  }

  /**
   * Exporta um livro usando o exportador especificado.
   * Valida que o retorno da exportFn é um Blob antes de retornar.
   *
   * @param {string} formatId - ID do formato registrado
   * @param {object} bookIR   - A BookIR completa
   * @param {object} [options]- Opções adicionais para o exportador
   * @returns {Promise<Blob>}
   */
  async function exportBook(formatId, bookIR, options) {
    var id       = String(formatId).toLowerCase();
    var exporter = exporters[id];

    if (!exporter) {
      var available = Object.keys(exporters).join(', ') || '(nenhum registrado)';
      throw new Error(
        'ExporterRegistry: formato "' + formatId + '" não registrado.' +
        ' Disponíveis: ' + available
      );
    }

    var result = await exporter.exportFn(bookIR, options || {});

    // Valida que o exportador retornou um Blob — evita erros silenciosos
    // que só aparecem ao tentar fazer o download do arquivo.
    if (!(result instanceof Blob)) {
      throw new Error(
        'ExporterRegistry: exportador "' + id + '" retornou ' +
        (result === null ? 'null' : typeof result) +
        ' em vez de um Blob. Verifique a implementação de exportFn.'
      );
    }

    return result;
  }

  /**
   * Verifica se um formato está registrado.
   *
   * @param {string} formatId
   * @returns {boolean}
   */
  function has(formatId) {
    return String(formatId).toLowerCase() in exporters;
  }

  /**
   * Obtém a extensão de arquivo para um formato.
   *
   * @param {string} formatId
   * @returns {string} extensão com ponto (ex: '.epub') ou '' se não registrado
   */
  function getExtension(formatId) {
    var id  = String(formatId).toLowerCase();
    return exporters[id] ? exporters[id].extension : '';
  }

  return {
    register:     register,
    unregister:   unregister,
    list:         list,
    export:       exportBook,
    has:          has,
    getExtension: getExtension
  };
})();
