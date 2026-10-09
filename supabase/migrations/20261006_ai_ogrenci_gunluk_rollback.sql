-- Geri alma: 20261006_ai_ogrenci_gunluk.sql
-- ai_kapi_durumu 20261005_ai_uyelik'teki haline döner ('ogrenci_bugun' alanı kalkar;
-- edge function bu alan yoksa günlük limiti uygulamaz). İndeks kaldırılır.

drop index if exists public.ai_kullanim_ogrenci_tarih_idx;

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
