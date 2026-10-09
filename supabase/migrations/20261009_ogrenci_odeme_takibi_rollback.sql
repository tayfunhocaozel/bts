-- 20261009_ogrenci_odeme_takibi.sql geri alma: bakiye görünümü yeniden tüm aktif
-- öğrencileri kapsar. ogrenci_odeme_ayarlari tablosu en sonda, isteğe bağlı silinir
-- (takip/ücret bilgisi kaybolur!).

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

-- İsteğe bağlı (veri kaybı): tabloyu da kaldırmak için açın.
-- drop table if exists public.ogrenci_odeme_ayarlari;
