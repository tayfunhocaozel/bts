-- ═══════════════════════════════════════════════════════════════════════════
-- V4 Bölüm 10 — Kazanım haritasıyla konu eşleştirme
--
-- Ham OCR/Excel çıktısı kaynak_konulari.konu_adi'de kalır (denetim için).
-- Eşleştirilen kanonik kazanım-konu adı ayrı kolonda tutulur; biri diğerinin
-- üzerine yazılmaz. Eşleşme bulunamazsa NULL (öğretmene zorunlu seçim yok).
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.kaynak_konulari
  add column if not exists kazanim_konu_adi text;
