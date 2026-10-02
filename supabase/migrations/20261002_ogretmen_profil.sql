-- ═══════════════════════════════════════════════════════════════════════════
-- Öğretmen Profilim — logo / profil fotoğrafı + self-servis profil alanları
--
-- * ogretmenler.logo_url, ogretmenler.foto_url (yalnız EKLEME, mevcut kolonlar aynı)
-- * ogretmenler_yazma_koruma: yasak listesinden BEYAZ LİSTEYE çevrildi.
--   Öğretmen (authenticated) yalnız izinli kolonları değiştirir; listede olmayan
--   her kolon — ileride eklenecekler dahil — yalnız service_role (admin-ops) ile.
--   ad_soyad / email / telefon / logo_url / foto_url için biçim doğrulaması.
-- * Bucket ogretmen-profil: public okuma (PDF/html2canvas kalıcı URL ister),
--   sunucu tarafında 2MB + PNG/JPG sınırı. Yazma/silme/listeleme yalnız
--   öğretmenin kendi <ogretmen_id>/ klasöründe (custom JWT claim'leri).
--   UPDATE politikası bilerek yok: her yükleme yeni dosya adı alır.
-- Geri alma: 20261002_ogretmen_profil_rollback.sql
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.ogretmenler
  add column if not exists logo_url text,
  add column if not exists foto_url text;

create or replace function public.ogretmenler_yazma_koruma()
returns trigger language plpgsql as $$
declare
  -- Öğretmenin kendi değiştirebileceği kolonlar (beyaz liste). Listede olmayan
  -- her kolon — ileride eklenecekler dahil — yalnızca yönetim panelinden değişir.
  izinli constant text[] := array['odul_dukkani_aktif','deneme_puan_carpani',
                                  'ad_soyad','telefon','email','logo_url','foto_url'];
  onek text;
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
  if (to_jsonb(new) - izinli) is distinct from (to_jsonb(old) - izinli) then
    raise exception 'Bu alanlar yalnızca yönetim panelinden değiştirilebilir';
  end if;

  if new.ad_soyad is distinct from old.ad_soyad
     and (new.ad_soyad is null or length(btrim(new.ad_soyad)) not between 3 and 100) then
    raise exception 'Ad soyad 3-100 karakter olmalı';
  end if;
  if new.email is distinct from old.email and new.email is not null
     and new.email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'E-posta adresi geçersiz';
  end if;
  if new.telefon is distinct from old.telefon and new.telefon is not null
     and regexp_replace(new.telefon, '\D', '', 'g') !~ '^\d{10,13}$' then
    raise exception 'Telefon numarası geçersiz';
  end if;

  -- Logo/foto yalnızca öğretmenin kendi depolama klasörünü gösterebilir; dosya adı
  -- yalnız güvenli karakter (adres HTML niteliğine yazıldığı için tırnak vb. giremez)
  onek := 'https://ldxeenczugcoirdrldjv.supabase.co/storage/v1/object/public/ogretmen-profil/'
          || new.ogretmen_id || '/';
  if new.logo_url is distinct from old.logo_url and new.logo_url is not null
     and (left(new.logo_url, length(onek)) <> onek
          or substr(new.logo_url, length(onek) + 1) !~ '^[A-Za-z0-9._-]+$') then
    raise exception 'Logo adresi geçersiz';
  end if;
  if new.foto_url is distinct from old.foto_url and new.foto_url is not null
     and (left(new.foto_url, length(onek)) <> onek
          or substr(new.foto_url, length(onek) + 1) !~ '^[A-Za-z0-9._-]+$') then
    raise exception 'Fotoğraf adresi geçersiz';
  end if;
  return new;
end $$;

-- Bucket: herkese açık okuma, sunucu tarafında 2MB + PNG/JPG sınırı
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ogretmen-profil', 'ogretmen-profil', true, 2097152, array['image/png','image/jpeg'])
on conflict (id) do nothing;

-- Yazma/silme/listeleme yalnızca öğretmenin kendi klasöründe
drop policy if exists ogretmen_profil_select on storage.objects;
create policy ogretmen_profil_select on storage.objects for select to authenticated
  using (bucket_id = 'ogretmen-profil' and public.jwt_rol() = 'ogretmen'
         and (storage.foldername(name))[1] = public.jwt_ogretmen_id()::text);

drop policy if exists ogretmen_profil_insert on storage.objects;
create policy ogretmen_profil_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'ogretmen-profil' and public.jwt_rol() = 'ogretmen'
              and (storage.foldername(name))[1] = public.jwt_ogretmen_id()::text);

drop policy if exists ogretmen_profil_delete on storage.objects;
create policy ogretmen_profil_delete on storage.objects for delete to authenticated
  using (bucket_id = 'ogretmen-profil' and public.jwt_rol() = 'ogretmen'
         and (storage.foldername(name))[1] = public.jwt_ogretmen_id()::text);
-- UPDATE kuralı bilerek yok: her yüklemede yeni dosya adı, var olanın üzerine yazılmaz.
