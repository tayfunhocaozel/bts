-- ═══════════════════════════════════════════════════════════════════════════
-- P0.5 — Öğrenci/Veli/Ders verisi izolasyonu (ADDITIF faz)
--
-- YALNIZCA yeni "authenticated" politikaları + yardımcılar EKLER. Mevcut
-- "anon_full_access" (TO anon) politikaları KALIR → canlı istemci (anon key)
-- hiç etkilenmez. Sıfır risk.
--
-- Sonraki adımlar:
--   cutover  : 20260901_p05_cutover_drop_anon.sql
--   rollback : 20260901_p05_rollback_restore_anon.sql
--
-- JWT claim'leri (auth-login üretir): rol / ogretmen_id / ogrenci_id / veli_id
--   ÖNEMLİ: öğrenci ve veli JWT'si de 'ogretmen_id' claim'i taşır (bağlı olduğu
--   öğretmen). Bu yüzden "öğretmen erişimi" daima `jwt_rol() = 'ogretmen'` ile
--   BİRLİKTE kontrol edilir; aksi halde öğrenci sınıf arkadaşlarının verisini görür.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Claim yardımcıları ───────────────────────────────────────────────────
create or replace function public.jwt_claims() returns jsonb
  language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true), '')::jsonb
  $$;
create or replace function public.jwt_rol() returns text
  language sql stable as $$ select public.jwt_claims() ->> 'rol' $$;
create or replace function public.jwt_ogretmen_id() returns uuid
  language sql stable as $$ select nullif(public.jwt_claims() ->> 'ogretmen_id', '')::uuid $$;
create or replace function public.jwt_ogrenci_id() returns text
  language sql stable as $$ select public.jwt_claims() ->> 'ogrenci_id' $$;
create or replace function public.jwt_veli_id() returns uuid
  language sql stable as $$ select nullif(public.jwt_claims() ->> 'veli_id', '')::uuid $$;

-- "bu öğretmen kendi verisi mi?" — öğrenci/veli claim'i de ogretmen_id taşıdığı için rol şart
create or replace function public.jwt_is_ogretmen_of(p_ogretmen_id uuid) returns boolean
  language sql stable as $$
    select public.jwt_rol() = 'ogretmen' and p_ogretmen_id = public.jwt_ogretmen_id()
  $$;

grant execute on function
  public.jwt_claims(), public.jwt_rol(), public.jwt_ogretmen_id(),
  public.jwt_ogrenci_id(), public.jwt_veli_id(), public.jwt_is_ogretmen_of(uuid)
  to anon, authenticated, service_role;

grant select, insert, update, delete on all tables in schema public to authenticated;

-- ── "blanket authenticated" politikalarını kaldır (izolasyonu deler; şu an
--     hiçbir istemci authenticated bağlanmıyor → güvenli) ──────────────────
drop policy if exists authenticated_konu_uyarilari           on public.konu_uyarilari;
drop policy if exists authenticated_odul_kataloglari         on public.odul_kataloglari;
drop policy if exists authenticated_odul_talepleri           on public.odul_talepleri;
drop policy if exists authenticated_ogrenci_pet_aksesuarlari on public.ogrenci_pet_aksesuarlari;
drop policy if exists authenticated_ogretmen_pet_ayarlari    on public.ogretmen_pet_ayarlari;
drop policy if exists authenticated_pet_aksesuar_katalogu    on public.pet_aksesuar_katalogu;
drop policy if exists authenticated_pet_katalogu             on public.pet_katalogu;
drop policy if exists authenticated_puan_hareketleri         on public.puan_hareketleri;

-- yanlis_defteri: politika TO anon,authenticated idi. anon erişimini koru.
drop policy if exists anon_all_yanlis_defteri on public.yanlis_defteri;
drop policy if exists anon_full_access        on public.yanlis_defteri;
create policy anon_full_access on public.yanlis_defteri
  for all to anon using (true) with check (true);

