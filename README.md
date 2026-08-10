# Microacessibilidades — Lisboa

App para registar **barreiras de microacessibilidade pedonal** no espaço público de Lisboa —
piso degradado, rampas e lancis em falta ou inadequados, obstáculos que reduzem a largura livre
de circulação, e falhas no piso podotátil ou nas travessias. Cada registo tem fotografia,
localização (GPS), categoria/subcategoria e nível de gravidade.

As categorias baseiam-se nas normas técnicas de acessibilidade para vias e espaços exteriores
do DL 163/2006 (largura livre mínima do passeio, inclinação máxima de rampas, lancis
rebaixados nas passadeiras, piso podotátil de alerta e direcional).

É uma **PWA instalável e offline**, com **sincronização entre dispositivos** via Supabase.

## Conteúdo

```
index.html              A app (HTML/CSS/JS, tudo num ficheiro)
sync.js                 Sincronização com Supabase (pull/push/fila offline)
schema.sql               Esquema da base de dados + Storage (executar no Supabase)
manifest.webmanifest     Manifesto da PWA (nome, ícones, cores)
sw.js                    Service worker (offline)
vendor/supabase.js       Cliente Supabase JS, vendorizado para funcionar offline
vendor/leaflet.js/css    Biblioteca de mapas, vendorizada para funcionar offline
icons/                   Ícones 180/192/512 + maskable
```

## Estado atual

- **Instalável**: manifesto + ícones + meta tags de ecrã inteiro.
- **Offline garantido**: o `sw.js` guarda a app (incluindo os clientes Supabase e Leaflet) em
  cache; depois da 1ª abertura funciona sem rede. A UI nunca espera pela rede — os dados ficam
  primeiro em `localStorage` e sincronizam em segundo plano. O mapa em si precisa de rede para
  carregar as imagens dos mapas (normal em qualquer app de mapas).
- **Sincronização entre dispositivos**: registos e fotografias partilhados por "código de
  equipa", com fila offline e resolução de conflitos por *last-write-wins*.

## Categorias de barreira

| Categoria | Exemplos de subcategoria |
|---|---|
| Piso e pavimento | Piso irregular, buracos, desnível sem rampa, piso escorregadio |
| Rampas e lancis | Rampa inexistente ou com inclinação excessiva, lancil demasiado alto |
| Obstáculos e largura livre | Mobiliário urbano, esplanadas, veículos mal estacionados, largura < 1,20 m |
| Piso podotátil e travessias | Piso podotátil em falta/danificado, passadeira sem rebaixamento, sem sinal sonoro |

Cada registo tem ainda uma **freguesia** (as 24 de Lisboa) e uma **gravidade** (Baixa/Média/Alta).

## Como publicar (necessário para PWA e service worker)

O service worker só funciona sobre **HTTPS** (ou `localhost`) — não a partir de `file://`.
Publica a pasta inteira num alojamento estático gratuito. Qualquer um destes serve:

- **Cloudflare Pages** ou **Netlify**: liga a um repositório Git, ou arrasta a pasta. Sem build.
- **GitHub Pages**: coloca os ficheiros num repositório e ativa Pages.

Depois de publicada, abre o endereço no telemóvel e usa **Adicionar ao ecrã principal**
(iPhone/Safari) ou **Instalar aplicação** (Android/Chrome).

### Testar localmente

```bash
# a partir da pasta do projeto
python3 -m http.server 8080
# abre http://localhost:8080  (o service worker funciona em localhost)
```

### Atualizações

Depois de mudares o `index.html`, `sync.js` ou os ícones, incrementa a versão do cache no
`sw.js` (`acessibilidade-pedonal-v1` → `acessibilidade-pedonal-v2`). Os dispositivos
instalados atualizam sozinhos (pode ser preciso fechar e reabrir a app duas vezes).

---

## Configurar a sincronização com Supabase

