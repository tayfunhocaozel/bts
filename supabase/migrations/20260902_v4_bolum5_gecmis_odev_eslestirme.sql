-- ═══════════════════════════════════════════════════════════════════════════
-- V4 Bölüm 5 — Geriye dönük ödev eşleştirme
--
--  * odev_kaynak_kapsam: ödev ↔ kaynak_konusu/test M:N ara tablosu
--    (bir serbest-metin ödev birden çok konuya/teste denk gelebilir).
--  * pg_trgm: Adım A bulanık isim eşleştirmesi için.
--  * gecmis_odev_eslesme_adaylari(): kaynak_id'si boş ödevleri kaynak adına
--    trigram benzerliğiyle eşleştiren aday listesi (öğretmen onaylar, SESSİZ
--    güncelleme YOK — güncelleme istemci tarafında onay sonrası yapılır).
--
--  RLS deseni: 20260901_p05_* ile aynı (custom JWT, authenticated rol).
--  odevler.odev_id TEXT olduğu için FK de TEXT.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pg_trgm;

-- ── Ara tablo ───────────────────────────────────────────────────────────────
create table if not exists public.odev_kaynak_kapsam (
  id             uuid primary key default gen_random_uuid(),
  odev_id        text not null references public.odevler(odev_id) on delete cascade,
  kaynak_konu_id uuid references public.kaynak_konulari(id) on delete cascade,
  test_no        int,
  created_at     timestamptz default now()
);

create index if not exists ix_odev_kaynak_kapsam_odev on public.odev_kaynak_kapsam(odev_id);
create index if not exists ix_odev_kaynak_kapsam_konu on public.odev_kaynak_kapsam(kaynak_konu_id);

-- aynı ödev için aynı konu/test iki kez yazılmasın (idempotent yeniden çalıştırma)
create unique index if not exists ux_odev_kaynak_kapsam_konu
  on public.odev_kaynak_kapsam(odev_id, kaynak_konu_id) where kaynak_konu_id is not null;
create unique index if not exists ux_odev_kaynak_kapsam_test
  on public.odev_kaynak_kapsam(odev_id, test_no) where test_no is not null;

alter table public.odev_kaynak_kapsam enable row level security;
grant select, insert, update, delete on public.odev_kaynak_kapsam to authenticated;

-- SELECT: adaptix; ya da bağlı ödev öğrencinin kendi ödevi / öğretmenin kendi ödevi
drop policy if exists auth_select on public.odev_kaynak_kapsam;
create policy auth_select on public.odev_kaynak_kapsam for select to authenticated
using (
  public.jwt_rol() = 'adaptix'
  or odev_id in (
    select odev_id from public.odevler
    where ogrenci_id = public.jwt_ogrenci_id()
       or public.jwt_is_ogretmen_of(ogretmen_id)
  )
);

-- WRITE: adaptix; ya da bağlı ödev öğretmenin kendi ödevi
drop policy if exists auth_write on public.odev_kaynak_kapsam;
create policy auth_write on public.odev_kaynak_kapsam for all to authenticated
using (
  public.jwt_rol() = 'adaptix'
  or odev_id in (select odev_id from public.odevler where public.jwt_is_ogretmen_of(ogretmen_id))
)
with check (
  public.jwt_rol() = 'adaptix'
  or odev_id in (select odev_id from public.odevler where public.jwt_is_ogretmen_of(ogretmen_id))
);

-- ── Adım A: bulanık eşleşme adayları ───────────────────────────────────────
-- security invoker → RLS uygulanır: öğretmen yalnız KENDİ kaynak_id'si boş
-- ödevlerini görür. Her ödev için yalnız EN İYİ eşleşme (distinct on).
create or replace function public.gecmis_odev_eslesme_adaylari(p_esik real default 0.6)
returns table (
  kaynak_id      text,
  kaynak_adi     text,
  odev_id        text,
  odev_kaynak    text,
  odev_detay     text,
  verilis_tarihi date,
  ogrenci_id     text,
  benzerlik      real
)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (o.odev_id)
    k.kaynak_id,
    k.kaynak_adi,
    o.odev_id,
    o.kaynak        as odev_kaynak,
    o.odev_detay,
    o.verilis_tarihi,
    o.ogrenci_id,
    similarity(lower(trim(o.kaynak)), lower(trim(k.kaynak_adi))) as benzerlik
  from public.odevler o
  join public.kaynaklar k
    on similarity(lower(trim(o.kaynak)), lower(trim(k.kaynak_adi))) >= greatest(p_esik, 0.1)
  where o.kaynak_id is null
    and coalesce(trim(o.kaynak), '') <> ''
  order by o.odev_id, benzerlik desc;
$$;

grant execute on function public.gecmis_odev_eslesme_adaylari(real)
  to authenticated, anon, service_role;
