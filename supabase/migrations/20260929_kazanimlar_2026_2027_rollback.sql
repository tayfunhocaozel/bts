-- 20260929_kazanimlar_2026_2027.sql geri alma: kazanimlar tablosunu arşivden geri yükler.
-- yanlis_defteri kod düzeltmesi (sona nokta) geri alınmaz; zararsızdır.

BEGIN;
DELETE FROM public.kazanimlar;
INSERT INTO public.kazanimlar (sinif, unite, konu, kazanim_kodu, kazanim_aciklamasi, ders)
  SELECT sinif, unite, konu, kazanim_kodu, kazanim_aciklamasi, ders FROM public.kazanimlar_arsiv_2025_2026;
ALTER TABLE public.kazanimlar DROP COLUMN IF EXISTS sira;
COMMIT;
