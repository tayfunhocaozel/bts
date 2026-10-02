-- Ödevde seçilen alt kazanımlar (ör. {M.7.2.1.A, M.7.2.1.C}).
-- Ödev yine tek kazanıma bağlı (odevler.kazanim); bu kolon o kazanımın hangi alt kazanımlarını kapsadığını tutar.
-- Geri almak için: ALTER TABLE public.odevler DROP COLUMN IF EXISTS alt_kazanim_kodlari;

ALTER TABLE public.odevler ADD COLUMN IF NOT EXISTS alt_kazanim_kodlari text[];
