-- ═══════════════════════════════════════════════════════════════════════════
-- P0 GÜVENLİK SERTLEŞTİRMESI
--
-- 1) kullanicilar tablosunu anon'a tamamen kapat (parola hash'leri açıktaydı)
-- 2) ogretmenler / faturalar / basvurular üzerinde anon yazımını kısıtla
--    (SELECT ve — gereken yerde — INSERT kalır; UPDATE/DELETE kapanır)
-- 3) ogretmenler: öğretmenin kendi ayarı olan 2 kolon dışındaki her alan
--    değişikliğini tarayıcıdan engelleyen tetikleyici
-- 4) adaptix_ogretmen_sil(): öğretmen + tüm bağlı verileri tek transaction'da
--    silen RPC (eski istemci akışı transaction'sızdı ve eksik tabloları atlıyordu)
--
-- Bu migration UYGULANMADAN ÖNCE auth-login + admin-ops edge function'ları
-- deploy edilmiş ve istemci bunları çağıracak şekilde güncellenmiş olmalıdır;
-- aksi halde giriş ve panel yazma işlemleri kırılır.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) kullanicilar: anon'a tamamen kapalı ────────────────────────────────
drop policy if exists anon_full_access    on public.kullanicilar;
drop policy if exists anon_giris_kontrolu on public.kullanicilar;
-- RLS açık kalır; politika kalmadığı için anon/authenticated hiçbir şey yapamaz.
-- service_role (edge function) RLS'i bypass ettiği için erişmeye devam eder.

-- ── 2) ogretmenler: yaz kısıtı ────────────────────────────────────────────
drop policy if exists anon_full_access on public.ogretmenler;

create policy anon_select_ogretmenler on public.ogretmenler
  for select to anon using (true);

-- UPDATE RLS düzeyinde açık; kolon kısıtı aşağıdaki tetikleyici ile.
create policy anon_update_ogretmenler on public.ogretmenler
  for update to anon using (true) with check (true);
-- INSERT / DELETE için anon politikası YOK → RLS bunları zaten engeller.

create or replace function public.ogretmenler_yazma_koruma()
returns trigger
language plpgsql
as $$
begin
  -- Tarayıcıya açık roller dışındaki her şey (service_role, postgres, ...) serbest
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

  -- UPDATE: yalnızca odul_dukkani_aktif ve deneme_puan_carpani değişebilir
  if row(new.ogretmen_id, new.ad_soyad, new.email, new.telefon,
         new.brans, new.durum, new.kayit_tarihi)
     is distinct from
     row(old.ogretmen_id, old.ad_soyad, old.email, old.telefon,
         old.brans, old.durum, old.kayit_tarihi)
  then
    raise exception 'Bu alanlar yalnızca yönetim panelinden değiştirilebilir';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_ogretmenler_yazma_koruma on public.ogretmenler;
create trigger trg_ogretmenler_yazma_koruma
  before insert or update or delete on public.ogretmenler
  for each row execute function public.ogretmenler_yazma_koruma();

-- ── 3) faturalar: yalnızca okuma ──────────────────────────────────────────
drop policy if exists anon_full_access on public.faturalar;
create policy anon_select_faturalar on public.faturalar
  for select to anon using (true);
-- yazımın tamamı admin-ops (service_role) üzerinden.

-- ── 4) basvurular: okuma + herkese açık başvuru formu (INSERT) ────────────
drop policy if exists anon_full_access on public.basvurular;
create policy anon_select_basvurular on public.basvurular
  for select to anon using (true);
create policy anon_insert_basvurular on public.basvurular
  for insert to anon with check (true);
-- UPDATE/DELETE (durum değiştirme) yalnızca admin-ops (service_role) üzerinden.

-- ── 5) Öğretmen sil — tek transaction, tüm bağlı veriler ─────────────────
create or replace function public.adaptix_ogretmen_sil(p_ogretmen_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ogr_ids text[];
begin
  if p_ogretmen_id = 'b373a4e6-01b1-4131-99d4-a2deae98b1ea'::uuid then
    raise exception 'Ana öğretmen silinemez';
  end if;

  select array_agg(ogrenci_id) into v_ogr_ids
  from ogrenciler where ogretmen_id = p_ogretmen_id;

  if v_ogr_ids is not null and array_length(v_ogr_ids, 1) > 0 then
    delete from odul_talepleri            where ogrenci_id = any(v_ogr_ids);
    delete from puan_hareketleri          where ogrenci_id = any(v_ogr_ids);
    delete from rapor_ai_notlari          where ogrenci_id = any(v_ogr_ids);
    delete from ogrenci_pet_aksesuarlari  where ogrenci_id = any(v_ogr_ids);
    delete from yanlis_defteri            where ogrenci_id = any(v_ogr_ids);
    delete from ders_programi             where ogrenci_id = any(v_ogr_ids);
    delete from ogrn_kaynak               where ogrenci_id = any(v_ogr_ids);
    delete from konu_uyarilari            where ogrenci_id = any(v_ogr_ids);
    delete from denemeler                 where ogrenci_id = any(v_ogr_ids);
    delete from odevler                   where ogrenci_id = any(v_ogr_ids);
    delete from dersler                   where ogrenci_id = any(v_ogr_ids);
    delete from veliler                   where ogrenci_id = any(v_ogr_ids);
    delete from ogrenciler                where ogrenci_id = any(v_ogr_ids);
  end if;

  delete from kullanicilar          where deger = p_ogretmen_id::text;
  delete from faturalar             where ogretmen_id = p_ogretmen_id;
  delete from ogretmen_pet_ayarlari where ogretmen_id = p_ogretmen_id;
  delete from ogretmenler           where ogretmen_id = p_ogretmen_id;
end;
$$;

revoke all on function public.adaptix_ogretmen_sil(uuid) from anon, authenticated, public;
