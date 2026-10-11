create extension if not exists vector with schema extensions;

create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  source_path text not null,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (length(trim(content)) > 0),
  embedding extensions.vector(768) not null,
  created_at timestamptz not null default now(),
  unique (source_path, chunk_index)
);

create index knowledge_chunks_embedding_hnsw_idx
  on public.knowledge_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

alter table public.knowledge_chunks enable row level security;
grant select, insert, update on public.knowledge_chunks to service_role;

create function public.match_knowledge_chunks(
  query_embedding extensions.vector(768),
  match_count integer default 3
)
returns table (
  id uuid,
  content text,
  source_path text,
  similarity double precision
)
language sql
stable
set search_path = public, extensions
as $$
  select
    chunks.id,
    chunks.content,
    chunks.source_path,
    1 - (chunks.embedding <=> query_embedding) as similarity
  from public.knowledge_chunks as chunks
  order by chunks.embedding <=> query_embedding
  limit least(greatest(coalesce(match_count, 0), 0), 3);
$$;

revoke all on function public.match_knowledge_chunks(extensions.vector, integer) from public, anon, authenticated;
grant execute on function public.match_knowledge_chunks(extensions.vector, integer) to service_role;
