/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file db.js
 * @description Módulo de persistência IndexedDB (Singleton).
 *              Gerencia projetos salvos na biblioteca, histórico de capítulos
 *              e estado incremental de download para retomada (resume).
 *
 * @pipeline Dashboard / LibraryManager ⇄ IndexedDB (AgnesDB)
 * @requires window.indexedDB
 */

'use strict';

(function () {
  const DB_NAME        = 'agnes-digital-db';
  const DB_VERSION     = 1;
  const STORE_PROJECTS = 'projects';
  const STORE_CHAPTERS = 'chapters';
  const STORE_PROGRESS = 'progress';

  // ── Singleton de Conexão ──
  let _dbInstance = null;
  let _dbOpenPromise = null;

  function openDB() {
    if (_dbInstance) return Promise.resolve(_dbInstance);
    if (_dbOpenPromise) return _dbOpenPromise;

    _dbOpenPromise = new Promise(function (resolve, reject) {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function (event) {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
          db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
          const chapterStore = db.createObjectStore(STORE_CHAPTERS, { keyPath: 'id' });
          chapterStore.createIndex('projectId', 'projectId', { unique: false });
          chapterStore.createIndex('index',     'index',     { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
          db.createObjectStore(STORE_PROGRESS, { keyPath: 'id' });
        }
      };

      request.onsuccess = function () {
        _dbInstance = request.result;
        _dbInstance.onclose = function () {
          _dbInstance = null;
          _dbOpenPromise = null;
        };
        resolve(_dbInstance);
      };

      request.onerror = function () {
        _dbOpenPromise = null;
        reject(request.error);
      };
    });

    return _dbOpenPromise;
  }

  // ── Projetos ──

  async function saveProjectToDB(project) {
    const db = await openDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE_PROJECTS, 'readwrite');
      tx.objectStore(STORE_PROJECTS).put(project);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }

  async function getProjectsFromDB() {
    const db = await openDB();
    return new Promise(function (resolve, reject) {
      const tx  = db.transaction(STORE_PROJECTS, 'readonly');
      const req = tx.objectStore(STORE_PROJECTS).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  async function getProjectFromDB(id) {
    const db = await openDB();
    return new Promise(function (resolve, reject) {
      const tx  = db.transaction(STORE_PROJECTS, 'readonly');
      const req = tx.objectStore(STORE_PROJECTS).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  }

  // ── Bulk Insert de Capítulos ──
  async function bulkSaveChaptersToDB(chapters) {
    if (!chapters || chapters.length === 0) return;
    const db = await openDB();
    return new Promise(function (resolve, reject) {
      const tx    = db.transaction(STORE_CHAPTERS, 'readwrite');
      const store = tx.objectStore(STORE_CHAPTERS);
      chapters.forEach(function (ch) { store.put(ch); });
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }

  async function saveChapterToDB(chapter) {
    return bulkSaveChaptersToDB([chapter]);
  }

  // ── Estado (Resume/Save Progress) ──

  async function saveProgress(id, data) {
    const db = await openDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE_PROGRESS, 'readwrite');
      tx.objectStore(STORE_PROGRESS).put({ id, ...data });
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }

  async function getProgress(id) {
    const db = await openDB();
    return new Promise(function (resolve, reject) {
      const tx  = db.transaction(STORE_PROGRESS, 'readonly');
      const req = tx.objectStore(STORE_PROGRESS).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  }

  async function clearProgress(id) {
    const db = await openDB();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(STORE_PROGRESS, 'readwrite');
      tx.objectStore(STORE_PROGRESS).delete(id);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }

  window.AgnesDB = {
    openDB,
    saveProjectToDB,
    getProjectsFromDB,
    getProjectFromDB,
    saveChapterToDB,
    bulkSaveChaptersToDB,
    saveProgress,
    getProgress,
    clearProgress,
  };
})();