1. **Criar o projeto** em [supabase.com](https://supabase.com) (tem plano gratuito) — ou usar
   um projeto já existente, mesmo partilhado com outra app, desde que cada uma use a sua
   própria tabela/bucket (é o que este esquema já faz).
2. **Base de dados**: no SQL Editor do projeto, corre o conteúdo de `schema.sql`. Isto cria
   a tabela `barreiras_pedonais`, as políticas de acesso (RLS) e o bucket de Storage
   `fotos-pedonal` para as fotografias.
3. **Chaves**: em *Project Settings → API*, copia o **Project URL** e a chave **anon
   public** / **publishable** e preenche o objeto `CONFIG` no topo de `sync.js`:

   ```js
   const CONFIG = {
     url: "https://xxxxxxxxxxxx.supabase.co",
     anonKey: "sb_publishable_...",
     table: "barreiras_pedonais",
     bucket: "fotos-pedonal",
   };
   ```

   Essa chave é pública por design — a segurança fica a cargo das políticas RLS em
   `schema.sql`, não da chave estar "escondida".
4. **Publicar** — depois de preencher as chaves, publica a app (ver secção acima). Sem
   chaves configuradas, a app continua a funcionar normalmente em modo local/offline; a
   sincronização fica apenas desligada (indicado no botão de estado, ver abaixo).

### Como funciona

- **Código de equipa**: toca no indicador junto ao contador de registos (canto superior
  da lista) para definir/mudar o código de equipa partilhado por todos os dispositivos que
  devem ver os mesmos registos. Sem código definido, usa-se `default`.
- **Pull**: ao arrancar e sempre que a ligação volta (evento `online`), a app vai buscar as
  linhas alteradas desde o último sync dessa equipa e faz merge por `id`, com regra
  *last-write-wins* pelo campo `atualizado`. Registos eliminados noutro dispositivo
  (tombstone `eliminado=true`) são removidos localmente.
- **Push**: `Store.save()` grava sempre primeiro em local (a UI nunca espera pela rede) e só
  depois envia (`upsert`) para o Supabase. Sem rede, o `id` fica numa fila em `localStorage`
  e é reenviado automaticamente quando a ligação volta.
- **Fotografias**: ao guardar um registo com foto nova, a imagem (já redimensionada,
  canvas → JPEG 0,7, máx. 1024px) é enviada para o bucket `fotos-pedonal` do Supabase Storage
  em segundo plano; o registo passa a ter `foto_url` e essa é a única versão da foto enviada
  para a base de dados — nunca em base64 dentro das linhas. Assim que a foto está guardada na
  nuvem, a cópia local pesada (base64) é apagada para libertar espaço no telemóvel.
- **Estado de sincronização**: o botão junto ao contador mostra `sincronizado`,
  `a sincronizar…`, `offline`, `erro de sync` ou `sync desligado` (sem chaves configuradas).

### Dados & Exportação

- Cada registo tem `id` único, gerado no cliente, e um campo `atualizado` (timestamp),
  usados como ponto único de integração com a sincronização.
- **Exportar CSV**: botão "Exportar" no formulário de um registo, ou o ícone junto ao
  contador na lista para exportar tudo.

### Critério de pronto

- Criar um registo num dispositivo e vê-lo aparecer noutro após o sync.
- Editar offline e confirmar que reconcilia ao voltar a ligar (sem perder dados).
- Fotografias a carregar a partir do Storage, não embebidas nas linhas.
- App continua a instalar e a abrir offline.

## Notas

- Manter a app **local-first**: a UI nunca deve bloquear à espera da rede.
- A política de acesso em `schema.sql` (`acesso por equipa`) é intencionalmente simples —
  qualquer cliente com a anon key lê/escreve qualquer linha, e o "código de equipa" é apenas
  um filtro lógico, não uma barreira de segurança. Para restringir por utilizador, trocar por
  Supabase Auth (magic link) e políticas RLS filtradas por utilizador — ver comentários em
  `schema.sql`.
- Se esta app estiver publicada no GitHub Pages junto de outras páginas de projeto do mesmo
  utilizador (`username.github.io/outra-app/`), repara que o `localStorage` é isolado por
  **origem**, não por caminho — todas as páginas de projeto de `username.github.io` partilham
  a mesma origem. Por isso as chaves de armazenamento aqui usam o prefixo `pedonal_`, para não
  colidirem com as de outra app no mesmo domínio.
