-- Esquema Supabase para a sincronização do Microacessibilidades — Lisboa.
-- Executar no SQL editor do projeto Supabase (Database → SQL Editor).
--
-- Pode ser executado no MESMO projeto Supabase usado por outra app (ex.: o
-- Selo de Acessibilidade) — usa uma tabela e um bucket próprios, para não
-- misturar dados entre apps.

-- Tabela principal: uma linha por registo de barreira, tal como descrito no README.
create table if not exists barreiras_pedonais (
  id text primary key,                 -- id já gerado no cliente (Store)
  equipa text not null default 'default',
  dados jsonb not null,                -- o registo completo (sem a foto em base64)
  atualizado timestamptz not null,     -- para resolver conflitos (last-write-wins)
  eliminado boolean not null default false
);

-- Acelera o pull incremental ("atualizado > último sync"), filtrado por equipa.
create index if not exists barreiras_pedonais_equipa_atualizado_idx
  on barreiras_pedonais (equipa, atualizado);

alter table barreiras_pedonais enable row level security;

-- Política simples por "código de equipa": qualquer pessoa com a anon key
-- pode ler/escrever qualquer linha. Isto é adequado para partilha por código
-- de equipa (sem contas); endurecer com Supabase Auth se for preciso
-- restringir por utilizador (ver README, secção "Autenticação / partilha").
drop policy if exists "acesso por equipa" on barreiras_pedonais;
create policy "acesso por equipa" on barreiras_pedonais
  for all using (true) with check (true);

-- Storage: bucket para as fotografias, para não irem em base64 nas linhas.
-- Criar via SQL (ou em Storage → New bucket na consola). Público para leitura
-- simples das fotos pela app; escrita permitida a qualquer cliente com a
-- anon key (mesmo modelo de confiança da tabela acima).
insert into storage.buckets (id, name, public)
values ('fotos-pedonal', 'fotos-pedonal', true)
on conflict (id) do nothing;

drop policy if exists "leitura publica de fotos pedonal" on storage.objects;
create policy "leitura publica de fotos pedonal" on storage.objects
  for select using (bucket_id = 'fotos-pedonal');

drop policy if exists "upload de fotos pedonal" on storage.objects;
create policy "upload de fotos pedonal" on storage.objects
  for insert with check (bucket_id = 'fotos-pedonal');

drop policy if exists "atualizacao de fotos pedonal" on storage.objects;
create policy "atualizacao de fotos pedonal" on storage.objects
  for update using (bucket_id = 'fotos-pedonal');
