/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file background.js
 * @description Background Event Listener para manipulação do clique de ação
 *              da extensão e disparo do scanner na aba ativa.
 *
 * @pipeline Browser Action → Background Listener → Scanner Script
 * @requires chrome.action / browser.browserAction, chrome.scripting
 */

const extApi = typeof browser !== 'undefined' ? browser : chrome;
const actionApi = extApi.action || extApi.browserAction;

actionApi.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  if (!tab.url || !tab.url.startsWith('http')) {
    extApi.tabs.create({ url: extApi.runtime.getURL('ui/dashboard.html') });
    return;
  }

  try {
    await extApi.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/scanner.js']
    });

    const response = await extApi.tabs.sendMessage(tab.id, { type: 'SCAN_INDEX_PAGE' });

    if (response && response.success && response.data) {
      const data = response.data;
      await extApi.storage.local.set({
        pendingProject: {
          sourceUrl: tab.url,
          title: data.title || tab.title || 'Novel',
          author: data.author || 'Autor Desconhecido',
          coverUrl: data.coverUrl || '',
          synopsis: data.synopsis || '',
          genres: data.genres || [],
          status: data.status || 'unknown',
          detectedSite: data.detectedSite || new URL(tab.url).hostname,
          chapters: data.chapters || [],
          structuredChapters: data.structuredChapters || null,
          strategyUsed: data.strategyUsed || 'unknown',
          timestamp: Date.now()
        }
      });
    } else {
      await extApi.storage.local.set({
        pendingProject: {
          sourceUrl: tab.url,
          title: tab.title || 'Novel',
          author: 'Autor Desconhecido',
          coverUrl: '',
          detectedSite: new URL(tab.url).hostname,
          chapters: [],
          strategyUsed: 'none',
          timestamp: Date.now()
        }
      });
    }
  } catch (err) {
    console.warn('[NovelsDownloader Firefox] Erro ao escanear página ativa:', err);
    await extApi.storage.local.set({
      pendingProject: {
        sourceUrl: tab.url || '',
        title: tab.title || 'Novel',
        author: 'Autor Desconhecido',
        coverUrl: '',
        detectedSite: '',
        chapters: [],
        strategyUsed: 'error',
        timestamp: Date.now()
      }
    });
  }

  extApi.tabs.create({ url: extApi.runtime.getURL('ui/dashboard.html') });
});

