/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file book-ir.js
 * @description Representação Intermediária canônica (BookIR) para livros e quadrinhos.
 *              Desacopla a extração de sites dos formatos de saída (EPUB, PDF, TXT, etc.),
 *              mantendo metadados ricos e hierarquia de volumes/arcos/capítulos.
 *
 * @pipeline Scanner → ChapterExtractor → BookIR → Exporters
 */

self.BookIR = (function () {
  'use strict';

// ── CRIAÇÃO DA IR ──

  /**
   * Cria uma BookIR a partir de metadados e uma lista plana de capítulos.
   * Camada de adaptação para parsers que ainda não emitem hierarquia.
   *
   * @param {object} metadata - { title, author, coverUrl, synopsis, genres, status, sourceUrl, language }
   * @param {Array<{title, url, content?}>} flatChapters - Lista plana de capítulos
   * @returns {object} BookIR
   */
  function createBookIR(metadata, flatChapters) {
    var chapters = (flatChapters || []).map(function (ch, i) {
      return {
        type:      'chapter',
        title:     ch.title     || ('Capítulo ' + (i + 1)),
        order:     i,
        content:   ch.content   || '',
        sourceUrl: ch.url || ch.sourceUrl || ''
      };
    });

    return {
      metadata:  normalizeMetadata(metadata),
      structure: chapters
    };
  }

  /**
   * Cria uma BookIR a partir de dados com hierarquia (volumes/arcos/capítulos).
   *
   * @param {object} metadata - Metadados do livro
   * @param {Array<StructureNode>} structuredData - Árvore hierárquica de nós
   * @returns {object} BookIR
   */
  function createBookIRWithHierarchy(metadata, structuredData) {
    var orderCounter = { value: 0 };
    var normalized   = normalizeStructure(structuredData || [], orderCounter);

    return {
      metadata:  normalizeMetadata(metadata),
      structure: normalized
    };
  }

  /**
   * Normaliza metadados garantindo todos os campos com valores default.
   */
  function normalizeMetadata(meta) {
    var m = meta || {};
    return {
      title:         m.title         || 'Novel Sem Título',
      author:        m.author        || 'Autor Desconhecido',
      coverUrl:      m.coverUrl      || '',
      synopsis:      m.synopsis      || '',
      genres:        Array.isArray(m.genres)        ? m.genres        : [],
      status:        (['ongoing','completed','unknown'].indexOf(m.status) !== -1) ? m.status : 'unknown',
      sourceUrl:     m.sourceUrl     || '',
      language:      m.language      || 'pt',
      fandom:        m.fandom        || null,
      warnings:      Array.isArray(m.warnings)      ? m.warnings      : [],
      relationships: Array.isArray(m.relationships) ? m.relationships : [],
      rating:        m.rating        || null
    };
  }

  /**
   * Normaliza nós da estrutura recursivamente, atribuindo `order` a capítulos.
   *
   * Fallback hierárquico aprimorado:
   * - `type === 'chapter'`       → capítulo normal
   * - `type === 'volume'|'arc'`  → container com children
   * - nó com `children` (type desconhecido) → trata como container, não capítulo
   *   (evita que volumes sem type explícito virem capítulos fantasmas)
   * - qualquer outro tipo        → capítulo (last resort)
   */
  function normalizeStructure(nodes, orderCounter) {
    if (!Array.isArray(nodes)) return [];

    return nodes.map(function (node) {
      if (node.type === 'chapter') {
        return {
          type:      'chapter',
          title:     node.title || ('Capítulo ' + (orderCounter.value + 1)),
          order:     orderCounter.value++,
          content:   node.content   || '',
          sourceUrl: node.url || node.sourceUrl || ''
        };
      }

      if (node.type === 'volume' || node.type === 'arc') {
        return {
          type:     node.type,
          title:    node.title || (node.type === 'volume' ? 'Volume' : 'Arco'),
          children: normalizeStructure(node.children || [], orderCounter)
        };
      }

      // Fallback hierárquico: nó com children mas type desconhecido → container.
      if (node.children && Array.isArray(node.children) && node.children.length > 0) {
        return {
          type:     'arc',
          title:    node.title || 'Seção',
          children: normalizeStructure(node.children, orderCounter)
        };
      }

      // Último recurso: trata como capítulo simples
      return {
        type:      'chapter',
        title:     node.title || ('Capítulo ' + (orderCounter.value + 1)),
        order:     orderCounter.value++,
        content:   node.content   || '',
        sourceUrl: node.url || node.sourceUrl || ''
      };
    });
  }

// ── TRAVESSIA E MANIPULAÇÃO ──

  /**
   * Percorre a árvore recursivamente e retorna um array linear de capítulos
   * com informação de caminho hierárquico.
   *
   * @param {object} bookIR - A BookIR completa
   * @returns {Array<{order, title, content, sourceUrl, path: string[]}>}
   */
  function flattenIR(bookIR) {
    var result = [];
    flattenNodes(bookIR.structure, [], result);
    return result;
  }

  function flattenNodes(nodes, currentPath, result) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.type === 'chapter') {
        node.path = currentPath.slice();
        result.push(node);
      } else if (node.children) {
        var newPath = currentPath.concat([node.title]);
        flattenNodes(node.children, newPath, result);
      }
    }
  }

  /**
   * Visitor pattern para percorrer a árvore.
   * O visitor recebe (node, depth, parentNode).
   *
   * @param {Array<StructureNode>} nodes
   * @param {function} visitor
   * @param {number}   [depth=0]
   * @param {object}   [parent=null]
   */
  function walkStructure(nodes, visitor, depth, parent) {
    depth  = depth  || 0;
    parent = parent || null;

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      visitor(node, depth, parent);
      if (node.children) {
        walkStructure(node.children, visitor, depth + 1, node);
      }
    }
  }

  /**
   * Injeta conteúdo HTML num nó chapter pelo índice de ordem.
   *
   * Usa índice Map pré-construído (O(1)) em vez de busca recursiva O(n²).
   * O índice é construído uma única vez por chamada a injectContent.
   *
   * @param {object} bookIR       - A BookIR
   * @param {number} chapterOrder - O índice do capítulo
   * @param {string} content      - O conteúdo HTML
   * @returns {boolean} true se encontrou e injetou
   */
  function injectContent(bookIR, chapterOrder, content) {
    // Constrói índice O(1) se ainda não existe ou se a estrutura mudou
    // (O índice é invalidado a cada nova chamada para segurança)
    var index = buildChapterIndex(bookIR.structure);
    var node  = index.get(chapterOrder);
    if (node) {
      node.content = content;
      return true;
    }
    return false;
  }

  /**
   * Constrói um Map<order, node> para lookup O(1).
   * Percorre a árvore uma única vez, em vez de buscar recursivamente a cada injeção.
   * @param {Array} nodes
   * @returns {Map<number, object>}
   */
  function buildChapterIndex(nodes) {
    var index = new Map();
    walkStructure(nodes, function (node) {
      if (node.type === 'chapter') {
        index.set(node.order, node);
      }
    });
    return index;
  }

  /**
   * Conta o total de capítulos na árvore.
   *
   * @param {object} bookIR - A BookIR
   * @returns {number}
   */
  function countChapters(bookIR) {
    var count = 0;
    walkStructure(bookIR.structure, function (node) {
      if (node.type === 'chapter') count++;
    });
    return count;
  }

  /**
   * Retorna todos os capítulos da IR como array (sem path info).
   *
   * @param {object} bookIR
   * @returns {Array<{order, title, sourceUrl, content}>}
   */
  function getChaptersFlat(bookIR) {
    var chapters = [];
    walkStructure(bookIR.structure, function (node) {
      if (node.type === 'chapter') chapters.push(node);
    });
    return chapters;
  }

  /**
   * Verifica se a IR tem hierarquia (pelo menos um volume ou arco).
   *
   * @param {object} bookIR
   * @returns {boolean}
   */
  function hasHierarchy(bookIR) {
    for (var i = 0; i < bookIR.structure.length; i++) {
      if (bookIR.structure[i].type === 'volume' || bookIR.structure[i].type === 'arc') {
        return true;
      }
    }
    return false;
  }

  /**
   * Retorna uma cópia profunda da BookIR para exportação.
   *
   * Exportadores que mutam a IR (ex: injetam conteúdo traduzido) devem
   * operar sobre uma cópia para não contaminar o estado original.
   * Sem isso, uma segunda exportação num formato diferente veria o conteúdo
   * já traduzido/modificado pelo primeiro exportador.
   *
   * @param {object} bookIR
   * @returns {object} deep copy da BookIR
   */
  function cloneIR(bookIR) {
    // JSON.parse(JSON.stringify()) é suficiente aqui: a IR não contém
    // funções, Blobs, Dates, ou referências circulares.
    // Para IR muito grandes (>50 MB de conteúdo), considerar structuredClone().
    try {
      return JSON.parse(JSON.stringify(bookIR));
    } catch (e) {
      console.error('[BookIR] cloneIR falhou:', e);
      return bookIR; // fallback: retorna original (sem crash)
    }
  }

// ── EXPORTS ──

  return {
    createBookIR:              createBookIR,
    createBookIRWithHierarchy: createBookIRWithHierarchy,
    flattenIR:                 flattenIR,
    walkStructure:             walkStructure,
    injectContent:             injectContent,
    countChapters:             countChapters,
    getChaptersFlat:           getChaptersFlat,
    hasHierarchy:              hasHierarchy,
    normalizeMetadata:         normalizeMetadata,
    cloneIR:                   cloneIR
  };
})();
