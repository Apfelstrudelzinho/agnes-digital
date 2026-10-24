/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file message-types.js
 * @description Constantes imutáveis para tipagem de mensagens IPC
 *              (Inter-Process Communication) compartilhadas entre Service Worker,
 *              Dashboard e Content Scripts.
 *
 * @pipeline IPC Messaging Protocol (Global)
 */

'use strict';

window.MESSAGE_TYPES = Object.freeze({
  // Dashboard → Service Worker
  FETCH_VIA_HIDDEN_TAB: 'FETCH_VIA_HIDDEN_TAB',

  // Dashboard → Content Script (scanner.js)
  SCAN_INDEX_PAGE: 'SCAN_INDEX_PAGE',
  FETCH_VIA_IFRAME: 'FETCH_VIA_IFRAME',
  FETCH_CHERRYMIST_CHAPTER: 'FETCH_CHERRYMIST_CHAPTER',
  PING: 'PING',

  // Keep-Alive (Dashboard → Service Worker porta)
  KEEP_ALIVE_PING: 'PING',
  KEEP_ALIVE_PONG: 'PONG',
});
