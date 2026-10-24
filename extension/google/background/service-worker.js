/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file service-worker.js
 * @description Background Service Worker (Manifest V3).
 *              Gerencia ciclo de vida da extensão, orquestração de abas ocultas,
 *              comunicação IPC, bypasses de Cloudflare e ponte de rede para APIs.
 *
 * @pipeline Extension Runtime → Service Worker ⇄ Dashboard / Content Script
 * @requires chrome.runtime, chrome.tabs, chrome.storage
 */

// ── FILA DE CONCORRÊNCIA ──
const MAX_CONCURRENT_HIDDEN_TABS = 3;
let activeHiddenTabs = 0;
const hiddenTabQueue = [];

function enqueueHiddenTabTask(taskFn) {
  return new Promise((resolve, reject) => {
    hiddenTabQueue.push({ taskFn, resolve, reject });
    drainHiddenTabQueue();
  });
}

async function drainHiddenTabQueue() {
  if (activeHiddenTabs >= MAX_CONCURRENT_HIDDEN_TABS || hiddenTabQueue.length === 0) return;

  const { taskFn, resolve, reject } = hiddenTabQueue.shift();
  activeHiddenTabs++;

  try {
    const result = await taskFn();
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    activeHiddenTabs--;
    drainHiddenTabQueue();
  }
}

// ── KEEP-ALIVE (MV3) ──
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepAlive') return;
  port.onMessage.addListener((msg) => {
    if (msg.type === 'PING') {
      port.postMessage({ type: 'PONG' });
    }
  });
});

// ── REGRAS DE CABEÇALHO DECLARATIVAS (DNR) ──
if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateDynamicRules) {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1001],
    addRules: [{
      id: 1001,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'origin', operation: 'set', value: 'https://cherrymist.cafe' },
          { header: 'referer', operation: 'set', value: 'https://cherrymist.cafe/' }
        ]
      },
      condition: {
        urlFilter: '||cherrymist.cafe/api/*',
        resourceTypes: ['xmlhttprequest', 'sub_frame', 'main_frame']
      }
    }]
  }).catch(() => {});
}
// Clique no ícone da extensão
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  // Páginas especiais 
  if (!tab.url || !tab.url.startsWith('http')) {
    openOrFocusDashboard();
    return;
  }

  // Badge visual
  chrome.action.setBadgeText({ text: '…', tabId: tab.id });
  chrome.action.setBadgeBackgroundColor({ color: '#f0a500', tabId: tab.id });

  // Chave de estado isolada por aba
  const storageKey = `pendingProject_${tab.id}`;

  try {
    // Verifica se o scanner já foi injetado na aba
    let alreadyInjected = false;
    try {
      const pingResponse = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
      if (pingResponse && pingResponse.pong) alreadyInjected = true;
    } catch (_) {
    }

    if (!alreadyInjected) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/scanner.js']
      });
    }

    const response = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_INDEX_PAGE' });

    if (response && response.success && response.data) {
      const data = response.data;
      await chrome.storage.local.set({
        [storageKey]: {
          sourceUrl: tab.url,
          title: data.title || tab.title || 'Novel',
          author: data.author || 'Unknown Author',
          coverUrl: data.coverUrl || '',
          synopsis: data.synopsis || '',
          genres: data.genres || [],
          status: data.status || 'unknown',
          detectedSite: data.detectedSite || new URL(tab.url).hostname,
          chapters: data.chapters || [],
          structuredChapters: data.structuredChapters || null,
          strategyUsed: data.strategyUsed || 'unknown',
          tabId: tab.id,
          timestamp: Date.now()
        }
      });
    } else {
      // Scan sem dados
      await chrome.storage.local.set({
        [storageKey]: {
          sourceUrl: tab.url,
          title: tab.title || 'Novel',
          author: 'Unknown Author',
          coverUrl: '',
          detectedSite: new URL(tab.url).hostname,
          chapters: [],
          structuredChapters: null,
          strategyUsed: 'none',
          tabId: tab.id,
          timestamp: Date.now()
        }
      });
    }
  } catch (err) {
    console.warn('[AgnesDigital] Error scanning active page:', err);
    // Ciclo de vida limpo
    await chrome.storage.local.set({
      [storageKey]: {
        sourceUrl: tab.url || '',
        title: tab.title || 'Novel',
        author: 'Unknown Author',
        coverUrl: '',
        detectedSite: '',
        chapters: [],
        structuredChapters: null,
        strategyUsed: 'error',
        error: err instanceof Error ? err.message : String(err),
        tabId: tab.id,
        timestamp: Date.now()
      }
    });
  } finally {
    chrome.action.setBadgeText({ text: '', tabId: tab.id });
    openOrFocusDashboard(tab.id, storageKey);
  }
});

