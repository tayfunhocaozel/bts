-- Geri alma: 20261005_ai_uyelik.sql
-- DİKKAT: ai_kullanim ve ai_talepleri içindeki tüm kayıtlar silinir.
-- Önce edge function'ları üyelik kapısı OLMAYAN sürüme (1A) döndürün; aksi halde
-- ai_kapi_durumu bulunamadığı için tüm AI çağrıları 503 ile reddedilir.

drop function if exists public.ai_kapi_durumu(uuid, text);
drop table if exists public.ai_talepleri;
drop table if exists public.ai_kullanim;

alter table public.ogretmenler drop constraint if exists ogretmenler_ai_kota_chk;
alter table public.ogretmenler
  drop column if exists ai_aktif,
  drop column if exists ai_aylik_kota_token,
  drop column if exists ai_bitis;
