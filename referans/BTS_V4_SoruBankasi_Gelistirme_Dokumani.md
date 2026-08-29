# AdaptiX BTS V4 — Geliştirme Dokümanı: Soru Bankası (Yanlış Defteri)

**Hazırlanma Tarihi:** 21 Ağustos 2026
**Sürüm:** BTS V3 → V4
**Geliştirici:** Tayfun Hoca + Claude
**İlgili Dosyalar:** `scholar_metric.html`, `www/index.html`
**Hedef Kitle:** Ortaokul 5, 6, 7, 8. sınıf öğrencileri

---

> **GÜNCELLEME (29 Ağustos 2026) — Modül uygulandı (MVP).**
>
> - **DB:** `yanlis_defteri` tablosu + `soru-fotograflari` **public** bucket (`{ogrenci_id}/{soru_id}.jpg`) oluşturuldu. `odev_id` **TEXT** (§2.1'deki UUID hatası düzeltildi). RLS: anon+authenticated tam erişim (projenin mevcut deseni; gerçek izolasyon Supabase Auth migrasyonuna kalıyor — §6/§7.1 rol kısıtlamaları şimdilik yalnızca istemci tarafında).
> - **Depolama modeli:** Private + signed URL yerine **public bucket + tahmin edilemez UUID yol** seçildi (uygulama anon key ile çalıştığı için private ekstra karmaşıklık, gerçek koruma getirmiyor).
> - **Edge function:** `soru-analiz` (v1, ACTIVE) — `kaynak-ocr` deseni, `gemini-3.6-flash` + `responseSchema`. Foto + kazanım listesi → `{ders, konu, kazanim_kodu, ai_guven_skoru, ipucu, dogru_cevap}`. Liste dışı kazanım kodu ve geçersiz şık sunucuda temizlenir. §8-S1'in cevabı: gemini-3.6-flash.
> - **Onay akışı:** `ai_guven_skoru >= 0.8` → otomatik `ogretmen_onayladi`; altı → `ai_tamamlandi` ("🤖 AI önerisi — öğretmen onayı bekliyor" rozeti) ama öğrenciye yine de görünür. AI hatası → `hata`, soru yine eklenir, konu boş kalır (§8-S3).
> - **Günlük limit:** eklenmedi (§8-S2 → limitsiz).
> - **Öğrenci arayüzü:** Sol menüde **"📸 Soru Bankam"** (öğrenci paneli sol menüye taşındığı için sekme çubuğuna değil sol menüye eklendi — §1 yerleşimi bu yönde güncel). Foto ekle → yükleme → AI analizi → kart listesi, konu filtre çipleri, "İpucunu göster" (varsayılan gizli), "🔁 Tekrar Ettim" (`tekrar_sayisi` / `son_tekrar_tarihi`).
> - **Öğretmen arayüzü:** (a) Sol menüde **"Soru Bankası"** sayfası — tüm öğrencilerin kayıtları, "Onay Bekleyen / Tümü" filtresi, kartta öğrenci adı. (b) Rapor sayfasında `#rapor-soru-bankasi` bölümü — o öğrencinin kayıtları, kronik rozeti (aynı konuda 5+ soru). Her iki görünüm ortak kart (`raporSoruKartHTML`) ve **Düzelt & Kaydet / Onayla / Sil** aksiyonlarını kullanır.
> - Görsel sıkıştırma mevcut `kkmResimSikistir` (1600px / JPEG 0.85) ile ortak; **EXIF orientation düzeltmesi eklenmedi** (sonraki iyileştirme).
> - **Kırpma adımı** (631b018): fotoğraf seçildikten sonra `#soru-crop-modal` — köşe tutamaçlı çerçeve (pointer events, dokunmatik+fare) ile öğrenci yalnızca soruyu bırakacak şekilde kırpar; "Kırpma" ile tam foto da eklenebilir. Kırpılan bölge doğal çözünürlükte canvas'a çizilip sıkıştırma/analiz akışına girer (`soruFotoSecildi → soruCropAc → soruCropUygula → soruYukleVeAnaliz`).
> - **V4.1 (PDF/test oluşturma) — eklendi:** Öğretmen "Soru Bankası" sayfasında öğrenci + konu filtresi seçer, kartlardaki checkbox'larla soru işaretler, **"Test Oluştur"** ile yeni sekmede yazdırılabilir bir "Tekrar Testi" açılır (numaralı soru fotoğrafları + ayrı sayfada cevap anahtarı; `dogru_cevap` boşsa "—"). `window.open` + `window.print()`, ek kütüphane yok. Yalnızca öğretmen rolünde (§7.1). Çıktı bir sonraki sekmede oluşturulur, öğrenci paneline hiç girmez.
> - **Hâlâ kapsam dışı:** V4.2 veli görünümü, V4.3 unutma eğrisi, V4.4 `konu_uyarilari` çapraz besleme.
>
> Aşağısı orijinal plan metnidir, tarihsel referans için bırakıldı.

## Özet

Bu sürümde öğrencinin ödev/deneme kontrolü sırasında hâlâ çözemediği veya anlamadığı soruları fotoğraflayarak kendi kalıcı arşivine (**"Soru Bankam"**) eklemesini sağlayan yeni bir modül geliştirilecek. Öğretmenin elle kâğıda kestirip deftere yapıştırdığı eski yöntemin dijital karşılığıdır.

Akış özeti:

```
Öğrenci ödevi çözer
   → Yanlış / boş soruları video çözümle kontrol eder
      → Hâlâ anlamadığı soru varsa fotoğrafını çeker
         → İstemci tarafında resize/sıkıştırma yapılır
            → Supabase Storage'a yüklenir
               → ADA (Gemini, mevcut yapay zekâ) görseli + kazanım listesini alır
                  → Ders / Konu / Kazanım / İpucu üretir (JSON)
                     → yanlis_defteri tablosuna kaydedilir
                        → Öğretmen panelinde onay/düzeltme yapılabilir
                           → Öğrenci "Soru Bankam"dan konuya göre filtreleyip tekrar edebilir
                              → Biriken sorulardan test/PDF oluşturulabilir (V4.1 — sonraki faz)
```

Referans alınan ürün: SoruSakla (Univers Dynamics) — "Sorularını çek → Kazanım eşleştir → Test oluştur" akışı. AdaptiX'in avantajı: `kazanimlar` tablosu zaten müfredat taksonomisi olarak mevcut, bu yüzden AI serbest metin üretmek yerine **kapalı liste içinden seçim** yapacak — bu, hem doğruluğu artırır hem de veri tutarlılığını korur.

---

## 1. Yeni Menü Öğesi

Öğrenci panelinde mevcut 4 sekmeye (**Ödevler / Denemeler / Dersler / Başarı**) ek olarak **"Soru Bankam"** sekmesi eklenecek.

- İkon: `photo_library` (Material Symbols Outlined)
- Konum: Öğrenci alt navigasyonunda (mobil) ve öğrenci masaüstü sekme çubuğunda, "Ödevler"den hemen sonra
- Veli panelinde salt-okunur bir "Soru Bankası" görünümü eklenebilir (V4.2 — opsiyonel, bkz. §7)
- Öğretmen panelinde mevcut **"Rapor"** sayfasına, öğrencinin soru bankası özeti bir alt bölüm olarak eklenecek (onay/düzeltme arayüzü burada olacak)

---

## 2. Veritabanı Değişiklikleri

### 2.1 Yeni Tablo — `yanlis_defteri`

```sql
CREATE TABLE yanlis_defteri (
  soru_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ogrenci_id        TEXT NOT NULL REFERENCES ogrenciler(ogrenci_id) ON DELETE CASCADE,
  odev_id           UUID REFERENCES odevler(odev_id) ON DELETE SET NULL, -- opsiyonel, hangi ödevden geldi
  fotograf_url      TEXT NOT NULL,                -- Supabase Storage public/signed URL
  ders              TEXT,                          -- AI önerisi veya öğretmen düzeltmesi
  konu              TEXT,
  kazanim_kodu      TEXT,                          -- kazanimlar tablosundaki kodla eşleşir
  ai_guven_skoru    NUMERIC,                       -- 0-1 arası, modelin eşleşmeye güveni
  ipucu             TEXT,                          -- AI üretimi çözüm ipucu
  dogru_cevap       TEXT CHECK (dogru_cevap IN ('A','B','C','D','E')),
  durum             TEXT NOT NULL DEFAULT 'ai_bekliyor'
                    CHECK (durum IN ('ai_bekliyor','ai_tamamlandi','ogretmen_onayladi','ogretmen_duzeltti','hata')),
  ogretmen_notu     TEXT,
  tekrar_sayisi     INTEGER NOT NULL DEFAULT 0,     -- öğrenci bu soruyu kaç kez "tekrar ettim" işaretledi
  son_tekrar_tarihi DATE,
  olusturma_tarihi  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE yanlis_defteri ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_yanlis_defteri" ON yanlis_defteri
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX idx_yanlis_defteri_ogrenci ON yanlis_defteri(ogrenci_id);
CREATE INDEX idx_yanlis_defteri_kazanim ON yanlis_defteri(kazanim_kodu);
```

**Alan notları:**
- `durum` alanı AI çağrısının ve öğretmen onayının aşamasını takip eder (bkz. §4.3 akış diyagramı)
- `ai_guven_skoru` düşükse (örn. < 0.6) öğretmen panelinde bu kayıt otomatik olarak "gözden geçir" listesine düşer
- `tekrar_sayisi` / `son_tekrar_tarihi`, öğrencinin bu soruyu ne sıklıkla tekrar ettiğini raporlamak için — ileride "unutma eğrisi" bazlı hatırlatma özelliğine (V4.3) temel oluşturur

### 2.2 Supabase Storage — Yeni Bucket

```
Bucket adı: soru-fotograflari
Erişim: private (signed URL ile öğrenci/öğretmen erişimi)
Dosya adı şeması: {ogrenci_id}/{soru_id}.jpg
```

- RLS benzeri erişim kontrolü Storage policy ile: sadece ilgili öğrenci ve öğretmen rolü kendi öğrencisinin dosyasına erişebilir
- Maksimum dosya boyutu: 500 KB (istemci tarafı sıkıştırmadan sonra bu sınırı aşmamalı — bkz. §3)

---

## 3. İstemci Tarafı Görsel Optimizasyonu (Yükleme Öncesi)

Farklı çözünürlük/boyuttaki telefon fotoğrafları ham haliyle yüklenmeyecek. Yükleme akışı tamamen tarayıcıda, `<canvas>` üzerinden yapılacak:

| Adım | İşlem | Gerekçe |
|---|---|---|
| 1 | EXIF orientation okunur, görsel buna göre döndürülür | Telefon kameralarında yamuk/yan yüklenmeyi önler |
| 2 | En uzun kenar 1600px'i geçiyorsa oranlı küçültülür | AI okunabilirliği için 1600px yeterli, üstü gereksiz veri |
| 3 | Canvas'tan JPEG olarak %75-80 kalite ile export edilir | Dosya boyutunu ciddi düşürür, metin netliğini korur |
| 4 | Son dosya boyutu kontrol edilir (>500 KB ise kalite kademeli düşürülür) | Storage ve AI çağrı maliyetini sınırlar |

**Yeni Fonksiyon:**

```javascript
async function optimizeImageForUpload(file, maxDim = 1600, quality = 0.78) {
  // 1. EXIF orientation düzeltmesi
  // 2. Canvas'a çiz, oranlı resize
  // 3. toBlob('image/jpeg', quality) ile sıkıştır
  // 4. Blob boyutu > 500KB ise quality'yi 0.05 azaltıp tekrar dene (max 3 deneme)
  // return: optimized Blob
}
```

Bu işlem tamamen istemcide (kullanıcının cihazında) çalışır; orijinal boyutlu dosya hiçbir zaman sunucuya gönderilmez.

---

## 4. ADA (Gemini) Entegrasyonu — Görsel Kazanım Eşleştirme

### 4.1 Mevcut Durum

ADA şu anda yalnızca **metin tabanlı** çağrılarla çalışıyor (örn. haftalık performans analizi). Gemini modelleri (1.5/2.x Flash ve Pro ailesi) doğası gereği multimodal olduğundan, ADA'nın altyapısı değiştirilmeden **yeni bir çağrı tipi** eklenmesi yeterli.

> **Not:** ADA'nın şu an hangi Gemini modeliyle (Flash / Pro) çalıştığı doğrulanmalı — görsel + akıl yürütme + JSON çıktı isteneceği için hız/maliyet/doğruluk dengesi buna göre seçilecek. Bu doğrulama tamamlanmadan prod entegrasyonu yapılmamalı.

### 4.2 Prompt Tasarımı

Modelden **serbest metin değil, kapalı liste içinden seçim** istenecek — bu, uydurma kazanım üretimini engeller ve veri tutarlılığını korur.

```javascript
const prompt = `
Aşağıda bir öğrencinin çözemediği bir sorunun fotoğrafı var.
Bu öğrenci ${sinif}. sınıf düzeyindedir.

Sana bu sınıf düzeyine ait kazanım listesi veriliyor (JSON):
${JSON.stringify(kazanimListesi)} 
// [{ konu, kazanim_kodu, kazanim_aciklamasi }, ...]

Görevlerin:
1. Sorunun hangi derse ait olduğunu belirle
2. Yukarıdaki listeden sorunun en uygun olduğu "konu" ve "kazanim_kodu" değerini SEÇ
   (listede olmayan bir kazanım UYDURMA; en yakın eşleşmeyi seç)
3. Eşleşmene ne kadar güvendiğini 0-1 arası bir sayı ile belirt
4. Öğrenciye soruyu çözmesi için (cevabı vermeden) kısa bir ipucu yaz

Yalnızca aşağıdaki JSON formatında yanıt ver, başka hiçbir açıklama ekleme:
{
  "ders": "...",
  "konu": "...",
  "kazanim_kodu": "...",
  "ai_guven_skoru": 0.0,
  "ipucu": "..."
}
`;
```

### 4.3 Akış Diyagramı (Durum Geçişleri)

```
[Fotoğraf yüklendi] → durum: 'ai_bekliyor'
        │
        ▼
[ADA çağrısı yapılır]
        │
   ┌────┴────┐
   ▼         ▼
 başarılı   hata
   │         │
   ▼         ▼
'ai_tamamlandi'   'hata' (öğretmene manuel giriş uyarısı)
   │
   ▼
guven_skoru < 0.6 ?
   │
  evet → öğretmen panelinde "Gözden Geçir" listesine düşer
  hayır → öğrenci panelinde direkt gösterilir, öğretmen isterse sonradan düzeltir
   │
   ▼
[Öğretmen onaylar / düzeltir] → durum: 'ogretmen_onayladi' / 'ogretmen_duzeltti'
```

### 4.4 Yeni Fonksiyonlar

| Fonksiyon | Açıklama |
|---|---|
| `optimizeImageForUpload(file)` | Görseli EXIF düzeltip resize/sıkıştırır (bkz. §3) |
| `uploadSoruFotografi(ogrenciId, blob)` | Optimize edilmiş görseli Storage'a yükler, URL döner |
| `analizEtSoruFotografi(soruId, fotoUrl, sinif)` | ADA'ya görsel + kazanım listesini gönderir, JSON parse eder |
| `soruBankasinaEkle(ogrenciId, odevId, fotoUrl)` | `yanlis_defteri`'ne yeni kayıt açar, AI analizini tetikler |
| `soruOnayla(soruId)` | Öğretmen onayı — `durum = 'ogretmen_onayladi'` |
| `soruDuzelt(soruId, yeniKonu, yeniKazanim)` | Öğretmen düzeltmesi — `durum = 'ogretmen_duzeltti'` |
| `soruTekrarEt(soruId)` | `tekrar_sayisi += 1`, `son_tekrar_tarihi = today()` |
| `loadSoruBankasi(ogrenciId, filtreKonu)` | Öğrenci panelinde konuya göre filtrelenmiş liste çeker |
| `renderSoruKarti(soru)` | Fotoğraf + konu/kazanım rozeti + ipucu (açılır) + "Tekrar Ettim" butonu render eder |

---

## 5. Arayüz Tasarımı

### 5.1 Öğrenci Paneli — "Soru Bankam" Sekmesi

- Üstte **"+ Soru Ekle"** butonu → kamera/galeri seçimi açılır
- Konuya göre filtre çipleri (öğrencinin sınıfındaki konulardan otomatik üretilir)
- Her soru bir kart olarak listelenir:
  - Küçültülmüş fotoğraf önizlemesi (tıklayınca büyür)
  - Ders/Konu/Kazanım rozeti (renk kodu `kazanimlar` tablosundaki sınıf rengiyle tutarlı — 8. sınıf primary, 7. sınıf tertiary, 6. sınıf secondary)
  - "İpucunu Göster" (varsayılan gizli, tıklayınca açılır — cevabı direkt görmesin diye)
  - "Tekrar Ettim" butonu → `tekrar_sayisi` artırır
  - AI güven skoru düşükse kartta küçük "⏳ Öğretmen onayı bekliyor" etiketi

### 5.2 Öğretmen Paneli — Rapor Sayfası Eklentisi

Mevcut **Rapor** bölümüne yeni bir alt sekme: **"Soru Bankası"**

- Onay bekleyen (`ai_guven_skoru < 0.6` veya `durum = 'hata'`) kayıtlar üstte, kırmızı/turuncu rozetle
- Her kayıt için: fotoğraf, AI'ın önerdiği konu/kazanım, düzeltme dropdown'ı (kazanimlar tablosundan), "Onayla" / "Düzelt ve Kaydet" butonları
- Konu bazlı dağılım özeti: öğrencinin en çok hangi konularda soru biriktirdiği (V3'teki `analizEt` mantığıyla tutarlı bir uyarı üretilebilir — örn. aynı kazanımdan 5+ soru varsa "kronik" rozeti)

---

## 6. Güvenlik ve Performans Notları

- Fotoğraflar `private` bucket'ta tutulacak, görüntüleme signed URL (kısa ömürlü, örn. 1 saat) ile yapılacak — dışarıya açık link paylaşılmayacak
- ADA çağrısı başarısız olursa (`durum = 'hata'`) öğrenci soruyu yine de bankasına ekleyebilmeli, sadece konu/kazanım alanı boş kalır ve öğretmen manuel doldurur — kullanıcı deneyimi AI'a bağımlı kalmamalı
- Görsel optimizasyonu adımı atlanırsa (örn. tarayıcı desteği yoksa) yükleme engellenmemeli, ancak sunucu tarafında da bir boyut sınırı (Storage policy ile 2 MB hard limit) tanımlanmalı — çift güvenlik katmanı
- AI çağrı maliyeti kontrolü için öğrenci başına günlük soru ekleme sınırı düşünülebilir (örn. 20 soru/gün) — kötüye kullanımı önler

---

## 7. Sonraki Fazlar (Bu Sürümde Kapsam Dışı)

| Faz | Özellik |
|---|---|
| V4.1 | Soru bankasından otomatik PDF test oluşturma — **yalnızca öğretmen rolü** yapabilir (bkz. §7.1). Öğrenci kendi sorularını görebilir ve tekrar edebilir ama PDF/test üretemez. |
| V4.2 | Veli paneline salt-okunur "Soru Bankası" özet görünümü |
| V4.3 | Unutma eğrisi bazlı hatırlatma — `tekrar_sayisi` ve `son_tekrar_tarihi` kullanılarak "bu soruyu tekrar etme zamanı geldi" bildirimi |
| V4.4 | Aynı kazanımdan çok soru biriken öğrenciler için V3'teki proaktif uyarı sistemine entegrasyon (`konu_uyarilari` tablosuyla çapraz besleme) |

### 7.1 V4.1 — Yetkilendirme Notu (Test/PDF Oluşturma)

Test/PDF oluşturma **yalnızca öğretmen rolüne** açık olacak. Öğrenci tarafında bu özellik hiç gösterilmeyecek — buton/menü öğesi öğrenci panelinde render edilmeyecek (arayüzden gizleme yeterli değil, aşağıdaki gibi sunucu tarafında da kısıtlanacak).

- **Öğrenci paneli:** "Soru Bankam" sekmesinde sadece görüntüleme, filtreleme, ipucu açma ve "Tekrar Ettim" işaretleme mevcut. PDF/yazdırma butonu yok.
- **Öğretmen paneli:** "Rapor → Soru Bankası" alt sekmesinde, öğretmen öğrencinin sorularından (tek tek veya konu bazlı toplu) seçim yapıp **"Test Oluştur (PDF)"** butonunu kullanabilir.
- **Yetki kontrolü:** PDF oluşturma fonksiyonu çağrılmadan önce oturum açan kullanıcının rolü kontrol edilecek (`session.role === 'ogretmen'`); RLS policy'de de `yanlis_defteri` üzerindeki toplu okuma + PDF üretim tetikleyici fonksiyon öğretmen rolüyle sınırlanacak, öğrenci JWT'siyle bu fonksiyona erişim reddedilecek.
- Böylece hangi soruların teste dönüştürüleceği, ne zaman ve nasıl (örn. karışık konu mu tek konu mu) pedagojik bir karar olarak öğretmende kalır; öğrenci tarafı sadece biriktirme + tekrar amaçlı kullanılır.

---

## 8. Açık Sorular (Geliştirme Öncesi Netleşmesi Gerekenler)

1. ADA şu an hangi Gemini modeliyle çalışıyor (Flash / Pro)? Görsel + JSON çıktı için model seçimi bu doğrulamaya bağlı.
2. Öğrenci günlük soru ekleme limiti olacak mı, olacaksa kaç?
3. Öğretmen onayı zorunlu mu, yoksa yüksek güven skorlu (`≥0.8`) kayıtlar otomatik "onaylı" sayılsın mı?
4. Fotoğraf saklama süresi sınırlı mı (örn. öğrenci kaydı silinince Storage'daki dosyalar da otomatik silinsin mi — cascade)?

---

*AdaptiX BTS V4 — Soru Bankası (Yanlış Defteri) Modülü — Geliştirme Dokümanı*