// ── DASHBOARD SINGLETON ──
async function openOrFocusDashboard(sourceTabId, storageKey) {
  const dashboardUrl = chrome.runtime.getURL('ui/dashboard.html');
  const existingTabs = await chrome.tabs.query({ url: dashboardUrl + '*' });

  if (existingTabs.length > 0) {
    const existingTab = existingTabs[0];
    await chrome.tabs.update(existingTab.id, { active: true });
    if (existingTab.windowId) {
      await chrome.windows.update(existingTab.windowId, { focused: true });
    }
    try {
      await chrome.tabs.sendMessage(existingTab.id, {
        type: 'LOAD_PENDING_PROJECT',
        storageKey: storageKey,
        sourceTabId: sourceTabId
      });
    } catch (_e) {
    }
  } else {
    const targetUrl = storageKey ? `${dashboardUrl}?key=${encodeURIComponent(storageKey)}` : dashboardUrl;
    await chrome.tabs.create({ url: targetUrl });
  }
}

// ── FALLBACK ──
async function fetchViaHiddenTab(url, expectedSelector) {
  return enqueueHiddenTabTask(() => _fetchViaHiddenTabInternal(url, expectedSelector));
}

async function _fetchViaHiddenTabInternal(url, expectedSelector) {
  let tabId = null;
  let onUpdatedListener = null;

  // Função de cleanup centralizada
  const cleanup = async () => {
    if (onUpdatedListener) {
      chrome.tabs.onUpdated.removeListener(onUpdatedListener);
      onUpdatedListener = null;
    }
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {
        console.warn(`[HiddenTab] Falha ao fechar aba ${tabId}:`, e);
      }
      tabId = null;
    }
  };

  try {
    // Abre a URL em uma aba visualmente deslocada para fora da tela.
    const tab = await chrome.tabs.create({
      url,
      active: false,
    });
    tabId = tab.id;

    const result = await new Promise((resolve, reject) => {
      const TIMEOUT_MS = 45000; // 45 segundos para o usuário resolver o CAPTCHA
      let challengeDetected = false;
      let completeCount = 0;

      const timeoutId = setTimeout(() => {
        reject(new Error(`[HiddenTab] Timeout (${TIMEOUT_MS}ms): ${url}`));
      }, TIMEOUT_MS);

      onUpdatedListener = async (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        completeCount++;

        try {
          const tabInfo = await chrome.tabs.get(tabId).catch(() => null);
          if (!tabInfo) return;

          const title = tabInfo.title || '';
          const isChallengeTitle = title.includes('Just a moment') || title.includes('Attention Required');

          if (isChallengeTitle) {
            challengeDetected = true;
            console.log('[HiddenTab] Cloudflare challenge detectado. Aguardando resolução...');
            return;
          }

          clearTimeout(timeoutId);

          const extractResults = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (selector) => {
              // ── Handler Cherrymist Cafe direto no contexto da página da aba oculta ──
              if (window.location.hostname.includes('cherrymist.cafe')) {
                try {
                  const pathname = window.location.pathname;
                  const searchParams = new URLSearchParams(window.location.search);
                  let chId = searchParams.get('id');
                  let chTitle = document.title;
                  const slugMatch = pathname.match(/\/(?:chapter|chapters)\/([^/?#]+)/i);
                  if (!chId && slugMatch) {
                    const sRes = await fetch('/api/chapters/by-slug/' + slugMatch[1], { credentials: 'include' });
                    if (sRes.ok) {
                      const sData = await sRes.json();
                      if (sData && sData.id) {
                        chId = sData.id;
                        if (sData.title) chTitle = sData.title;
                      }
                    }
                  }
                  if (!chId) {
                    const idMatch = pathname.match(/\/(\d+)/);
                    if (idMatch) chId = idMatch[1];
                  }
                  if (chId) {
                    const cRes = await fetch('/api/chapters/' + chId, { credentials: 'include' });
                    if (cRes.ok) {
                      const cData = await cRes.json();

                      // Se o corpo foi retido com revealTicket
                      if (cData.bodyWithheld && cData.revealTicket) {
                        try {
                          const ticket = cData.revealTicket;
                          const rawPayload = ticket.split('.')[1];
                          const padded = rawPayload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - rawPayload.length % 4) % 4);
                          const payload = JSON.parse(atob(padded));
                          const jti = payload.jti;

                          if (jti) {
                            const KEY = '457698978af0c511a6ebfd44efc0679651c0b0485fec76fe9a5acab91a26eb02';
                            const msg = `chapter-reveal.v1.${chId}.${jti}`;
                            const enc = new TextEncoder();
                            const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
                            const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msg));
                            const proof = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

                            const revRes = await fetch(`/api/chapters/${chId}/reveal`, {
                              method: 'POST',
                              credentials: 'include',
                              headers: {
                                'Content-Type': 'application/json',
                                'X-CM-Reader': '1'
                              },
                              body: JSON.stringify({
                                ticket: ticket,
                                frames: 40,
                                elapsedMs: 650,
                                visible: true,
                                focused: true,
                                proof: proof
                              })
                            });

                            if (revRes.ok) {
                              const revData = await revRes.json();
                              if (revData && revData.content) {
                                cData.content = revData.content;
                                if (revData.foreword) cData.foreword = revData.foreword;
                                if (revData.afterword) cData.afterword = revData.afterword;
                                cData.bodyWithheld = false;
                              }
                            }
                          }
                        } catch (revErr) {
                          console.warn('[AgnesDigital] Erro no reveal da aba oculta:', revErr);
                        }
                      }

                      // Fallback: se o capítulo já estiver aberto e renderizado na aba ativa pelo leitor
                      if (!cData.content) {
                        const readerEl = document.querySelector('[style*="--cm-cipher"]') || document.querySelector('.space-y-6');
                        if (readerEl && readerEl.innerText && readerEl.innerText.trim().length > 100) {
                          cData.content = readerEl.innerHTML;
                        }
                      }

                      const SEEDS = {
                        1: "etcasvneCaocwebotclilJheitVsrodtKFMgyfselnmeowkaohtzWeOhruestsmlaiBrtoiZulrhnqnforfoomLiayheesnusinQiipfijhdTaEtgtetntRmoPoGnwieundIiirhydpetdmatstUdroetdtaadYlleerewhrhAedNHacetehnynotsrahhhavDiernihaSubeXercfamrgaxsasoosneksygdeuaipcpbritnastgowlalentons",
                        2: "CtJccIudjfkasgpqaungdttaxgodfiltsndrtQpglseBcotdeEsnncthhenetittFVweYeloinnpDateGlnsnaoanedldhcAnfaweenahyhekiuarpdeoZthtallrKbtfssetevenaubaiehewdwXliossmriumsnywtofiaosLyynrhoNsiiOtnishrrmzHrtmiMoeebuhotleerTayahrsmdhoeaUrWhaPvocgseoitroooeiSitRhiaarreem",
                        3: "AtlKohadlflaeavaeavRyunonnhnussnJroQiinTtetLgarisdsoaoDabrOcoVwqecdiftnoepSseeNtmailaooeisPusmcWsoinFtgMryeXrtaidywemetbdnahhhgUpErhinneeophztitorYsofeoylekwoHkeaaedhomhruwbcfeuntGpreeitliwlrIcetatyeemgnfatinirsdmxdhaajtssnthZdedertsgeitsrBCuhnlthtchoarlsi",
                        4: "ntPtatngHshhatbrmtkpiaroQvylaoeissnfblhmsefraFVstdIiaterwotmetedarnooOheneysahGwplkjmwnetcJsenlsartcnhtUolaigiYsolnoaebatthpdheotnsomAitadaSfiryodidrgneuesLafdXeEnheirxMZropoednenlcdWerfwiemhorhBcretiiauaeoqcngwzRtsCieteTlNuoauuthicsDsuryKsyoeeidvehnhliagt",
                        5: "acarMsatsnraeuprHtyttohluesrsavayhrensidttewehhfoGlFBNnWmuCosLkItiitkeernoeYeoniidrystsmrpgctmbtsannuSaedopeeejVTuchcniealhesimOZeanrigllrctdgnrhbhalimdaPahqthigncrynReodlohossedoettoiyQUnfetxnaiwttJiDlnootfebrevmwlofaarpsdXiteKdiAsgewefEhhedontaoawzaihosu",
                        6: "gneriilienCacloynmnhshafhsnhiatclcabsBmhooLDstghoeneyarpafnlOrnsJtathtemoioericeeSmrthepHdshcomlbieoqhnuywoefigIhicteiavdotmUisirdenpeaaQGefdettaFootnsnoretnvAkKeYrjufilneipsdtryauTdtaubolguozEeRxtekldortaunhehestswaswrZaoadnhtaVgtresielNwerMrXsWydwdstitaP",
                        7: "ofrirridaotDsgsenpldrfdlrthitrelcnsiohugshtkneHsdonwoenSoogBuaiahesenKspyaeorgaRutdhohbeeanFotdiwsOhigicsnpsnhnVheyttlketersrdpesndZoaWtsrhcniaoeweerjtfXvdyUeccfaCzLmnnmuttMaomrittemotuixawheGabvQAattoinysymetaoroYfieIhhrmatiNTulbelqaasthielaweJaldcPinEeel",
                        8: "wletotniraytoaqrnvliolgrkaueLyVthashtthgCtlflnrtdZregtthclscthterusrtdfefibresiacenJhuSepednomotwttyatiHeespanQxuOrmhainehhheGuworkebdovshaodaecmoewfiraeDhndieseThtXUgdrainoIecjoiWpoaefiAnydeybsPessnismeapcnumaeKrEtaYstoiatrinlnooBddoRswsnmasozFigeaNihllnM",
                        9: "ekalraolooyuemnCvtljsnsrybVslnLcYrfMXlatremiaaDdJnpeEhiewdaeGOcgtwmantoaledstslaQhIbngidetrhtusethnrelidoqiaydisatoipnfaehteweohssurthxdesdkiemoeheweaauigFstmiheelcRormffursnaTieoaectoetsnStobortBhhcrfWscieoawhytodZnsttvnoonheainagzHrreinhpitnKNpPtigAryduU",
                        10: "tsEunattoopphingisfavlKsijxcdthitloaedfoZhntBonthemcsuoayilwhRhfwhtnnsdDVtarthrugneOslenymtbteanlrssefaoimeQFnirpbfeshHbrpcarrdirirPiAoaScrsmsandthiaiowGaMvalLoauehaehcetIeydgoaeiagaTrogezenqrcemXdedtiYldoeiehishsweWeeokotntynewttJdraNenoutneeCtousmslkrlyU",
                        11: "intheZredADelneGreocfaeptateeeohIeftmrngrewyuekhXdctCgpgnheingsonaicnslhhdweoosztelioablataaSsotHUPsatOsiytlYnMnreiRwcrsmntstrierJeuhdsaxahhfetbLerlrmnauiyqdlyiwobasttowNEiedshhofodserlkrejruyhfKiieaiiimttWdalsovsdpnFvtBmramnaonsdQottogoccnhtpaVinuaaueoheT",
                        12: "hotedemlooWeahJiayvhyolpfVhihfhNnahrymgletnesonhqlrioanmgGdnmAieetteeasuaYalersevededutdwzrHmtpIeutacothrlbtRawnacednelosUgthriesoeiguPcanparnydhwKdjsunCifsoaBXfabaoiowlhcQeLtstnineehsttdcstterahasrrerMknattnioowislOoZbeFEysniosrfdirgtneTitcmSisioterDkaxpu",
                        13: "odMsGtmtKdwdNTagnawctdraohhlabtmnrjoJsnlaezDeidneeiuotkawnotHedhlehoyebsefisncraXpanrnoetiteerlrenlegmerdesxiepebdorwhnBotusZchnsgrfoenduidstichaaqteAmaoWPhleVtnoiaattoQoeuemtrahutsrthifvsssavkengrsnnpleiargspoftFihaOhhlEtSsheltuyCiaitcYaUoIyiowRiymLrefyic",
                        14: "etpictwedrniuoJhureoiRPtIsosrTinsuoEbchorleZeexAndadoauisctsnoHnMolmKenwvrehUtetiBgelgphdahataotfnasYiayvamLoiahsWfjeeltggituOltpuenhrreobeicnaafetwktnohefnshhtyipedgnQesneitkmcsdGyqhsesaoroaaoNsacaSeyzsdmaitFhdttfnmnmdhsryrhCliarirrwteeditelDwlonoeaVbXlrt",
                        15: "ooayeicoeaeocThwcoselxmhtitshdeeFsknudiieaLOlEteopiaaYtnhidjneyiebRsftocucmnseoanantaaQwdfhGsnPbogpVeiiesWndrelihrptZduKtSuwagCegarDsemliorihyatraieeodtclIqtogytMsvsrnedshbrtlryJhaieeHfeoAuogtsNedtsiUnwhpltudinawmfoohfleXhrtlvamskaanntrrnnhtrsmnotBrthazeer"
                      };
                      const seed = (cData.cipher && cData.cipher.seed) || 1;
                      const table = SEEDS[seed] || SEEDS[1];
                      let raw = cData.content || '';
                      let decoded = '';
                      if (/[\uE000-\uE0FF]/.test(raw)) {
                        for (let i = 0; i < raw.length; i++) {
                          const code = raw.charCodeAt(i);
                          decoded += (code >= 0xE000 && code < 0xE100) ? (table[code - 0xE000] || raw[i]) : raw[i];
                        }
                      } else {
                        decoded = raw;
                      }

                      let bodyHtml = '';
                      if (decoded.includes('<p') || decoded.includes('<span') || decoded.includes('<div') || decoded.includes('<br')) {
                        bodyHtml = decoded;
                      } else {
                        bodyHtml = decoded.split(/\r?\n\r?\n/).map(p => '<p>' + p.trim() + '</p>').join('\n');
                      }

                      if (cData.foreword) {
                        let forewordDec = cData.foreword;
                        if (/[\uE000-\uE0FF]/.test(forewordDec)) {
                          let fDec = '';
                          for (let i = 0; i < forewordDec.length; i++) {
                            const code = forewordDec.charCodeAt(i);
                            fDec += (code >= 0xE000 && code < 0xE100) ? (table[code - 0xE000] || forewordDec[i]) : forewordDec[i];
                          }
                          forewordDec = fDec;
                        }
                        if (forewordDec.trim()) {
                          bodyHtml = '<div class="foreword"><blockquote>' + (forewordDec.includes('<') ? forewordDec : forewordDec.trim().replace(/\r?\n/g, '<br/>')) + '</blockquote></div><hr/>\n' + bodyHtml;
                        }
                      }

                      if (cData.afterword) {
                        let afterwordDec = cData.afterword;
                        if (/[\uE000-\uE0FF]/.test(afterwordDec)) {
                          let aDec = '';
                          for (let i = 0; i < afterwordDec.length; i++) {
                            const code = afterwordDec.charCodeAt(i);
                            aDec += (code >= 0xE000 && code < 0xE100) ? (table[code - 0xE000] || afterwordDec[i]) : afterwordDec[i];
                          }
                          afterwordDec = aDec;
                        }
                        if (afterwordDec.trim()) {
                          bodyHtml += '\n<hr/><div class="afterword"><blockquote>' + (afterwordDec.includes('<') ? afterwordDec : afterwordDec.trim().replace(/\r?\n/g, '<br/>')) + '</blockquote></div>';
                        }
                      }

                      return {
                        success: true,
                        html: bodyHtml,
                        text: decoded,
                        title: chTitle || cData.title || ('Chapter ' + chId)
                      };
                    }
                  }
                } catch (err) {
                  console.error('[AgnesDigital] Erro ao extrair capítulo Cherrymist na aba oculta:', err);
                }
                // NUNCA faz fallback para o DOM no Cherrymist
                return {
                  success: false,
                  error: 'Capítulo não pôde ser obtido via API do Cherrymist'
                };
              }

              return new Promise((res) => {
                const EXTRACTION_TIMEOUT_MS = 15000;

                const tryExtract = () => {
                  // 1. Tenta extrair chapInfo embutido do WebNovel
                  try {
                    const scripts = Array.from(document.querySelectorAll('script'));
                    for (const s of scripts) {
                      const txt = s.textContent || '';
                      if (txt.includes('var chapInfo=')) {
                        const start = txt.indexOf('var chapInfo=') + 'var chapInfo='.length;
                        const end = txt.lastIndexOf('};') !== -1 ? txt.lastIndexOf('};') + 1 : txt.length;
                        const jsonStr = txt.slice(start, end).trim().replace(/;$/, '');
                        const parsed = JSON.parse(jsonStr);
                        if (parsed && parsed.chapterInfo && parsed.chapterInfo.contents) {
                          const html = parsed.chapterInfo.contents.map(c => '<p>' + (c.content || '') + '</p>').join('\n');
                          return {
                            success: true,
                            html: html,
                            text: parsed.chapterInfo.contents.map(c => c.content || '').join('\n\n'),
                            title: parsed.chapterInfo.chapterName || document.title
                          };
                        }
                      }
                    }
                  } catch (_e) {}

                  // 2. Tenta seletores DOM prioritários
                  const element = document.querySelector(selector);
                  // Aceita o elemento se tiver texto suficiente OU imagens (manhwas)
                  if (element && (
                    (element.innerText && element.innerText.trim().length > 100) ||
                    element.querySelectorAll('img').length > 0
                  )) {
                    const clone = element.cloneNode(true);

                    // Remove números de comentários de parágrafos, badges, widgets de votação, presentes e propagandas
                    clone.querySelectorAll(
                      'i.para-comment, i.para-comment_num, .j_para_comment, .para-comment, ' +
                      '[class*="para-comment"], [class*="para_comment"], .para-btn, i.iconfont, ' +
                      '.review-count, .cha-score, .user-links-wrap, .g_ad_ph, .j_bottom_comment_area, ' +
                      '.bottom-comment, .comment-wrap, .vote-wrap, .j_vote_btn, .gift-wrap, .send-gift, ' +
                      '.j_send_gift, .admire-wrap, .cha-bts, .cha-ft, .bottom-btn, .bottom-bar, ' +
                      'a[href^="javascript"], a[href="#"], a:not([href]), ' +
                      '.pirate, svg, noscript, style, script, .guide-wrap'
                    ).forEach(el => el.remove());

                    // Desempacota tags customizadas (<annotations>, <pirate>, etc.) sem gerar resíduos de HTML
                    clone.querySelectorAll('annotations, pirate, guide-wrap, c-para').forEach(el => {
                      while (el.firstChild) {
                        el.parentNode.insertBefore(el.firstChild, el);
                      }
                      el.parentNode && el.parentNode.removeChild(el);
                    });

                    // Remove qualquer elemento filho dentro de parágrafos que seja puramente numérico
                    clone.querySelectorAll('p, .para, div').forEach(p => {
                      Array.from(p.children).forEach(child => {
                        if (/^\s*\d+\s*$/.test(child.textContent || '')) {
                          child.remove();
                        }
                      });
                    });

                    // Limpa caracteres invisíveis de ofuscação, resíduos de tags customizadas e links mortos de widgets
                    const cleanHtml = clone.innerHTML
                      .replace(/[\u200B-\u200D\uFEFF]/g, '')
                      .replace(/<\/?(?:annotations|pirate|guide-wrap|para-comment|c-para|span-comment)[^>]*>/gi, '')
                      .replace(/&lt;\/?(?:annotations|pirate|guide-wrap|para-comment|c-para|span-comment)[^&]*&gt;/gi, '')
                      .replace(/<\/(?:li|ol|ul)>(?!\s*<(?:li|ol|ul))/gi, '')
                      .replace(/<a\b[^>]*href=[\"'](?:javascript:[^\"']*|#)?[\"'][^>]*>[\s\S]*?<\/a>/gi, (match) => {
                        if (/(?:coment[aá]rio|comment|voto|vote|presente|gift|enviar|send|review|avalia[çc][aã]o|power stone|pedra de poder|doar|donate|tip)/i.test(match)) return '';
                        return match.replace(/<[^>]+>/g, '').trim();
                      })
                      .replace(/<p\b[^>]*>\s*(?:coment[aá]rio\s*\d*\+?\s*coment[aá]rio|voto|vote|enviar presente|send gift|power stone|pedra de poder)\s*<\/p>/gi, '')
                      .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (match, inner) => {
                        const cleanedInner = inner.replace(/(\s*(?:<[^>]+>)*\s*\d+\s*(?:<\/[^>]+>)*\s*)$/, '').trim();
                        return '<p>' + cleanedInner + '</p>';
                      })
                      .replace(/<p\b[^>]*>\s*(?:&nbsp;|\s)*<\/p>/gi, '')
                      .trim();
                    const cleanText = (clone.innerText || '')
                      .replace(/[\u200B-\u200D\uFEFF]/g, '')
                      .replace(/(\n\s*\d+\s*\n)/g, '\n\n')
                      .trim();

                    // Busca título específico na página do leitor se disponível
                    const titleEl = document.querySelector('.cha-hd-mn h1, h1.chapter-title, .chapter_title, .cha-tit h3, #chapter-title, h1');
                    const cleanTitle = (titleEl && titleEl.innerText.trim()) ? titleEl.innerText.trim() : document.title;

                    return {
                      success: true,
                      html: cleanHtml,
                      text: cleanText,
                      title: cleanTitle
                    };
                  }
                  return null;
                };

                // Tenta imediatamente
                const immediate = tryExtract();
                if (immediate) { res(immediate); return; }

                // Fallback: MutationObserver observa mudanças no DOM.
                const observer = new MutationObserver(() => {
                  const extracted = tryExtract();
                  if (extracted) {
                    observer.disconnect();
                    clearTimeout(obsTimeout);
                    res(extracted);
                  }
                });

                observer.observe(document.body, { childList: true, subtree: true });

                const obsTimeout = setTimeout(() => {
                  observer.disconnect();
                  res({
                    success: false,
                    error: `Timeout: Seletor '${selector}' não carregou conteúdo suficiente.`
                  });
                }, EXTRACTION_TIMEOUT_MS);
              });
            },
            args: [expectedSelector]
          });

          if (extractResults && extractResults[0] && extractResults[0].result) {
            const r = extractResults[0].result;
            if (r.success) {
              resolve({ title: r.title, content: r.html });
            } else {
              reject(new Error(r.error));
            }
          } else {
            reject(new Error('Script de extração não retornou resultado.'));
          }
        } catch (err) {
          clearTimeout(timeoutId);
          reject(err);
        }
      };

      chrome.tabs.onUpdated.addListener(onUpdatedListener);

      // Detecta se o usuário fecha a aba do CAPTCHA manualmente
      chrome.tabs.onRemoved.addListener(function onRemovedListener(removedTabId) {
        if (removedTabId === tabId) {
          chrome.tabs.onRemoved.removeListener(onRemovedListener);
          tabId = null;
          clearTimeout(timeoutId);
          reject(new Error('[HiddenTab] Aba fechada manualmente pelo usuário.'));
        }
      });
    });

    return result;

  } catch (error) {
    console.error(`[AgnesDigital][HiddenTab] Erro ao buscar ${url}:`, error);
    throw error;
  } finally {
    await cleanup();
  }
}

