-- ═══════════════════════════════════════════════════════════════════════════
-- P0.5 — ROLLBACK: cutover'ı geri al, anon istemci tekrar çalışsın
--
-- Cutover sonrası canlıda bir şey ters giderse BUNU uygula. anon_full_access
-- politikalarını geri verir → eski (anon key'li) istemci anında yeniden çalışır.
-- Yeni auth_* politikaları yerinde kalır (zararsız; RLS OR mantığı).
--
-- Not: Bu, güvenlik açığını geri açar (P0 öncesi geniş erişim). Yalnızca acil
-- durum içindir; kök nedeni çözüp tekrar cutover yapılmalı.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array[
    'denemeler','ders_programi','dersler','konu_uyarilari','odevler',
    'odul_kataloglari','odul_talepleri','ogrenci_pet_aksesuarlari','ogrenciler',
    'ogretmen_pet_ayarlari','ogrn_kaynak','puan_hareketleri','rapor_ai_notlari',
    'veliler','yanlis_defteri','kaynaklar','kazanimlar',
    'pet_katalogu','pet_aksesuar_katalogu','kaynak_konulari','kaynak_cevap_anahtari'
  ]
  loop
    execute format('drop policy if exists anon_full_access on public.%I', t);
    execute format(
      'create policy anon_full_access on public.%I for all to anon using (true) with check (true)', t);
  end loop;
end $$;

-- P0 yardımcı anon politikaları (post-P0 durumuna dönüş)
drop policy if exists anon_select_ogretmenler on public.ogretmenler;
create policy anon_select_ogretmenler on public.ogretmenler for select to anon using (true);
drop policy if exists anon_update_ogretmenler on public.ogretmenler;
create policy anon_update_ogretmenler on public.ogretmenler for update to anon using (true) with check (true);

drop policy if exists anon_select_faturalar on public.faturalar;
create policy anon_select_faturalar on public.faturalar for select to anon using (true);

drop policy if exists anon_select_basvurular on public.basvurular;
create policy anon_select_basvurular on public.basvurular for select to anon using (true);
-- anon_insert_basvurular zaten yerinde.

-- kullanicilar: P0'da kapalı bırakıldı, rollback'te de kapalı kalır (parola hash'leri).
