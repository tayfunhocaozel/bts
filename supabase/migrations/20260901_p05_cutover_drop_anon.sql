-- ═══════════════════════════════════════════════════════════════════════════
-- P0.5 — CUTOVER: anon (ve blanket authenticated) politikalarını kaldır
--
-- YALNIZCA şu koşullar sağlandıktan sonra uygulanır:
--   1. 20260901_p05_authenticated_rls_additive.sql uygulanmış
--   2. auth-login v2 (JWT üretimi) deploy edilmiş
--   3. İstemci (scholar_metric.html + www/index.html) JWT'ye geçmiş ve CANLI
--   4. İzolasyon testleri geçmiş (iki öğretmen, öğrenci/veli, adaptix, süresi dolmuş JWT)
--
-- Geri dönüş: 20260901_p05_rollback_restore_anon.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── anon_full_access (TO anon) — uygulama tabloları ──────────────────────
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
  end loop;
end $$;

-- Not: "blanket authenticated_*" politikaları ve anon_all_yanlis_defteri
-- ADDITIF migration'da (20260901_p05_authenticated_rls_additive.sql) zaten
-- kaldırıldı — burada tekrar gerekmiyor.

-- ── P0'dan kalan anon yardımcı politikaları ─────────────────────────────
drop policy if exists anon_select_ogretmenler on public.ogretmenler;
drop policy if exists anon_update_ogretmenler on public.ogretmenler;
drop policy if exists anon_select_faturalar   on public.faturalar;
drop policy if exists anon_select_basvurular  on public.basvurular;
-- anon_insert_basvurular KALIR — landing sayfası başvuru formu anon key ile POST eder.

-- ── Not: kullanicilar zaten P0'da anon'a tamamen kapalı; dokunulmuyor.
