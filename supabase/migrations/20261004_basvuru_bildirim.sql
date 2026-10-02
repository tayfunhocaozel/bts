-- ─────────────────────────────────────────────────────────────────────────────
-- Yeni öğretmen başvurusu → yöneticiye e-posta bildirimi
--
-- Akış: basvurular INSERT → AFTER INSERT tetikleyicisi → pg_net ile
-- basvuru-bildirim Edge Function'ına yalnızca {id} gönderilir → function
-- basvuru_bildirim_talep() ile karar alır (tekrar / saatlik limit) → Resend.
--
-- Gizli anahtar BU DOSYADA YOK. Tetikleyici onu Vault'tan okur:
--   select vault.create_secret('<deger>', 'basvuru_webhook_secret', 'basvuru-bildirim webhook');
-- Aynı değer Edge Function secret'ı BASVURU_WEBHOOK_SECRET olarak da tanımlı olmalı.
--
-- Geri alma: 20261004_basvuru_bildirim_rollback.sql
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_net;

-- 1) Bildirim izi kolonları ───────────────────────────────────────────────────
alter table public.basvurular
  add column if not exists bildirim_durum text,
  add column if not exists bildirim_at timestamptz;

alter table public.basvurular
  drop constraint if exists basvurular_bildirim_durum_chk;
alter table public.basvurular
  add constraint basvurular_bildirim_durum_chk
  check (bildirim_durum is null
         or bildirim_durum in ('gonderiliyor','gonderildi','tekrar','limit','hata'));

-- 2) INSERT guard'ı genişlet (P1 davranışı aynen korunur) ──────────────────────
-- Ek olarak: anonim ekleme created_at'i geçmişe yazıp saatlik limiti atlatamaz,
-- bildirim kolonlarını önceden doldurup bildirimi bastıramaz.
create or replace function public.basvurular_insert_guard()
 returns trigger
 language plpgsql
as $function$
begin
  if current_user <> 'service_role' then
    new.provisioned := false;
    new.durum := 'bekliyor';
    new.created_at := now();
    new.bildirim_durum := null;
    new.bildirim_at := null;
  end if;
  return new;
end $function$;

-- 3) Karar fonksiyonu (yalnızca service_role) ─────────────────────────────────
-- Kurallar:
--   * aynı kayda ikinci kez mail yok
--   * aynı telefona (son 10 hane) son 24 saatte mail gittiyse → 'tekrar'
--   * son 1 saatte 5 gönderim denemesi olduysa → 'limit'
-- Advisory lock ile eşzamanlı başvurular sınırı birlikte aşamaz.
create or replace function public.basvuru_bildirim_talep(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  r          public.basvurular;
  v_tel      text;
  v_saatlik  int;
  c_limit    constant int := 5;
begin
  perform pg_advisory_xact_lock(hashtext('basvuru_bildirim'));

  select * into r from public.basvurular where id = p_id for update;
  if not found then
    return jsonb_build_object('karar', 'yok');
  end if;
  if r.bildirim_durum is not null then
    return jsonb_build_object('karar', 'zaten', 'durum', r.bildirim_durum);
  end if;

  v_tel := right(regexp_replace(coalesce(r.telefon, ''), '\D', '', 'g'), 10);
  if v_tel <> '' and exists (
    select 1 from public.basvurular b
    where b.id <> r.id
      and b.bildirim_durum in ('gonderiliyor','gonderildi','hata')
      and b.bildirim_at > now() - interval '24 hours'
      and right(regexp_replace(coalesce(b.telefon, ''), '\D', '', 'g'), 10) = v_tel
  ) then
    update public.basvurular set bildirim_durum = 'tekrar', bildirim_at = now() where id = p_id;
    return jsonb_build_object('karar', 'tekrar');
  end if;

  select count(*) into v_saatlik
  from public.basvurular
  where bildirim_durum in ('gonderiliyor','gonderildi','hata')
    and bildirim_at > now() - interval '1 hour';
  if v_saatlik >= c_limit then
    update public.basvurular set bildirim_durum = 'limit', bildirim_at = now() where id = p_id;
    return jsonb_build_object('karar', 'limit');
  end if;

  update public.basvurular set bildirim_durum = 'gonderiliyor', bildirim_at = now() where id = p_id;
  return jsonb_build_object(
    'karar',   'gonder',
    'son_hak', (v_saatlik + 1) >= c_limit,
    'basvuru', jsonb_build_object(
      'id', r.id, 'ad_soyad', r.ad_soyad, 'brans', r.brans,
      'telefon', r.telefon, 'mesaj', r.mesaj, 'created_at', r.created_at)
  );
end $function$;

revoke execute on function public.basvuru_bildirim_talep(uuid) from public, anon, authenticated;
grant  execute on function public.basvuru_bildirim_talep(uuid) to service_role;

-- 4) AFTER INSERT tetikleyicisi ───────────────────────────────────────────────
-- pg_net isteği transaction commit'inden sonra arka planda gönderir; mail
-- tarafındaki hiçbir hata başvuru kaydını engellemez. Tüm gövde exception
-- bloğunda: Vault okunamasa bile INSERT başarılı olur.
create or replace function public.basvurular_bildirim_tetik()
 returns trigger
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v_secret text;
begin
  begin
    select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'basvuru_webhook_secret'
    limit 1;

    if v_secret is null or v_secret = '' then
      raise warning 'basvuru_bildirim: Vault''ta basvuru_webhook_secret yok, bildirim atlanıyor (id=%)', new.id;
      return null;
    end if;

    perform net.http_post(
      url     := 'https://ldxeenczugcoirdrldjv.supabase.co/functions/v1/basvuru-bildirim',
      body    := jsonb_build_object('id', new.id),
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-webhook-secret', v_secret),
      timeout_milliseconds := 10000
    );
  exception when others then
    raise warning 'basvuru_bildirim tetik hatası (id=%): %', new.id, sqlerrm;
  end;
  return null;
end $function$;

revoke execute on function public.basvurular_bildirim_tetik() from public, anon, authenticated;

drop trigger if exists trg_basvurular_bildirim on public.basvurular;
create trigger trg_basvurular_bildirim
  after insert on public.basvurular
  for each row execute function public.basvurular_bildirim_tetik();
