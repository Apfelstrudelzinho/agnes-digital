/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file agnes-log.js
 * @description Sistema centralizado de logging estruturado com níveis de severidade
 *              (debug, info, warn, error) e filtragem de depuração no DevTools.
 *
 * @pipeline Runtime Logging (Global)
 * @requires window.localStorage
 */

'use strict';

(function () {
  const DEBUG_MODE = localStorage.getItem('AGNES_DEBUG') === '1';

  const LEVEL_CONFIG = {
    debug: { method: 'log',   prefix: '🔍 [DEBUG]', devOnly: true  },
    info:  { method: 'log',   prefix: '💬 [INFO] ', devOnly: false },
    warn:  { method: 'warn',  prefix: '⚠️  [WARN] ', devOnly: false },
    error: { method: 'error', prefix: '❌ [ERROR]', devOnly: false },
  };

  /**
   * Logger estruturado do Agnes Digital.
   * @param {'debug'|'info'|'warn'|'error'} level - Nível de severidade.
   * @param {string} module - Nome do módulo (ex: 'Dashboard', 'HiddenTab', 'DB').
   * @param {string} message - Mensagem legível.
   * @param {*} [data] - Dado extra opcional para inspecionar no DevTools.
   */
  function AgnesLog(level, module, message, data) {
    const config = LEVEL_CONFIG[level] || LEVEL_CONFIG.info;

    // Silencia logs de debug em produção
    if (config.devOnly && !DEBUG_MODE) return;

    const tag = `[AgnesDigital][${module}]`;
    const fullMsg = `${config.prefix} ${tag} ${message}`;

    if (data !== undefined) {
      console[config.method](fullMsg, data);
    } else {
      console[config.method](fullMsg);
    }
  }

  // Atalhos convenientes
  AgnesLog.debug = (module, msg, data) => AgnesLog('debug', module, msg, data);
  AgnesLog.info  = (module, msg, data) => AgnesLog('info',  module, msg, data);
  AgnesLog.warn  = (module, msg, data) => AgnesLog('warn',  module, msg, data);
  AgnesLog.error = (module, msg, data) => AgnesLog('error', module, msg, data);

  window.AgnesLog = AgnesLog;
})();
