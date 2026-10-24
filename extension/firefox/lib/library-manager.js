/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file library-manager.js
 * @description Gerenciador da aba "Minha Biblioteca" do Agnes Digital.
 *              Controla renderização reativa dos cards salvos no IndexedDB (AgnesDB),
 *              sincronização incremental e detecção de capítulos novos (diff).
 *
 * @pipeline Dashboard (UI Tab) → LibraryManager → AgnesDB / Scanner
 * @requires window.AgnesDB, window.AgnesLog, window.MESSAGE_TYPES
 */

'use strict';

(function () {
  const api = typeof browser !== 'undefined' ? browser : chrome;

  function escapeXml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  function sanitizeFilename(name) {
    return (name || 'novel')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[\.\s]+$/g, '')
      .replace(/\s+/g, '_')
      .trim() || 'novel';
  }

  /**
   * Renderiza a grade de projetos salvos no IndexedDB na aba de biblioteca.
   */
  async function renderLibrary() {
    var grid = document.getElementById('library-grid');
    if (!grid) return;
    grid.innerHTML = '<p>Carregando...</p>';

    try {
      var projects = await AgnesDB.getProjectsFromDB();
      if (!projects || projects.length === 0) {
        grid.innerHTML = '<p>Nenhuma novel salva na biblioteca ainda.</p>';
        return;
      }

      projects.sort(function (a, b) { return (b.lastUpdated || 0) - (a.lastUpdated || 0); });

      // DocumentFragment: monta os cards fora do DOM para zero reflow
      var fragment = document.createDocumentFragment();
      projects.forEach(function (proj) {
        var card = document.createElement('div');
        card.className = 'lib-card';
        var coverSrc = proj.meta && proj.meta.coverUrl ? proj.meta.coverUrl : '../icons/icon128.png';
        var totalCaps = proj.chapters ? proj.chapters.length : 0;

        var syncText = (api.i18n && api.i18n.getMessage('btnSyncNew')) || 'Sincronizar Novos';
        var chText   = (api.i18n && api.i18n.getMessage('txtChapters')) || 'Capítulos';

        // Montagem segura dos nós DOM sem innerHTML dinâmico (compliance AMO/Mozilla)
        var img = document.createElement('img');
        img.src = coverSrc;

        var infoDiv = document.createElement('div');
        infoDiv.className = 'lib-card-info';

        var titleEl = document.createElement('h3');
        titleEl.textContent = proj.title || 'Sem título';

        var pEl = document.createElement('p');
        pEl.textContent = totalCaps + ' ' + chText;

        infoDiv.appendChild(titleEl);
        infoDiv.appendChild(pEl);

        var actionsDiv = document.createElement('div');
        actionsDiv.className = 'lib-card-actions';

        var btn = document.createElement('button');
        btn.className = 'btn-lib-update';
        btn.setAttribute('data-id', proj.id);
        btn.textContent = syncText;

        actionsDiv.appendChild(btn);

        card.appendChild(img);
        card.appendChild(infoDiv);
        card.appendChild(actionsDiv);
        fragment.appendChild(card);
      });

      grid.replaceChildren(fragment);

      document.querySelectorAll('.btn-lib-update').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          triggerIncrementalUpdate(e.target.getAttribute('data-id'));
        });
      });
    } catch (e) {
      grid.replaceChildren();
      var errP = document.createElement('p');
      errP.textContent = 'Erro ao carregar banco de dados.';
      grid.appendChild(errP);
      if (typeof AgnesLog !== 'undefined') {
        AgnesLog.error('Library', 'Falha ao renderizar biblioteca:', e);
      }
    }
  }

  /**
   * Dispara atualização incremental buscando novos capítulos na fonte original.
   * @param {string} projectId
   */
  async function triggerIncrementalUpdate(projectId) {
    var proj = await AgnesDB.getProjectFromDB(projectId);
    if (!proj || !proj.meta || !proj.meta.sourceUrl) {
      alert('Erro: Novel sem URL raiz salva não pode ser atualizada.');
      return;
    }

    const tabExt = document.getElementById('btn-tab-extrator');
    if (tabExt) tabExt.click();

    const inpUrl = document.getElementById('inp-url');
    if (inpUrl) inpUrl.value = proj.meta.sourceUrl;

    if (typeof log === 'function') {
      log('Buscando atualizações na página original...', 'info');
    }

    api.tabs.create({ url: proj.meta.sourceUrl, active: false }, function (tab) {
      var checkTimeout = setTimeout(function () {
        try { api.tabs.remove(tab.id); } catch (_) {}
        if (typeof log === 'function') log('Timeout verificando novos capítulos.', 'error');
      }, 15000);

      function listener(tId, info) {
        if (tId !== tab.id || info.status !== 'complete') return;
        clearTimeout(checkTimeout);
        api.tabs.onUpdated.removeListener(listener);

        setTimeout(function () {
          api.tabs.sendMessage(tId, { type: (window.MESSAGE_TYPES && window.MESSAGE_TYPES.SCAN_INDEX_PAGE) || 'SCAN_INDEX_PAGE' }, function (response) {
            try { api.tabs.remove(tab.id); } catch (_) {}

            if (response && response.success) {
              var newIndex = response.data;
              var novos = diffChapters(proj.chapters || [], newIndex.chapters || []);

              if (novos.length === 0) {
                if (typeof log === 'function') log('Nenhum capítulo novo encontrado em "' + proj.title + '".', 'success');
              } else {
                if (typeof log === 'function') log('Encontrados ' + novos.length + ' novos capítulos! Pronto para baixar.', 'success');
                var inpTitle = document.getElementById('inp-title');
                if (inpTitle) inpTitle.value = proj.title;

                var inpFilename = document.getElementById('inp-filename');
                if (inpFilename) inpFilename.value = sanitizeFilename(proj.title) + '_Novos_Caps';

                window.currentProject = newIndex;
                window.currentChapters = (newIndex.chapters || []).map(function (c, i) {
                  var isNew = novos.some(function (n) { return n.url === c.url; });
                  return { title: c.title, url: c.url, index: i, selected: isNew };
                });

                if (typeof renderChapters === 'function') {
                  renderChapters(window.currentChapters);
                }

                var btnNative = document.getElementById('btn-compile-native');
                if (btnNative) btnNative.disabled = false;
                var btnTl = document.getElementById('btn-compile-tl');
                if (btnTl) btnTl.disabled = false;
                var btnTlSet = document.getElementById('btn-tl-settings');
                if (btnTlSet) btnTlSet.disabled = false;
                var btnComic = document.getElementById('btn-compile-comic');
                if (btnComic) btnComic.disabled = false;

                alert(novos.length + ' capítulos inéditos adicionados e já selecionados.');
              }
            } else {
              if (typeof log === 'function') log('Erro na raspagem de atualizações.', 'error');
            }
          });
        }, 1000);
      }
      api.tabs.onUpdated.addListener(listener);
    });
  }

  /**
   * Retorna os capítulos de newList que não existem em oldList com base na URL.
   * @param {Array<{url: string}>} oldList
   * @param {Array<{url: string}>} newList
   * @returns {Array<object>}
   */
  function diffChapters(oldList, newList) {
    var oldUrls = new Set((oldList || []).map(function (c) { return c.url; }));
    return (newList || []).filter(function (c) { return !oldUrls.has(c.url); });
  }

  // Exportação no escopo global
  window.LibraryManager = {
    render: renderLibrary,
    renderLibrary: renderLibrary,
    triggerIncrementalUpdate: triggerIncrementalUpdate,
    diffChapters: diffChapters
  };

  // Compatibilidade com código legado
  window.renderLibrary = renderLibrary;
  window.triggerIncrementalUpdate = triggerIncrementalUpdate;
  window.diffChapters = diffChapters;
})();

