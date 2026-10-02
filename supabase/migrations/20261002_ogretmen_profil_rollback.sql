-- 20261002_ogretmen_profil.sql geri alma: koruma tetikleyicisini eski (yasak listesi)
-- hâline döndürür, depolama politikalarını ve boşsa bucket'ı kaldırır.
-- logo_url / foto_url kolonları en sonda, isteğe bağlı olarak silinir (veri kaybı!).

create or replace function public.ogretmenler_yazma_koruma()
returns trigger language plpgsql as $$
begin
  if current_user not in ('anon', 'authenticated') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'Öğretmen kaydı yalnızca yönetim panelinden eklenebilir';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Öğretmen kaydı yalnızca yönetim panelinden silinebilir';
  end if;
  if row(new.ogretmen_id, new.ad_soyad, new.email, new.telefon,
         new.brans, new.durum, new.kayit_tarihi, new.birim_fiyat, new.indirim_orani)
     is distinct from
     row(old.ogretmen_id, old.ad_soyad, old.email, old.telefon,
         old.brans, old.durum, old.kayit_tarihi, old.birim_fiyat, old.indirim_orani)
  then
    raise exception 'Bu alanlar yalnızca yönetim panelinden değiştirilebilir';
  end if;
  return new;
end $$;

drop policy if exists ogretmen_profil_select on storage.objects;
drop policy if exists ogretmen_profil_insert on storage.objects;
drop policy if exists ogretmen_profil_delete on storage.objects;

-- Bucket içi dosyalar Storage API (panel) ile silinmeli; boşsa bucket kaldırılır.
delete from storage.buckets
 where id = 'ogretmen-profil'
   and not exists (select 1 from storage.objects where bucket_id = 'ogretmen-profil');

-- İsteğe bağlı (veri kaybı): logo/foto adreslerini de kaldırmak için açın.
-- alter table public.ogretmenler drop column if exists logo_url, drop column if exists foto_url;
