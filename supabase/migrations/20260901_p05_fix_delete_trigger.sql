-- ═══════════════════════════════════════════════════════════════════════════
-- P0.5 FIX — ogrenciler/odevler kolon-koruma tetikleyicileri BEFORE DELETE'te
-- `return new` (NULL) döndürüp SİLMEYİ İPTAL ediyordu. Bu, öğretmenin öğrenci/
-- ödev silmesini (ve service_role cascade'lerini) tamamen bloke ediyordu.
-- Düzeltme: DELETE'te `return old`; öğrenci rolü zaten insert/delete yapamaz.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.ogrenciler_ogrenci_kolon_koruma()
returns trigger language plpgsql as $$
begin
  -- Yalnızca authenticated + rol='ogrenci' kısıtlanır; diğer her rol serbest.
  if current_user <> 'authenticated'
     or coalesce(public.jwt_rol(), '') <> 'ogrenci' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- authenticated öğrenci:
  if tg_op <> 'UPDATE' then
    raise exception 'Öğrenci kendi kaydını ekleyemez veya silemez';
  end if;
  if row(new.ogrenci_id, new.ad_soyad, new.sinif, new.sube, new.okul, new.tc_no,
         new.okul_no, new.veli_ad_soyad, new.veli_telefon, new.kayit_durumu,
         new.ogretmen_id, new.pet_puan, new.ekstra_mama_hakki, new.cinsiyet)
     is distinct from
     row(old.ogrenci_id, old.ad_soyad, old.sinif, old.sube, old.okul, old.tc_no,
         old.okul_no, old.veli_ad_soyad, old.veli_telefon, old.kayit_durumu,
         old.ogretmen_id, old.pet_puan, old.ekstra_mama_hakki, old.cinsiyet)
  then
    raise exception 'Öğrenci yalnızca hedef ve evcil hayvan alanlarını değiştirebilir';
  end if;
  return new;
end $$;

create or replace function public.odevler_ogrenci_kolon_koruma()
returns trigger language plpgsql as $$
begin
  if current_user <> 'authenticated'
     or coalesce(public.jwt_rol(), '') <> 'ogrenci' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op <> 'UPDATE' then
    raise exception 'Öğrenci ödev ekleyemez veya silemez';
  end if;
  if row(new.odev_id, new.verilis_tarihi, new.ogrenci_id, new.gun, new.kaynak,
         new.konu, new.kazanim, new.odev_detay, new.ogretmen_id, new.kaynak_id,
         new.kaynak_konu_id, new.test_no, new.sayfa_baslangic, new.sayfa_bitis)
     is distinct from
     row(old.odev_id, old.verilis_tarihi, old.ogrenci_id, old.gun, old.kaynak,
         old.konu, old.kazanim, old.odev_detay, old.ogretmen_id, old.kaynak_id,
         old.kaynak_konu_id, old.test_no, old.sayfa_baslangic, old.sayfa_bitis)
  then
    raise exception 'Öğrenci yalnızca ödev sonucunu (durum/dogru/yanlis/bos/toplam) girebilir';
  end if;
  return new;
end $$;
