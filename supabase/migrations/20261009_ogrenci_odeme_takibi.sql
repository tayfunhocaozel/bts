-- ═══════════════════════════════════════════════════════════════════════════
-- Öğrenci bazında ödeme (borç) takibi + ders ücreti — YALNIZ ÖĞRETMEN
--
-- * Ayrı tablo ogrenci_odeme_ayarlari: ogrenciler satırına konmadı çünkü öğrenci/
--   veli kendi ogrenciler satırını okuyabiliyor (auth-login da satırı döndürüyor);
--   bu tabloyu yalnız öğrencinin öğretmeni okur/yazar, öğrenci ve veli hiç göremez.
-- * Satır yoksa takip AÇIK sayılır → mevcut öğrencilerde davranış değişmez.
-- * ders_ucreti isteğe bağlı (₺/ders); şimdilik yalnız saklanır, tutar hesabı YOK.
-- * ders_odeme_bakiye: yalnız ödemesi takip edilen aktif öğrenciler → borç rozeti,
--   "Toplam Borçlu Ders" kartı ve borçlu listesi bunlara göre.
-- Geri alma: 20261009_ogrenci_odeme_takibi_rollback.sql
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.ogrenci_odeme_ayarlari (
  ogrenci_id   text primary key references public.ogrenciler(ogrenci_id)   on delete cascade,
  ogretmen_id  uuid not null    references public.ogretmenler(ogretmen_id) on delete cascade,
  odeme_takibi boolean not null default true,
  ders_ucreti  numeric(10,2) check (ders_ucreti is null or ders_ucreti >= 0),
  updated_at   timestamptz not null default now()
);

alter table public.ogrenci_odeme_ayarlari enable row level security;
revoke all on public.ogrenci_odeme_ayarlari from anon;
grant select, insert, update, delete on public.ogrenci_odeme_ayarlari to authenticated;

drop policy if exists auth_select on public.ogrenci_odeme_ayarlari;
create policy auth_select on public.ogrenci_odeme_ayarlari for select to authenticated
using (public.jwt_rol() = 'adaptix' or public.jwt_is_ogretmen_of(ogretmen_id));

-- Yazma: öğretmen yalnız KENDİ öğrencisi için (ogretmen_id öğrencinin öğretmeniyle aynı olmalı)
drop policy if exists auth_write on public.ogrenci_odeme_ayarlari;
create policy auth_write on public.ogrenci_odeme_ayarlari for all to authenticated
using (public.jwt_is_ogretmen_of(ogretmen_id))
with check (
  public.jwt_is_ogretmen_of(ogretmen_id)
  and exists (select 1 from public.ogrenciler o
              where o.ogrenci_id = ogrenci_odeme_ayarlari.ogrenci_id
                and o.ogretmen_id = ogrenci_odeme_ayarlari.ogretmen_id)
);

create or replace view public.ders_odeme_bakiye
with (security_invoker = true) as
select
  o.ogrenci_id,
  o.ogretmen_id,
  o.ad_soyad,
  coalesce(p.odenen, 0)                           as odenen_ders,
  coalesce(d.islenen, 0)                          as islenen_ders,
  coalesce(p.odenen, 0) - coalesce(d.islenen, 0)  as bakiye
from public.ogrenciler o
left join (
  select ogrenci_id, sum(ders_sayisi)::int as odenen
  from public.ders_odemeleri
  group by ogrenci_id
) p on p.ogrenci_id = o.ogrenci_id
left join (
  select ogrenci_id, count(distinct tarih)::int as islenen
  from public.dersler
  where ogrenci_id is not null
  group by ogrenci_id
) d on d.ogrenci_id = o.ogrenci_id
left join public.ogrenci_odeme_ayarlari a on a.ogrenci_id = o.ogrenci_id
where o.kayit_durumu = 'AKTİF' and coalesce(a.odeme_takibi, true);
