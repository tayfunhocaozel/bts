-- ═══════════════════════════════════════════════════════════════════════════
-- AI üyeliği — Aşama 1B: üyelik alanları, kullanım ölçümü, talepler
--
-- * ogretmenler.ai_aktif / ai_aylik_kota_token / ai_bitis
--   Varsayılan KAPALI; yalnız ana öğretmen açık başlar. Bu kolonlar
--   ogretmenler_yazma_koruma beyaz listesinde OLMADIĞI için öğretmen kendisi
--   değiştiremez — yalnız service_role (admin-ops / edge function).
-- * ai_kullanim: her AI isteğinin Gemini usageMetadata'sı (edge function yazar).
--     giris_token    = promptTokenCount − cachedContentTokenCount (önbellek hariç giriş)
--     onbellek_token = cachedContentTokenCount
--     cikis_token    = candidatesTokenCount
--     dusunme_token  = thoughtsTokenCount
--   Kota = giris + cikis + dusunme (önbellek hariç).
--   ogretmen_id NULL → çağıran 'adaptix' (yönetici); ogrenci_id → öğrenci çağrısı.
-- * ai_talepleri: öğretmenin "AI üyeliği başlat" talebi (Aşama 2'de kullanılacak).
--   "not" SQL'de ayrılmış kelime olduğu için kolon adı notlar (faturalar ile aynı).
-- * RLS: öğretmen yalnız kendi satırlarını OKUR, adaptix hepsini okur.
--   anon/authenticated için yazma yetkisi YOK — yazma yalnız service_role.
-- * ai_kapi_durumu(): edge function kapısının tek sorgusu (service_role).
-- Geri alma: 20261005_ai_uyelik_rollback.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. ogretmenler: üyelik alanları ─────────────────────────────────────────
alter table public.ogretmenler
  add column if not exists ai_aktif            boolean not null default false,
  add column if not exists ai_aylik_kota_token integer,
  add column if not exists ai_bitis            date;

alter table public.ogretmenler drop constraint if exists ogretmenler_ai_kota_chk;
alter table public.ogretmenler
  add constraint ogretmenler_ai_kota_chk
  check (ai_aylik_kota_token is null or ai_aylik_kota_token > 0);

-- Ana öğretmen (ANA_OGRETMEN) açık, kotasız, süresiz başlar
update public.ogretmenler
   set ai_aktif = true, ai_aylik_kota_token = null, ai_bitis = null
 where ogretmen_id = 'b373a4e6-01b1-4131-99d4-a2deae98b1ea';

-- ── 2. ai_kullanim ──────────────────────────────────────────────────────────
create table if not exists public.ai_kullanim (
  id               bigint generated always as identity primary key,
  ogretmen_id      uuid references public.ogretmenler(ogretmen_id) on delete cascade,
  ogrenci_id       text references public.ogrenciler(ogrenci_id) on delete set null,
  fonksiyon        text not null,
  model            text not null,
  giris_token      integer not null default 0 check (giris_token    >= 0),
  cikis_token      integer not null default 0 check (cikis_token    >= 0),
  dusunme_token    integer not null default 0 check (dusunme_token  >= 0),
  onbellek_token   integer not null default 0 check (onbellek_token >= 0),
  olusturma_tarihi timestamptz not null default now()
);

create index if not exists ai_kullanim_ogretmen_tarih_idx
  on public.ai_kullanim (ogretmen_id, olusturma_tarihi);

alter table public.ai_kullanim enable row level security;
revoke all on public.ai_kullanim from anon, authenticated;
grant select on public.ai_kullanim to authenticated;

drop policy if exists auth_select on public.ai_kullanim;
create policy auth_select on public.ai_kullanim for select to authenticated
  using (public.jwt_rol() = 'adaptix' or public.jwt_is_ogretmen_of(ogretmen_id));

-- ── 3. ai_talepleri ─────────────────────────────────────────────────────────
create table if not exists public.ai_talepleri (
  id               uuid primary key default gen_random_uuid(),
  ogretmen_id      uuid not null references public.ogretmenler(ogretmen_id) on delete cascade,
  durum            text not null default 'bekliyor'
                   check (durum in ('bekliyor', 'goruldu', 'aktif', 'reddedildi')),
  notlar           text check (notlar is null or length(notlar) <= 1000),
  olusturma_tarihi timestamptz not null default now()
);

-- Aynı öğretmenin aynı anda yalnız bir bekleyen talebi olabilir
create unique index if not exists ai_talepleri_tek_bekleyen_idx
  on public.ai_talepleri (ogretmen_id) where durum = 'bekliyor';
create index if not exists ai_talepleri_ogretmen_idx
  on public.ai_talepleri (ogretmen_id, olusturma_tarihi);

alter table public.ai_talepleri enable row level security;
revoke all on public.ai_talepleri from anon, authenticated;
grant select on public.ai_talepleri to authenticated;

drop policy if exists auth_select on public.ai_talepleri;
create policy auth_select on public.ai_talepleri for select to authenticated
  using (public.jwt_rol() = 'adaptix' or public.jwt_is_ogretmen_of(ogretmen_id));

-- ── 4. Kapı sorgusu ─────────────────────────────────────────────────────────
-- Öğretmeni (öğrenci çağrısında ogrenciler.ogretmen_id'den) çözer; üyelik
-- alanlarını ve bu ayın (Türkiye saatiyle) kullanımını tek seferde döndürür.
-- Öğrenci kaydı bulunamazsa p_ogretmen_id (JWT'deki yedek) kullanılır.
create or replace function public.ai_kapi_durumu(p_ogretmen_id uuid, p_ogrenci_id text default null)
returns jsonb
language sql stable
set search_path = public
as $$
  with hedef as (
    select coalesce(
      (select o.ogretmen_id from public.ogrenciler o where o.ogrenci_id = p_ogrenci_id),
      p_ogretmen_id
    ) as ogretmen_id
  ),
  ay as (
    select (date_trunc('month', now() at time zone 'Europe/Istanbul')
            at time zone 'Europe/Istanbul') as bas
  )
  select jsonb_build_object(
    'ogretmen_id',  t.ogretmen_id,
    'bulundu',      (t.ai_aktif is not null),  -- ai_aktif NOT NULL: null ise kayıt yok
    'ai_aktif',     t.ai_aktif,
    'ai_bitis',     t.ai_bitis,
    'bitti',        (t.ai_bitis is not null
                     and t.ai_bitis < (now() at time zone 'Europe/Istanbul')::date),
    'kota',         t.ai_aylik_kota_token,
    'kullanilan',   coalesce((
                      select sum(k.giris_token + k.cikis_token + k.dusunme_token)
                        from public.ai_kullanim k, ay
                       where k.ogretmen_id = t.ogretmen_id
                         and k.olusturma_tarihi >= ay.bas), 0)
  )
  from (select h.ogretmen_id, g.ai_aktif, g.ai_bitis, g.ai_aylik_kota_token
          from hedef h left join public.ogretmenler g on g.ogretmen_id = h.ogretmen_id) t;
$$;

revoke all on function public.ai_kapi_durumu(uuid, text) from public, anon, authenticated;
grant execute on function public.ai_kapi_durumu(uuid, text) to service_role;
