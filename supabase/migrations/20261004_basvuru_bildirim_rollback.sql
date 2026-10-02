-- Geri alma: 20261004_basvuru_bildirim.sql
-- Guard fonksiyonu P1'deki haline birebir döner. pg_net uzantısı bırakılır
-- (zararsız; kaldırmak isterseniz: drop extension pg_net;).
-- Edge Function ayrıca silinmeli:  supabase functions delete basvuru-bildirim --project-ref ldxeenczugcoirdrldjv
-- Vault kaydı (isteğe bağlı):      delete from vault.secrets where name = 'basvuru_webhook_secret';

drop trigger if exists trg_basvurular_bildirim on public.basvurular;
drop function if exists public.basvurular_bildirim_tetik();
drop function if exists public.basvuru_bildirim_talep(uuid);

create or replace function public.basvurular_insert_guard()
 returns trigger
 language plpgsql
as $function$
begin
  if current_user <> 'service_role' then
    new.provisioned := false;
    new.durum := 'bekliyor';
  end if;
  return new;
end $function$;

alter table public.basvurular drop constraint if exists basvurular_bildirim_durum_chk;
alter table public.basvurular
  drop column if exists bildirim_durum,
  drop column if exists bildirim_at;
