-- ═══════════════════════════════════════════════════════════════════════════
-- V6 — Ders Ödeme Takip Modülü (öğretmen ↔ veli, ders ADEDİ bazlı, tutar YOK)
--
-- * ders_odemeleri: veli ödemelerini ders adedi olarak tutar (₺ takibi yok)
-- * ders_odeme_bakiye (view, security_invoker): öğrenci başına
--     bakiye = SUM(ders_odemeleri.ders_sayisi) - COUNT(DISTINCT dersler.tarih)
--     negatif => borçlu | 0 => güncel | pozitif => peşin
-- * RLS: öğretmen yalnız kendi kayıtları (jwt_is_ogretmen_of); adaptix okur
-- * Aylık faturalar (öğretmen-AdaptiX) modülünden TAMAMEN bağımsız
-- * NOT: spec'teki `not` kolonu SQL/PostgREST rezerve kelimesi olduğundan
--   `aciklama` olarak adlandırıldı (bilinçli sapma)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.ders_odemeleri (
  id          uuid primary key default gen_random_uuid(),
  ogrenci_id  text not null references public.ogrenciler(ogrenci_id)   on delete cascade,
  ogretmen_id uuid not null references public.ogretmenler(ogretmen_id) on delete cascade,
  tarih       date not null default (now() at time zone 'Europe/Istanbul')::date,
  ders_sayisi integer not null check (ders_sayisi > 0),
  aciklama    text,
  created_at  timestamptz not null default now()
);

create index if not exists ders_odemeleri_ogrenci_idx  on public.ders_odemeleri(ogrenci_id);
create index if not exists ders_odemeleri_ogretmen_idx on public.ders_odemeleri(ogretmen_id);

alter table public.ders_odemeleri enable row level security;

grant select, insert, update, delete on public.ders_odemeleri to authenticated;

drop policy if exists auth_select on public.ders_odemeleri;
create policy auth_select on public.ders_odemeleri for select to authenticated
using (public.jwt_rol() = 'adaptix' or public.jwt_is_ogretmen_of(ogretmen_id));

drop policy if exists auth_write on public.ders_odemeleri;
create policy auth_write on public.ders_odemeleri for all to authenticated
using      (public.jwt_is_ogretmen_of(ogretmen_id))
with check (public.jwt_is_ogretmen_of(ogretmen_id));

-- ── Bakiye görünümü (anlık hesap, ayrı "bakiye" kolonu tutulmaz) ───────────
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
where o.kayit_durumu = 'AKTİF';

grant select on public.ders_odeme_bakiye to authenticated;

-- ── Açılış devri: her aktif öğrenciye o ana kadar işlenmiş DISTINCT ders
--    sayısı kadar tek seferlik kredi → bakiye herkes için 0'dan başlar
--    (spec: "geçmiş borçlar sıfırdan başlar")
insert into public.ders_odemeleri (ogrenci_id, ogretmen_id, tarih, ders_sayisi, aciklama)
select o.ogrenci_id, o.ogretmen_id,
       (now() at time zone 'Europe/Istanbul')::date,
       d.islenen, 'Açılış devri (V6 kurulumu)'
from public.ogrenciler o
join (
  select ogrenci_id, count(distinct tarih)::int as islenen
  from public.dersler where ogrenci_id is not null group by ogrenci_id
) d on d.ogrenci_id = o.ogrenci_id
where o.kayit_durumu = 'AKTİF' and d.islenen > 0;
