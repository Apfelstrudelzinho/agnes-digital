<p align="center">
  <img src="assets/agnes_digital_logo.png" alt="Agnes Digital — Novels Downloader" width="180" />
</p>

<h1 align="center">Agnes Digital — Novels Downloader</h1>

<p align="center">
  <b>A suíte definitiva de download, tradução e compilação de web novels, light novels e mangás em múltiplos formatos.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Versão-1.0.0-blue.svg?style=flat-square" alt="Version 1.0.0" />
  <img src="https://img.shields.io/badge/Manifest-V3-success.svg?style=flat-square" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/Firefox%20Desktop-Dispon%C3%ADvel-orange.svg?style=flat-square" alt="Firefox Desktop" />
  <img src="https://img.shields.io/badge/Chrome%20Web%20Store-Em%20Breve-lightgrey.svg?style=flat-square" alt="Chrome Web Store Em Breve" />
  <img src="https://img.shields.io/badge/Licen%C3%A7a-Apache%202.0-green.svg?style=flat-square" alt="Apache 2.0" />
  <img src="https://img.shields.io/badge/Idiomas-7%20Locales-blueviolet.svg?style=flat-square" alt="7 Locales" />
</p>

---

## ✨ Principais Funcionalidades

### 📚 1. Exportação Multiformato Avançada
* **EPUB 3.0 Nativo (+ EPUB 2 NCX):** Sumário hierárquico navegável (`nav.xhtml` e `toc.ncx`), metadados OPF completos, notas de rodapé bidirecionais interativas (`epub:type="noteref"` / `footnote`) compatíveis com Kindle, Kobo e Apple Books.
* **PDF com Dimensionamento Dinâmico:** Páginas redimensionadas proporcionalmente para quadrinhos e webtoons contínuos, além de paginação A4 elegante para romances.
* **CBZ para Quadrinhos/Mangás:** Imagens sequenciais com numeração padded (`page_0001.jpg`) e injeção automática de `ComicInfo.xml` com `<Manga>Webtoon</Manga>` para rolagem vertical em leitores modernos (Tachiyomi, Mihon, CDisplayEx).
* **Markdown Estruturado (MD):** Limpeza semântica completa de tags HTML com cabeçalhos YAML Front Matter prontos para Obsidian e Logseq.
* **Texto Puro (TXT):** Saída limpa UTF-8 com BOM e separadores configuráveis.

### 🌐 2. Cascata Inteligente de Tradução Simultânea
* **Motor Multi-Engine:** Alterna dinamicamente entre Google Translate Protobuf (preserva tags HTML intactas sem quebrar parágrafos), PA v1 e GTX Legacy.
* **Semáforo/Mutex Global:** Gerencia a concorrência de tradução para evitar bloqueios temporários (HTTP 429).
* **Modo Bilíngue Opcional:** Permite ler parágrafos alternados no idioma original e traduzido.

### 🏛️ 3. Minha Biblioteca (Offline First)
* Persistência em banco de dados local **IndexedDB (`AgnesDB`)**.
* Visualização em cards de todas as novels baixadas.
* Sincronização incremental inteligente (`diffChapters`): detecta e baixa apenas capítulos inéditos lançados após o último download.

---

## 🌐 Sites Compatíveis e Testados

Abaixo está a lista de sites onde a extração de capítulos e conteúdo foi testada e verificada:

> [!WARNING]
> **Aviso de Compatibilidade:** Os sites da web passam por constantes atualizações de layout, trocas de temas, modificações em suas APIs internas e alterações em mecanismos de proteção. Por esse motivo, uma atualização por parte do próprio site pode, a qualquer momento, quebrar ou limitar a compatibilidade da extensão até que um novo ajuste seja realizado.

* *(Espaço reservado para adicionar os sites testados)*

---

## 🚀 Disponibilidade e Instalação

### 📦 Status das Lojas Oficiais
* **Mozilla Firefox (Desktop):** Enviado para o [Firefox Add-ons (AMO)](https://addons.mozilla.org/) e aguardando publicação.
* **Google Chrome Web Store:** Em preparação (ainda não publicado na loja oficial).
* **Firefox para Android (Mobile):** Atualmente a extensão foca na experiência Desktop. O suporte e adaptação para Firefox Mobile estão planejados para as próximas versões.

---

### 🛠️ Instalação em Modo Desenvolvedor (Local)

#### 🦊 No Mozilla Firefox (Desktop)
1. Abra o Firefox e acesse `about:debugging#/runtime/this-firefox`.
2. Clique no botão **"Carregar extensão temporária..."** (*Load Temporary Add-on*).
3. Navegue até a pasta `extension/firefox/` e selecione o arquivo `manifest.json`.
4. O ícone do Agnes Digital aparecerá na sua barra de extensões.

#### 🌐 No Google Chrome / Chromium / Edge / Brave (Desktop)
1. Abra o navegador e acesse `chrome://extensions/`.
2. Ative a chave **"Modo do desenvolvedor"** (*Developer mode*) no canto superior direito.
3. Clique em **"Carregar sem compactação"** (*Load unpacked*).
4. Selecione a pasta `extension/google/`.
5. Pronto! A extensão está pronta para uso local enquanto a publicação na Chrome Web Store não é finalizada.

---

## 🛠️ Arquitetura do Projeto

```text
novels-downloader/
├── assets/                  # Imagens e logos oficiais
├── extension/
│   ├── firefox/             # Build Manifest V3 para Mozilla Firefox
│   └── google/              # Build Manifest V3 para Google Chrome / Chromium
│       ├── background/      # Service Worker e gerenciador de abas ocultas
│       ├── content/         # scanner.js (Smart Scanner de páginas web)
│       ├── icons/           # Ícones oficiais (16, 32, 48, 128 px)
│       ├── _locales/        # Internacionalização completa (pt_BR, en, es, fr, de, ru, zh_CN)
│       ├── lib/             # Módulos centrais reutilizáveis
│       │   ├── ciphers/     # Decodificadores (cherrymist.js, fictioneer.js)
│       │   ├── chapter-extractor.js  # Motor heurístico e limpeza de HTML
│       │   ├── library-manager.js    # Gestão de estado do IndexedDB
│       │   ├── book-ir.js            # Representação Intermediária canônica
│       │   ├── translator.js         # Cascade de tradução multi-motor
│       │   └── *-builder.js          # Compiladores (epub, pdf, cbz, txt, md)
│       └── ui/              # Dashboard Studio (dashboard.html, .css, .js)
├── CHANGELOG.md             # Histórico detalhado de versões e alterações
├── LICENSE                  # Licença Apache 2.0
└── README.md                # Esta documentação
```

---

## 📜 Licença

Distribuído sob a licença **Apache 2.0**. Consulte o arquivo [`LICENSE`](LICENSE) para mais detalhes.
