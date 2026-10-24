/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║ Agnes Digital — Novels Downloader                                       ║
 * ║ Copyright (c) 2026 Christian Stadler                                    ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 *
 * @file cherrymist.js
 * @description Módulo de decodificação e engenharia reversa do Cherrymist Cafe.
 *              Trata da cifra de fontes PUA (0xE000-0xE0FF) com 15 seeds fixas
 *              e comunicação com a API REST / Service Worker.
 *
 * @pipeline Scanner / Dashboard → CherrymistDecoder → ChapterExtractor
 * @requires window.AgnesLog
 */

'use strict';

(function () {
  /**
   * Tabelas de decodificação para as 15 seeds do Cherrymist Cafe.
   * Mapeia codepoints Unicode Private Use Area 0xE000 até 0xE0FF (índices 0 a 255).
   */
  const CHERRYMIST_SEEDS = {
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

  /**
   * Decodifica texto codificado com fonte PUA usando a seed correspondente.
   * @param {string} text - Texto bruto contendo caracteres PUA.
   * @param {number|string} [seed=1] - Índice da seed (1 a 15).
   * @returns {string} Texto decodificado legível.
   */
  function decodeCherrymistContent(text, seed) {
    if (!text) return '';
    const s = parseInt(seed, 10) || 1;
    const table = CHERRYMIST_SEEDS[s] || CHERRYMIST_SEEDS[1];
    if (!table) return text;

    let result = '';
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xE000 && code < 0xE100) {
        result += table[code - 0xE000] || text[i];
      } else {
        result += text[i];
      }
    }
    return result;
  }

  /**
   * Faz requisição IPC ao Service Worker para buscar capítulo via aba com contexto de sessão.
   * @param {string|number} chapterId
   * @param {string} slug
   * @returns {Promise<object|null>}
   */
  async function fetchCherrymistViaTab(chapterId, slug) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'FETCH_CHERRYMIST_API',
        chapterId: chapterId,
        slug: slug
      }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.success) {
          resolve(null);
        } else {
          resolve(resp.data);
        }
      });
    });
  }

  function escapeXml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  /**
   * Extrai e decodifica um capítulo do Cherrymist Cafe dado seu URL.
   * Suporta resolução de ID/slug, fetch nativo, descriptografia de PUA e formatação de parágrafos.
   * @param {string} url
   * @returns {Promise<{title: string, content: string}>}
   */
  async function extract(url) {
    let chapterId = null;
    let chapterTitle = null;
    let slug = null;

    const urlObj = new URL(url);
    if (urlObj.searchParams.has('id')) {
      chapterId = urlObj.searchParams.get('id');
    } else {
      const idMatch = url.match(/\/api\/chapters\/(\d+)/i) || url.match(/\/chapter\/(\d+)/i);
      if (idMatch) chapterId = idMatch[1];
    }

    const slugMatch = url.match(/\/chapter(?:s)?\/([^/?#]+)/i);
    if (slugMatch) {
      slug = slugMatch[1];
    }

    // 1. Tenta buscar via Service Worker (aba aberta do usuário ou hidden tab sem CORS)
    let chData = await fetchCherrymistViaTab(chapterId, slug);

    // Se retornou objeto já pré-processado pela hidden tab
    if (chData && chData.html) {
      const cleanFn = (window.ChapterExtractor && window.ChapterExtractor.cleanHtml) || (window.cleanChapterHtml) || (h => h);
      return {
        title: (chapterTitle || chData.title || ('Capítulo ' + (chapterId || slug))).trim(),
        content: cleanFn(chData.html)
      };
    }

    // 2. Se a aba não respondeu, tenta resolver slug e buscar direto via fetch
    if (!chData) {
      if (!chapterId && slug) {
        try {
          const slugRes = await fetch(`https://cherrymist.cafe/api/chapters/by-slug/${slug}`, { credentials: 'include' });
          if (slugRes.ok) {
            const slugData = await slugRes.json();
            if (slugData && slugData.id) {
              chapterId = slugData.id;
              chapterTitle = slugData.title;
            }
          }
        } catch (_) {}
      }

      if (chapterId) {
        try {
          const chRes = await fetch(`https://cherrymist.cafe/api/chapters/${chapterId}`, { credentials: 'include' });
          if (chRes.ok) {
            chData = await chRes.json();
          }
        } catch (_) {}
      }
    }

    if (chData && chData.content) {
      let content = chData.content;
      const seed = (chData.cipher && chData.cipher.seed) || 1;

      // Decodifica se contiver glifos PUA do Font Cipher (0xE000-0xE0FF)
      if (/[\uE000-\uE0FF]/.test(content)) {
        content = decodeCherrymistContent(content, seed);
      }

      let bodyHtml = '';
      if (content.includes('<p') || content.includes('<span') || content.includes('<div') || content.includes('<br')) {
        bodyHtml = content;
      } else {
        bodyHtml = content
          .split(/\r?\n\r?\n/)
          .map(p => p.trim())
          .filter(Boolean)
          .map(p => '<p>' + escapeXml(p).replace(/\r?\n/g, '<br/>') + '</p>')
          .join('\n');
      }

      if (chData.foreword) {
        let decForeword = chData.foreword;
        if (/[\uE000-\uE0FF]/.test(decForeword)) {
          decForeword = decodeCherrymistContent(decForeword, seed);
        }
        if (decForeword.trim()) {
          const forewordContent = (decForeword.includes('<p') || decForeword.includes('<div'))
            ? decForeword
            : escapeXml(decForeword).replace(/\r?\n/g, '<br/>');
          bodyHtml = '<div class="foreword"><blockquote>' + forewordContent + '</blockquote></div><hr/>\n' + bodyHtml;
        }
      }

      if (chData.afterword) {
        let decAfterword = chData.afterword;
        if (/[\uE000-\uE0FF]/.test(decAfterword)) {
          decAfterword = decodeCherrymistContent(decAfterword, seed);
        }
        if (decAfterword.trim()) {
          const afterwordContent = (decAfterword.includes('<p') || decAfterword.includes('<div'))
            ? decAfterword
            : escapeXml(decAfterword).replace(/\r?\n/g, '<br/>');
          bodyHtml += '\n<hr/><div class="afterword"><blockquote>' + afterwordContent + '</blockquote></div>';
        }
      }

      const finalTitle = chapterTitle || chData.title || ('Capítulo ' + (chData.chapter_number || chapterId));
      const cleanFn = (window.ChapterExtractor && window.ChapterExtractor.cleanHtml) || (window.cleanChapterHtml) || (h => h);
      return {
        title: finalTitle.trim(),
        content: cleanFn(bodyHtml)
      };
    }

    throw new Error('Não foi possível obter dados do capítulo via API do Cherrymist Cafe.');
  }

  // Exportação no escopo global
  window.CherrymistDecoder = {
    SEEDS: CHERRYMIST_SEEDS,
    decode: decodeCherrymistContent,
    fetchViaTab: fetchCherrymistViaTab,
    extract: extract
  };

  // Compatibilidade com código legado
  window.CHERRYMIST_SEEDS = CHERRYMIST_SEEDS;
  window.decodeCherrymistContent = decodeCherrymistContent;
  window.fetchCherrymistViaTab = fetchCherrymistViaTab;
})();

