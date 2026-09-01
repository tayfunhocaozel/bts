-- ═══════════════════════════════════════════════════════════════════════════
-- P1 — Başvuru → Öğretmen tek tık akışı
--
-- * basvurular.provisioned: başvurunun öğretmene dönüştürülüp dönüştürülmediği
-- * adaptix_basvuru_onayla(): tek transaction'da ogretmenler + kullanicilar
--   kaydı oluşturur, başvuruyu onaylandı+provisioned yapar (idempotent)
-- * basvurular INSERT guard: herkese açık başvuru formundan gelen kayıtlarda
--   provisioned=false ve durum='bekliyor' zorlanır (spoofing önlemi)
--
-- NOT: mevcut "onaylandı" başvurulardan öğretmen kaydı OLANLAR provisioned=true
-- işaretlenir (durum düzeltmesi, yeni öğretmen oluşturmaz). Öğretmen kaydı
-- OLMAYAN yetimler (Döndü polat, Veli Türkoğlu) provisioned=false kalır →
-- panelde "Dikkat" listesinde görünür, admin tek tıkla oluşturur.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.basvurular
  add column if not exists provisioned boolean not null default false;

-- Zaten öğretmene dönüşmüş onaylı başvuruları işaretle (isim eşleşmesiyle).
update public.basvurular b
set provisioned = true
where b.durum = 'onaylandi'
  and b.provisioned = false
  and exists (
    select 1 from public.ogretmenler o
    where lower(trim(o.ad_soyad)) = lower(trim(b.ad_soyad))
  );

-- ── Başvuru INSERT guard (public form) ─────────────────────────────────
create or replace function public.basvurular_insert_guard()
returns trigger language plpgsql as $$
begin
  if current_user <> 'service_role' then
    new.provisioned := false;
    new.durum := 'bekliyor';
  end if;
  return new;
end $$;

drop trigger if exists trg_basvurular_insert_guard on public.basvurular;
create trigger trg_basvurular_insert_guard
  before insert on public.basvurular
  for each row execute function public.basvurular_insert_guard();

-- ── Onayla RPC — tek transaction ──────────────────────────────────────
create or replace function public.adaptix_basvuru_onayla(p_basvuru_id uuid, p_sifre_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.basvurular%rowtype;
  v_ogr uuid;
begin
  select * into b from public.basvurular where id = p_basvuru_id;
  if not found then
    raise exception 'Başvuru bulunamadı';
  end if;
  if b.provisioned then
    return jsonb_build_object('already', true);
  end if;

  insert into public.ogretmenler (ad_soyad, telefon, brans, durum)
  values (
    nullif(trim(coalesce(b.ad_soyad, '')), ''),
    nullif(trim(coalesce(b.telefon, '')), ''),
    coalesce(nullif(trim(coalesce(b.brans, '')), ''), 'İlköğretim Matematik'),
    'aktif'
  )
  returning ogretmen_id into v_ogr;

  insert into public.kullanicilar (rol, sifre_hash, deger)
  values ('ogretmen', p_sifre_hash, v_ogr::text);

  update public.basvurular
  set durum = 'onaylandi', provisioned = true
  where id = p_basvuru_id;

  return jsonb_build_object('ogretmen_id', v_ogr);
end $$;

revoke all on function public.adaptix_basvuru_onayla(uuid, text) from anon, authenticated, public;