// ── COMUNICAÇÃO COM O DASHBOARD ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_VIA_HIDDEN_TAB') {
    (async () => {
      try {
        const result = await fetchViaHiddenTab(message.url, message.selector || '.chapter-content');
        sendResponse({ success: true, data: result });
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();
    // Retorna true para manter o canal aberto para resposta assíncrona
    return true;
  }

  if (message.type === 'FETCH_CHERRYMIST_API') {
    (async () => {
      try {
        const { chapterId, slug } = message;

        // 1. Tenta executar via script no contexto de qualquer aba aberta do Cherrymist
        const allTabs = await chrome.tabs.query({});
        const cherryTab = allTabs.find(t => t.url && t.url.includes('cherrymist.cafe'));

        if (cherryTab && cherryTab.id) {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: cherryTab.id },
              func: async (cId, cSlug) => {
                try {
                  let id = cId;
                  if (!id && cSlug) {
                    const sRes = await fetch('/api/chapters/by-slug/' + cSlug, { credentials: 'include' });
                    if (sRes.ok) {
                      const sData = await sRes.json();
                      if (sData && sData.id) id = sData.id;
                    }
                  }
                  if (!id) return { success: false, error: 'ID do capítulo não encontrado' };
                  const cRes = await fetch('/api/chapters/' + id, { credentials: 'include' });
                  if (!cRes.ok) return { success: false, status: cRes.status, error: 'HTTP ' + cRes.status };
                  const cData = await cRes.json();

                  // Se o corpo foi retido com revealTicket 
                  if (cData.bodyWithheld && cData.revealTicket) {
                    try {
                      const ticket = cData.revealTicket;
                      const rawPayload = ticket.split('.')[1];
                      const padded = rawPayload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - rawPayload.length % 4) % 4);
                      const payload = JSON.parse(atob(padded));
                      const jti = payload.jti;

                      if (jti) {
                        const KEY = '457698978af0c511a6ebfd44efc0679651c0b0485fec76fe9a5acab91a26eb02';
                        const msg = `chapter-reveal.v1.${id}.${jti}`;
                        const enc = new TextEncoder();
                        const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
                        const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msg));
                        const proof = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

                        const revRes = await fetch(`/api/chapters/${id}/reveal`, {
                          method: 'POST',
                          credentials: 'include',
                          headers: {
                            'Content-Type': 'application/json',
                            'X-CM-Reader': '1'
                          },
                          body: JSON.stringify({
                            ticket: ticket,
                            frames: 40,
                            elapsedMs: 650,
                            visible: true,
                            focused: true,
                            proof: proof
                          })
                        });

                        if (revRes.ok) {
                          const revData = await revRes.json();
                          if (revData && revData.content) {
                            cData.content = revData.content;
                            if (revData.foreword) cData.foreword = revData.foreword;
                            if (revData.afterword) cData.afterword = revData.afterword;
                            cData.bodyWithheld = false;
                          }
                        }
                      }
                    } catch (revErr) {
                      console.warn('[AgnesDigital] Erro no reveal:', revErr);
                    }
                  }

                  // Fallback: se o capítulo já estiver aberto e renderizado na aba ativa pelo leitor
                  if (!cData.content) {
                    const readerEl = document.querySelector('[style*="--cm-cipher"]') || document.querySelector('.space-y-6');
                    if (readerEl && readerEl.innerText && readerEl.innerText.trim().length > 100) {
                      cData.content = readerEl.innerHTML;
                    }
                  }

                  return { success: true, data: cData };
                } catch (e) {
                  return { success: false, error: e.message || String(e) };
                }
              },
              args: [chapterId, slug]
            });

            if (results && results[0] && results[0].result && results[0].result.success) {
              sendResponse({ success: true, data: results[0].result.data });
              return;
            }
          } catch (injectErr) {
            console.warn('[AgnesDigital] Falha ao consultar aba ativa Cherrymist:', injectErr);
          }
        }

        // 2. Se nenhuma aba estiver aberta ou se falhou, usa a Hidden Tab
        const hiddenRes = await fetchViaHiddenTab(
          `https://cherrymist.cafe/chapter/${slug || chapterId || '1'}?id=${chapterId || ''}`,
          '#root'
        );

        if (hiddenRes && hiddenRes.success) {
          sendResponse({ success: true, data: hiddenRes });
        } else {
          sendResponse({ success: false, error: hiddenRes?.error || 'Erro ao carregar capítulo via aba oculta' });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message || String(err) });
      }
    })();
    return true;
  }
});