-- ═══ Grup A: ogretmen_id + ogrenci_id — öğretmen yazar, öğrenci/veli okur ═══
do $$
declare t text;
begin
  foreach t in array array[
    'dersler','konu_uyarilari','ders_programi',
    'ogrn_kaynak','rapor_ai_notlari','odul_talepleri'
  ]
  loop
    execute format($f$
      drop policy if exists auth_select on public.%1$I;
      create policy auth_select on public.%1$I for select to authenticated
      using (
        public.jwt_rol() = 'adaptix'
        or public.jwt_is_ogretmen_of(ogretmen_id)
        or ogrenci_id = public.jwt_ogrenci_id()
      );

      drop policy if exists auth_write on public.%1$I;
      create policy auth_write on public.%1$I for all to authenticated
      using      (public.jwt_is_ogretmen_of(ogretmen_id))
      with check (public.jwt_is_ogretmen_of(ogretmen_id));
    $f$, t);
  end loop;
end $$;

-- ═══ Grup A2: puan_hareketleri + denemeler — öğrenci KENDİ satırına yazabilir ═══
do $$
declare t text;
begin
  foreach t in array array['puan_hareketleri','denemeler']
  loop
    execute format($f$
      drop policy if exists auth_select on public.%1$I;
      create policy auth_select on public.%1$I for select to authenticated
      using (
        public.jwt_rol() = 'adaptix'
        or public.jwt_is_ogretmen_of(ogretmen_id)
        or ogrenci_id = public.jwt_ogrenci_id()
      );

      drop policy if exists auth_ogretmen_write on public.%1$I;
      create policy auth_ogretmen_write on public.%1$I for all to authenticated
      using      (public.jwt_is_ogretmen_of(ogretmen_id))
      with check (public.jwt_is_ogretmen_of(ogretmen_id));

      drop policy if exists auth_ogrenci_write on public.%1$I;
      create policy auth_ogrenci_write on public.%1$I for all to authenticated
      using      (public.jwt_rol() = 'ogrenci' and ogrenci_id = public.jwt_ogrenci_id())
      with check (public.jwt_rol() = 'ogrenci' and ogrenci_id = public.jwt_ogrenci_id());
    $f$, t);
  end loop;
end $$;

-- ═══ odevler ═══
drop policy if exists auth_select on public.odevler;
create policy auth_select on public.odevler for select to authenticated
using (
  public.jwt_rol() = 'adaptix'
  or public.jwt_is_ogretmen_of(ogretmen_id)
  or ogrenci_id = public.jwt_ogrenci_id()
);

drop policy if exists auth_ogretmen_write on public.odevler;
create policy auth_ogretmen_write on public.odevler for all to authenticated
using      (public.jwt_is_ogretmen_of(ogretmen_id))
with check (public.jwt_is_ogretmen_of(ogretmen_id));

drop policy if exists auth_ogrenci_update on public.odevler;
create policy auth_ogrenci_update on public.odevler for update to authenticated
using      (public.jwt_rol() = 'ogrenci' and ogrenci_id = public.jwt_ogrenci_id())
with check (public.jwt_rol() = 'ogrenci' and ogrenci_id = public.jwt_ogrenci_id());
-- kolon kısıtı: trg_odevler_ogrenci_kolon

-- ═══ ogrenciler ═══
drop policy if exists auth_select on public.ogrenciler;
create policy auth_select on public.ogrenciler for select to authenticated
using (
  public.jwt_rol() = 'adaptix'
  or public.jwt_is_ogretmen_of(ogretmen_id)
  or ogrenci_id = public.jwt_ogrenci_id()
);

drop policy if exists auth_ogretmen_write on public.ogrenciler;
create policy auth_ogretmen_write on public.ogrenciler for all to authenticated
using      (public.jwt_is_ogretmen_of(ogretmen_id))
with check (public.jwt_is_ogretmen_of(ogretmen_id));

drop policy if exists auth_ogrenci_update on public.ogrenciler;
create policy auth_ogrenci_update on public.ogrenciler for update to authenticated
using      (public.jwt_rol() = 'ogrenci' and ogrenci_id = public.jwt_ogrenci_id())
with check (public.jwt_rol() = 'ogrenci' and ogrenci_id = public.jwt_ogrenci_id());
-- kolon kısıtı: trg_ogrenciler_ogrenci_kolon

