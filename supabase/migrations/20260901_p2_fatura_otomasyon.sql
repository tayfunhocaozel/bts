-- ═══════════════════════════════════════════════════════════════════════════
-- P2 — Fatura otomasyonu
--
-- * ogretmenler.birim_fiyat (null => genel varsayılan 50) + indirim_orani
-- * adaptix_fatura_uret(p_donem): idempotent, öğretmen-bazlı fiyat/indirimle
--   fatura üretir (mevcut manuel mantığın aynısı, SECURITY DEFINER)
-- * pg_cron: her ayın 1'i 06:00 TR (03:00 UTC) otomatik çağrı
-- * Temmuz / Ağustos / Eylül 2026 eksik faturaları geriye dönük üretilir
-- * ödeme geri alma: admin-ops fatura_odeme_geri_al action'ında (kod tarafı)
-- * P0 ogretmenler yazma-koruma tetikleyicisine birim_fiyat/indirim_orani eklendi
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Öğretmen bazlı fiyatlandırma alanları ───────────────────────────────
alter table public.ogretmenler
  add column if not exists birim_fiyat numeric,
  add column if not exists indirim_orani numeric not null default 0;

alter table public.ogretmenler
  drop constraint if exists ogretmenler_indirim_orani_chk;
alter table public.ogretmenler
  add constraint ogretmenler_indirim_orani_chk
  check (indirim_orani >= 0 and indirim_orani < 1);

-- Faturada uygulanan indirimi kayıt altına al (toplam_tutar generated =
-- ogrenci_sayisi * birim_fiyat olduğundan, birim_fiyat'a indirimli birim yazılır)
alter table public.faturalar
  add column if not exists indirim_orani numeric not null default 0;

-- ── P0 yazma-koruma tetikleyicisine yeni kolonları ekle ────────────────
-- (öğretmen kendi satırında birim_fiyat/indirim_orani DEĞİŞTİREMESİN)
create or replace function public.ogretmenler_yazma_koruma()
returns trigger
language plpgsql
as $$
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
         new.brans, new.durum, new.kayit_tarihi,
         new.birim_fiyat, new.indirim_orani)
     is distinct from
     row(old.ogretmen_id, old.ad_soyad, old.email, old.telefon,
         old.brans, old.durum, old.kayit_tarihi,
         old.birim_fiyat, old.indirim_orani)
  then
    raise exception 'Bu alanlar yalnızca yönetim panelinden değiştirilebilir';
  end if;
  return new;
end;
$$;

-- ── Fatura üretim fonksiyonu (idempotent, öğretmen-bazlı fiyat) ─────────
create or replace function public.adaptix_fatura_uret(p_donem date default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_donem   date;
  v_genel   numeric := 50;   -- genel varsayılan birim fiyat
  v_eklenen int := 0;
  r         record;
  v_sayi    int;
  v_ind     numeric;
  v_birim   numeric;
begin
  v_donem := coalesce(
    p_donem,
    date_trunc('month', (now() at time zone 'Europe/Istanbul'))::date
  );

  for r in
    select o.ogretmen_id,
           coalesce(o.birim_fiyat, v_genel)     as liste_birim,
           coalesce(o.indirim_orani, 0)         as ind
    from public.ogretmenler o
    where o.durum = 'aktif'
      and not exists (
        select 1 from public.faturalar f
        where f.ogretmen_id = o.ogretmen_id and f.donem = v_donem
      )
  loop
    select count(*) into v_sayi
    from public.ogrenciler
    where ogretmen_id = r.ogretmen_id and kayit_durumu = 'AKTİF';

    v_ind   := least(greatest(coalesce(r.ind, 0), 0), 0.99);
    v_birim := round(r.liste_birim * (1 - v_ind));

    insert into public.faturalar
      (ogretmen_id, donem, ogrenci_sayisi, birim_fiyat, indirim_orani, durum)
    values
      (r.ogretmen_id, v_donem, v_sayi, v_birim, v_ind, 'bekleyen');

    v_eklenen := v_eklenen + 1;
  end loop;

  return jsonb_build_object('donem', v_donem, 'eklenen', v_eklenen);
end $$;

revoke all on function public.adaptix_fatura_uret(date) from anon, authenticated, public;

-- ── pg_cron: her ayın 1'i 03:00 UTC = 06:00 TR ───────────────────────
select cron.unschedule('aylik-fatura-uret')
where exists (select 1 from cron.job where jobname = 'aylik-fatura-uret');

select cron.schedule(
  'aylik-fatura-uret',
  '0 3 1 * *',
  $$ select public.adaptix_fatura_uret(); $$
);

-- ── Geriye dönük telafi: 2026 Temmuz / Ağustos / Eylül ──────────────────
select public.adaptix_fatura_uret('2026-07-01'::date);
select public.adaptix_fatura_uret('2026-08-01'::date);
select public.adaptix_fatura_uret('2026-09-01'::date);
