-- 20261002_kazanimlar_liste.sql geri alma: kazanimlar tablosunu o migration öncesi hâline döndürür.

-- (sira kolonu kalır; arşivde sira yoksa geri yüklenen satırlarda boş olur, sıralama eski usule döner)

BEGIN;
DELETE FROM public.kazanimlar;
INSERT INTO public.kazanimlar (sinif, unite, konu, kazanim_kodu, kazanim_aciklamasi, ders)
  SELECT sinif, unite, konu, kazanim_kodu, kazanim_aciklamasi, ders FROM public.kazanimlar_arsiv_20261002;
COMMIT;