-- ═══ veliler ═══
drop policy if exists auth_select on public.veliler;
create policy auth_select on public.veliler for select to authenticated
using (
  public.jwt_rol() = 'adaptix'
  or ogrenci_id = public.jwt_ogrenci_id()
  or (public.jwt_rol() = 'veli' and veli_id = public.jwt_veli_id())
  or (public.jwt_rol() = 'ogretmen' and ogrenci_id in (
        select ogrenci_id from public.ogrenciler
        where ogretmen_id = public.jwt_ogretmen_id()))
);

drop policy if exists auth_write on public.veliler;
create policy auth_write on public.veliler for all to authenticated
using (
  public.jwt_rol() = 'ogretmen' and ogrenci_id in (
    select ogrenci_id from public.ogrenciler where ogretmen_id = public.jwt_ogretmen_id())
)
with check (
  public.jwt_rol() = 'ogretmen' and ogrenci_id in (
    select ogrenci_id from public.ogrenciler where ogretmen_id = public.jwt_ogretmen_id())
);

-- ═══ Grup B: yalnız ogrenci_id kolonu (öğretmen erişimi join ile) ═══
drop policy if exists auth_select on public.yanlis_defteri;
create policy auth_select on public.yanlis_defteri for select to authenticated
using (
  public.jwt_rol() = 'adaptix'
  or ogrenci_id = public.jwt_ogrenci_id()
  or (public.jwt_rol() = 'ogretmen' and ogrenci_id in (
        select ogrenci_id from public.ogrenciler
        where ogretmen_id = public.jwt_ogretmen_id()))
);

drop policy if exists auth_ogrenci_write on public.yanlis_defteri;
create policy auth_ogrenci_write on public.yanlis_defteri for all to authenticated
using      (public.jwt_rol() = 'ogrenci' and ogrenci_id = public.jwt_ogrenci_id())
with check (public.jwt_rol() = 'ogrenci' and ogrenci_id = public.jwt_ogrenci_id());

drop policy if exists auth_ogretmen_write on public.yanlis_defteri;
create policy auth_ogretmen_write on public.yanlis_defteri for all to authenticated
using (
  public.jwt_rol() = 'ogretmen' and ogrenci_id in (
    select ogrenci_id from public.ogrenciler where ogretmen_id = public.jwt_ogretmen_id())
)
with check (
  public.jwt_rol() = 'ogretmen' and ogrenci_id in (
    select ogrenci_id from public.ogrenciler where ogretmen_id = public.jwt_ogretmen_id())
);

drop policy if exists auth_select on public.ogrenci_pet_aksesuarlari;
create policy auth_select on public.ogrenci_pet_aksesuarlari for select to authenticated
using (
  public.jwt_rol() = 'adaptix'
  or ogrenci_id = public.jwt_ogrenci_id()
  or (public.jwt_rol() = 'ogretmen' and ogrenci_id in (
        select ogrenci_id from public.ogrenciler
        where ogretmen_id = public.jwt_ogretmen_id()))
);
-- yazımı yalnız pet_aksesuar_satin_al (SECURITY DEFINER) → yazma politikası yok.

-- ═══ Grup C: yalnız ogretmen_id kolonu ═══
drop policy if exists auth_select on public.faturalar;
create policy auth_select on public.faturalar for select to authenticated
using (public.jwt_rol() = 'adaptix' or public.jwt_is_ogretmen_of(ogretmen_id));

drop policy if exists auth_select on public.basvurular;
create policy auth_select on public.basvurular for select to authenticated
using (public.jwt_rol() = 'adaptix');

-- ogretmenler: öğretmen kendi satırı; öğrenci/veli de bağlı olduğu öğretmenin
-- satırını OKUYABİLİR (ogretmenBilgisiYukle) — tek satır, kasıtlı.
drop policy if exists auth_select on public.ogretmenler;
create policy auth_select on public.ogretmenler for select to authenticated
using (public.jwt_rol() = 'adaptix' or ogretmen_id = public.jwt_ogretmen_id());

