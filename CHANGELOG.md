# Changelog — Agnes Digital

Todas as alterações notáveis neste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/),
e este projeto adere ao [Versionamento Semântico](https://semver.org/lang/pt-BR/).

---

## [1.0.1] - 2026-10-24

### 🛡️ Correções de Segurança e Conformidade (AMO & Manifest)

#### Corrigido (Fixed)
- **Eliminação de alertas de segurança do linter da Mozilla (AMO):**
  - `lib/txt-builder.js`: Substituído o uso de elemento temporário `textarea.innerHTML` por decodificação estática e regex de entidades HTML numéricas e nomeadas.
  - `lib/md-builder.js`: Removida a atribuição de `textarea.innerHTML`, padronizando com decodificação direta de entidades.
  - `lib/library-manager.js`: Substituída a concatenação de HTML em string via `card.innerHTML` por criação estruturada segura de nós DOM (`document.createElement`, `textContent`, `appendChild` e `replaceChildren`).
- **Compatibilidade do Manifesto Firefox:**
  - `extension/firefox/manifest.json`: Atualizado `strict_min_version` para `"142.0"` para alinhar formalmente com os requisitos de suporte da API `declarativeNetRequest` e da propriedade de privacidade `data_collection_permissions`.
  - Bump de versão para `1.0.1` nos manifestos do Firefox e Chrome.

---

## [1.0.0] - 2026-10-11

### 🎉 Lançamento Inicial Oficial (Fase 1)

#### Adicionado (Added)
- **Suporte Multiformato Completo:**
  - `lib/epub-builder.js`: Compilação de EPUB 3.0 com suporte retrocompatível a EPUB 2 NCX, sumário hierárquico, notas de rodapé bidirecionais e sanitização estrita de XHTML.
  - `lib/pdf-exporter.js`: Geração de PDF via jsPDF com capas, marcadores estruturais (outlines) e suporte a páginas contínuas dimensionadas dinamicamente para quadrinhos e webtoons.
  - `lib/cbz-builder.js`: Empacotamento de mangás e webtoons com numeração com zeros à esquerda (`page_0001.jpg`) e inclusão automática de `ComicInfo.xml` com `<Manga>Webtoon</Manga>` para rolagem vertical.
  - `lib/txt-builder.js`: Exportador de texto plano limpo com encoding UTF-8 BOM e separadores configuráveis.
  - `lib/md-builder.js`: Exportador de Markdown estruturado com metadados YAML Front Matter e conversão de tags semânticas.
  - `lib/exporter-registry.js`: Sistema desacoplado de plugins para novos formatos de saída.
- **Engenharia Reversa & Deofuscação Especializada:**
  - `lib/ciphers/cherrymist.js`: Decodificação das 15 seeds estáticas da **Cifra de Fontes PUA** (`0xE000-0xE0FF`) do Cherrymist Cafe, suporte à API REST `/api/chapters` e fluxo de assinatura HMAC-SHA256 para reveal tickets.
  - `lib/ciphers/fictioneer.js`: Deofuscação multipart ROT13 + Base64 para capítulos protegidos pelo tema WordPress Fictioneer.
  - Suporte ao template Madara via endpoint AJAX `/wp-admin/admin-ajax.php` com `action=manga_get_chapters`.
  - Suporte a capítulos embutidos em WebNovel (`var chapInfo=`).
- **Motor de Tradução Multi-Engine:**
  - `lib/translator.js`: Cascata de tradução com Google Translate HTML Protobuf (preserva formatação e quebra de parágrafos), PA v1 e GTX Legacy.
  - Semáforo/Mutex global no Dashboard para evitar bloqueios por concorrência (HTTP 429).
  - Modo de leitura bilíngue (parágrafos alternados no original e tradução).
- **Minha Biblioteca (Offline First):**
  - `lib/db.js`: Persistência local no IndexedDB (`AgnesDB`) para salvar projetos e progresso de download para retomada (resume).
  - `lib/library-manager.js`: Interface de cards salvos e sincronização incremental inteligente de novos capítulos (`diffChapters`).
- **Interface Studio Moderna:**
  - Layout Split-View com pré-visualização da capa e upload local de imagens.
  - Renderização da tabela de capítulos via `DocumentFragment` com busca e filtros em tempo real sem travamentos.
  - Alternância de temas Claro (Light) e Escuro (Dark).
  - Bloqueio de formulários durante download ativo para consistência de dados.
  - Timeout de rede seguro (20s via `AbortSignal`) com fallback automático para abas ocultas.
- **Internacionalização (i18n):**
  - Suporte nativo completo a 7 idiomas: Português (`pt_BR`), Inglês (`en`), Espanhol (`es`), Francês (`fr`), Alemão (`de`), Russo (`ru`) e Chinês Simplificado (`zh_CN`).
  - Nomes e descrições dos manifestos localizados via `__MSG_...__`.
- **Identidade Visual:**
  - Conjunto de ícones oficiais (16, 32, 48 e 128 px) com o mascote acadêmico Agnes Digital.
  - Arquivo especial e easter egg: [`AgnesDigital.md`](AgnesDigital.md).
  - Licença formalizada como **Apache 2.0**.