drop policy if exists auth_update on public.ogretmenler;
create policy auth_update on public.ogretmenler for update to authenticated
using      (public.jwt_rol() = 'ogretmen' and ogretmen_id = public.jwt_ogretmen_id())
with check (public.jwt_rol() = 'ogretmen' and ogretmen_id = public.jwt_ogretmen_id());
-- kolon kısıtı: P0'daki trg_ogretmenler_yazma_koruma

-- ogretmen_pet_ayarlari: öğretmen + öğrenci (kendi öğretmeninin ayarını okur). WRITE öğretmen.
drop policy if exists auth_select on public.ogretmen_pet_ayarlari;
create policy auth_select on public.ogretmen_pet_ayarlari for select to authenticated
using (public.jwt_rol() = 'adaptix' or ogretmen_id = public.jwt_ogretmen_id());

drop policy if exists auth_write on public.ogretmen_pet_ayarlari;
create policy auth_write on public.ogretmen_pet_ayarlari for all to authenticated
using      (public.jwt_rol() = 'ogretmen' and ogretmen_id = public.jwt_ogretmen_id())
with check (public.jwt_rol() = 'ogretmen' and ogretmen_id = public.jwt_ogretmen_id());

-- odul_kataloglari: öğretmen + öğrenci (kendi öğretmeninin kataloğunu okur). WRITE öğretmen.
drop policy if exists auth_select on public.odul_kataloglari;
create policy auth_select on public.odul_kataloglari for select to authenticated
using (public.jwt_rol() = 'adaptix' or ogretmen_id = public.jwt_ogretmen_id());

drop policy if exists auth_write on public.odul_kataloglari;
create policy auth_write on public.odul_kataloglari for all to authenticated
using      (public.jwt_rol() = 'ogretmen' and ogretmen_id = public.jwt_ogretmen_id())
with check (public.jwt_rol() = 'ogretmen' and ogretmen_id = public.jwt_ogretmen_id());

-- ═══ Grup D: paylaşılan katalog / referans — tüm authenticated okur ═══
do $$
declare t text;
begin
  foreach t in array array[
    'kaynaklar','kazanimlar','kaynak_konulari','kaynak_cevap_anahtari',
    'pet_katalogu','pet_aksesuar_katalogu'
  ]
  loop
    execute format($f$
      drop policy if exists auth_select on public.%1$I;
      create policy auth_select on public.%1$I for select to authenticated using (true);
    $f$, t);
  end loop;
end $$;

-- kaynak tabloları global katalog (ogretmen_id yok) — öğretmen/adaptix yazar.
do $$
declare t text;
begin
  foreach t in array array['kaynaklar','kaynak_konulari','kaynak_cevap_anahtari']
  loop
    execute format($f$
      drop policy if exists auth_write on public.%1$I;
      create policy auth_write on public.%1$I for all to authenticated
      using      (public.jwt_rol() in ('ogretmen','adaptix'))
      with check (public.jwt_rol() in ('ogretmen','adaptix'));
    $f$, t);
  end loop;
end $$;

-- ═══ Kolon-kısıtı tetikleyicileri (yalnız authenticated + rol='ogrenci') ═══
-- anon (canlı istemci) hiç etkilenmez (current_user='anon').

create or replace function public.ogrenciler_ogrenci_kolon_koruma()
returns trigger language plpgsql as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  if coalesce(public.jwt_rol(),'') <> 'ogrenci' then return new; end if;
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

drop trigger if exists trg_ogrenciler_ogrenci_kolon on public.ogrenciler;
create trigger trg_ogrenciler_ogrenci_kolon
  before insert or update or delete on public.ogrenciler
  for each row execute function public.ogrenciler_ogrenci_kolon_koruma();

create or replace function public.odevler_ogrenci_kolon_koruma()
returns trigger language plpgsql as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  if coalesce(public.jwt_rol(),'') <> 'ogrenci' then return new; end if;
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

drop trigger if exists trg_odevler_ogrenci_kolon on public.odevler;
create trigger trg_odevler_ogrenci_kolon
  before insert or update or delete on public.odevler
  for each row execute function public.odevler_ogrenci_kolon_koruma();
