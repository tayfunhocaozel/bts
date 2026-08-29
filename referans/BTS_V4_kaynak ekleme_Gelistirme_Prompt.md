# AdaptiX BTS V4 — Geliştirme Talimatı

**Hazırlanma Tarihi:** 28 Ağustos 2026
**Sürüm:** BTS V3 → V4
**İlgili Dosyalar:** `scholar_metric.html`, `www/index.html`
**Kapsam:** Kamera ile kaynak ekleme + Ödev-Kaynak bağlama + Otomatik ilerleme takibi

---

## 0. DURUM VE İLK ADIM

### 0.1 Tamamlanan Kısım (referans amaçlı, dokunma)

Kamera ile kaynak ekleme (Bölüm 1) **canlıda çalışıyor**, tekrar dokunulmayacak:
- `scholar_metric.html` satır 748'de "📷 Kamera ile Ekle" butonu, 3 adımlı `kkm-modal` sihirbazı
- `supabase/functions/kaynak-ocr` edge function (ACTIVE, v3, Gemini 3.6 Flash + `responseSchema`)
- Kayıt: `kaynaklar` + `kaynak_konulari` + (varsa) `kaynak_cevap_anahtari`; **`kaynak_id` TEXT tipinde** (`'KYN-'+Date.now()`) — aşağıdaki tüm yeni tablo/kolonlarda FK tipi buna göre **TEXT** olmalı, UUID değil
- Fotoğraflar saklanmıyor (sadece OCR anında kullanılıp atılıyor)
- Bilinen sınır: çok uzun içindekiler listelerinde Gemini 8192 token sınırına takılabiliyor ("daha az fotoğrafla dene" mesajı veriyor) — bu sürümde çözülmeyecek, sadece bilgi amaçlı

### 0.2 Bölüm 2 Öncesi Zorunlu İnceleme — "Ödev Gir" Ekranı

Bölüm 2'ye (Ödev-Kaynak Bağlama) başlamadan önce, `scholar_metric.html` (ve `www/index.html`) içinde **güncel haliyle** şunları incele ve bana özetle:

1. **"Ödev Gir" ekranının mevcut akışı**
   - Konu ve kazanımın seçildiği havuz yapısı (hangi tablo/dizi, hangi fonksiyon dolduruyor)
   - Kaynak seçildiğinde şu an ne oluyor (sadece kaynak adı mı seçiliyor, başka bir alan tetikleniyor mu)
   - Açıklama alanının HTML yapısı (textarea mı, input mu, karakter sınırı var mı)
   - Taslağa ekleme (`Tabloya Ekle`) ve toplu kaydetme (`Tümünü Kaydet`) fonksiyonlarının tam kodu

2. **`odevler` tablosunun gerçek güncel şeması**
   - Kamera modülü sonrası `kaynaklar`/`kaynak_konulari` şemasında değişen bir şey oldu mu (örn. ek kolonlar) kontrol et
   - `odevler` tablosunda şu an referans edilen tüm kolonlar (özellikle `kaynak` ve `konu` serbest metin alanlarının tam adı, ve `odev_id`/birincil anahtarın tipi — UUID mi TEXT mi, `odev_kaynak_kapsam.odev_id` FK tipi buna göre ayarlanacak)

3. **`kaynak_konulari` ve `kaynak_cevap_anahtari` gerçek içeriği**
   - DB'deki 2 canlı kaydı (13 konu / 6 konu + 5 test) örnek olarak çek, `sayfa_no` alanının gerçekten dolu ve sıralı geldiğini doğrula (Bölüm 2.5'teki `LEAD()` mantığı buna bağımlı)

Bu incelemenin sonucunu **kısa bir bulgu listesi** olarak paylaş, ardından Bölüm 2'deki değişikliklere geç. Bulgular planla çelişirse (özellikle kolon adı/tipi farkları), önce bana bildir, sessizce farklı bir isim/tip kullanma.

---

## 1. YENİ ÖZELLİK: Kamera ile Kaynak Ekleme

### 1.1 Amaç
Kaynak eklerken `konu_sayisi` gibi alanları elle/varsayılan girmek yerine, kaynağın üç fotoğrafından (kapak, içindekiler, cevap anahtarı) veriyi otomatik çıkarmak.

### 1.2 Kullanıcı Akışı
1. "Kaynaklar" bölümünde **"Kamera ile Ekle"** seçeneği eklenir (mevcut manuel ekleme akışının yanına, onu kaldırmadan)
2. Üç adımlı fotoğraf çekimi:
   - **Kapak** → `kaynak_adi`, `yayin_evi`, `sinif` tahmini
   - **İçindekiler** → `konu_listesi`: `[{konu_adi, sayfa_no}, ...]`
   - **Cevap Anahtarı** (opsiyonel, atlanabilir) → `[{test_no veya sayfa_no, cevaplar: ["A","C","B",...]}]`
3. Mobilde `<input type="file" accept="image/*" capture="environment">` ile kamera açılır (Capacitor APK'da da native çalışır)
4. **Client-side resize (API'ye göndermeden önce zorunlu ara adım):** çekilen fotoğraf `canvas` ile uzun kenarı ~1568 px'e indirilecek şekilde küçültülür ve JPEG kalite ~%85 ile sıkıştırılır. Ham telefon fotoğrafları (10-20MP, birkaç MB) resize edilmeden gönderilirse API zaten kendiliğinden küçültüyor ama bu ekstra gecikme ve gereksiz veri transferi yaratıyor, OCR kalitesine katkısı olmuyor. Çok fazla küçültmemeye dikkat: herhangi bir kenarda 200 px altına düşürülmemeli (performans düşüyor).
5. Fotoğraflar Anthropic API'ye (Claude, vision girişi) gönderilir, **sadece JSON döndür** talimatıyla yapılandırılmış veri istenir
6. Sonuç bir **önizleme/düzenleme ekranında** gösterilir — öğretmen OCR çıktısını onaylamadan kaydedilmez (OCR hataları için düzenlenebilir liste)
7. Onaylanınca Supabase'e yazılır

### 1.3 Supabase Tabloları (✅ CANLIDA KURULU — referans amaçlı, tekrar oluşturma)

> `kaynak_id` alanı planlanan UUID değil, gerçek şemada **TEXT** (`'KYN-'+Date.now()`). Aşağıdaki tanım gerçek/canlı şemayı yansıtır.

```sql
CREATE TABLE kaynak_konulari (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kaynak_id TEXT REFERENCES kaynaklar(kaynak_id) ON DELETE CASCADE,
  konu_adi TEXT NOT NULL,
  sayfa_no INT,
  sira INT
);

CREATE TABLE kaynak_cevap_anahtari (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kaynak_id TEXT REFERENCES kaynaklar(kaynak_id) ON DELETE CASCADE,
  test_no INT,
  sayfa_no INT,
  cevaplar JSONB
);
```

`ogrn_kaynak.konu_sayisi` artık elle girilmiyor; `kaynak_konulari` tablosundaki satır sayısına eşitlenerek otomatik dolduruluyor.

---

## 2. YENİ ÖZELLİK: Ödev-Kaynak Bağlama

> **GÜNCELLEME (29 Ağustos 2026) — Bölüm 2 mimarisi: checkbox akışı benimsendi, parse/kapsam iptal.**
>
> Bölüm 2, `db9a91f` commit'inde zaten **açık checkbox seçimi** ile uygulandı ve bu mimari korunuyor:
> - "Ödev Gir"de kamera kaynağı seçilince `kaynak_konulari` + `kaynak_cevap_anahtari` **checkbox listesi** gösterilir; işaretli her konu/test `odevler`'e **ayrı satır** olarak yazılır (`kaynak_id`, `kaynak_konu_id` ya da `test_no`, `sayfa_baslangic/bitis`).
> - **İPTAL:** 2.3–2.6'daki serbest-metin parse (`parseSayfaAraligi` / `parseTestNumbers`) ve **`odev_kaynak_kapsam` M2M tablosu** yapılmayacak. Çoklu konu = çoklu `odevler` satırı zaten M2M ihtiyacını karşılıyor ve tamamlama takibini konu bazında granüler tutuyor. `odev_kaynak_kapsam` tablosu oluşturulmadı.
> - Gerekçe: mevcut akış canlıda çalışıyor, bağlı üretim verisi yok, açık seçim regex tahmininden güvenilir, şema değişikliği gerekmiyor.
>
> **İlerleme takibi (2.7) — tamamlandı:** `kaynakIlerlemeleriGetir()` artık (a) OCR fazlası satırları ("CEVAP ANAHTARI", "İçindekiler", "Önsöz", "Kaynakça") paydadan eler, (b) cevap anahtarı olan kaynakta birim **test** (`kaynak_cevap_anahtari` sayısı / farklı tamamlanan `test_no`), yoksa **konu**, (c) `state.kaynaklar` boş olan öğrenci/veli oturumunda katalogu DB'den çeker. Bağlandığı ekranlar: **Kaynaklar** (mevcut "oto" rozeti), **Rapor** ("Kaynak Bazlı İlerleme"), **Öğrenci "Başarım"** ve **Veli "Başarı"** (yeni `kaynakIlerlemeHTML()` kartı).
>
> Aşağıdaki 2.1–2.9 orijinal plan metnidir, tarihsel referans için bırakıldı.

### 2.1 Amaç
"Ödev Gir" ekranında kaynak seçildiğinde, hangi test/sayfa aralığının verildiğini yapılandırılmış şekilde kaydetmek — serbest metin yerine `kaynak_konulari`/`kaynak_cevap_anahtari` referansı kullanmak.

### 2.2 `odevler` Tablosuna Yeni Kolonlar

```sql
ALTER TABLE odevler ADD COLUMN kaynak_id TEXT REFERENCES kaynaklar(kaynak_id);
ALTER TABLE odevler ADD COLUMN kaynak_konu_id UUID REFERENCES kaynak_konulari(id);
ALTER TABLE odevler ADD COLUMN test_no INT;
ALTER TABLE odevler ADD COLUMN sayfa_baslangic INT;
ALTER TABLE odevler ADD COLUMN sayfa_bitis INT;
```

Mevcut serbest metin `kaynak`/`konu` kolonları **silinmiyor** (geriye dönük uyumluluk için); yeni ödevler yeni kolonlar üzerinden kaydediliyor.

### 2.3 ÖNEMLİ — Gerçek Kullanım Şekli: Konu/Kazanım Havuzdan, Kaynak Açıklamadan Seçiliyor

Mevcut "Ödev Gir" ekranında **konu ve kazanım ayrı bir havuzdan seçiliyor**; kaynak seçilince ise sadece kaynak listeleniyor, hangi sayfa/test verildiği bilgisi **serbest metin açıklama alanına** yazılıyor. Örnekler:

- `"SB ödevi sy 43-51 verildi"` → soru bankası, sayfa aralığı
- `"Test 21-25 çözülecek"` → soru bankası, test numaraları (tire burada aralık DEĞİL)
- `"Test 21 ve test 25 çözülecek"` → aynı anlam, farklı yazım
- `"test 21, 22 ve 23"` → aynı anlam, farklı yazım

**Kritik kural:** Sayfa ve test için tire farklı anlama gelir:
- **Sayfada tire = aralık.** `sy 43-51` → 43,44,45...51 arası TÜM sayfalar.
- **Testte tire = liste/ayraç, ASLA aralık değil.** `test 21-25` → sadece Test 21 ve Test 25 (21,22,23,24,25 DEĞİL). Test birimleri ayrık/numaralı olduğu için tire orada "ve" gibi davranır.

Bu nedenle sistemin ilerleme takibi yapabilmesi için ödev kaydedilirken açıklama metni **parse edilip** ilgili konu(lar)/test(ler) ile eşleştirilmeli.

### 2.4 Açıklama Parse Mantığı

**Sayfa aralığı ayrıştırma (aralık mantığı):**
```javascript
function parseSayfaAraligi(aciklama) {
  const m = aciklama.match(/s(?:y|ayfa)?\.?\s*(\d+)\s*[-–—]\s*(\d+)/i);
  if (m) return { baslangic: +m[1], bitis: +m[2] };
  const tek = aciklama.match(/s(?:y|ayfa)?\.?\s*(\d+)\b/i);
  if (tek) return { baslangic: +tek[1], bitis: +tek[1] };
  return null;
}
```

**Test numarası ayrıştırma (liste mantığı, doğal dil varyasyonlarını yakalar):**
```javascript
function parseTestNumbers(aciklama) {
  // "test" kelimesi geçen tüm blokları yakala (birden fazla kez geçebilir:
  // "Test 21 ve test 25" gibi)
  const bloklar = aciklama.match(/test\s*[\d\s,\-\/]+(?:ve|ile)?[\d\s,\-\/]*/gi) || [];

  const sayilar = new Set();
  bloklar.forEach(blok => {
    const nums = blok.match(/\d+/g) || [];
    nums.forEach(n => sayilar.add(Number(n)));
  });

  return [...sayilar].sort((a, b) => a - b);
}

// Örnekler:
parseTestNumbers("SB ödevi test 21-25 verildi");    // [21, 25]
parseTestNumbers("Test 21-22-23 çözülecek");         // [21, 22, 23]
parseTestNumbers("Test 21 ve test 25 çözülecek");    // [21, 25]
parseTestNumbers("test 21, 22 ve 23");               // [21, 22, 23]
```

**Ana fonksiyon:**
```javascript
function parseKapsam(aciklama, kaynakTipi) {
  if (kaynakTipi === 'soru_bankasi') {
    const testler = parseTestNumbers(aciklama);
    return testler.length ? { tip: 'test', degerler: testler } : null;
  } else {
    const aralik = parseSayfaAraligi(aciklama);
    return aralik ? { tip: 'sayfa_araligi', ...aralik } : null;
  }
}
```

### 2.5 Sayfa Aralığından Konuları Bulma

`kaynak_konulari`'nda her konunun sadece **başlangıç** sayfası var; bitiş, bir sonraki konunun başlangıcından 1 eksiği olarak `LEAD()` ile hesaplanır:

```sql
SELECT id, konu_adi, sayfa_no,
       LEAD(sayfa_no) OVER (PARTITION BY kaynak_id ORDER BY sayfa_no) - 1 AS sayfa_bitis
FROM kaynak_konulari
WHERE kaynak_id = :kaynak_id;
```

Ödevin sayfa aralığı `[baslangic, bitis]` ile **kesişen** konular = bu ödevin kapsadığı konular (bir ödev birden fazla konuya taşabilir, bu normaldir).

### 2.6 Yeni Ara Tablo — Çoktan Çoğa İlişki

Bir ödev birden fazla konuyu/testi kapsayabildiği için tekil `kaynak_konu_id` kolonu yetersiz kalıyor; `odevler` tablosuna eklenen `kaynak_konu_id`/`test_no` kolonları yerine ayrı bir ilişki tablosu kullanılmalı:

```sql
CREATE TABLE odev_kaynak_kapsam (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  odev_id UUID REFERENCES odevler(odev_id) ON DELETE CASCADE,
  kaynak_konu_id UUID REFERENCES kaynak_konulari(id),  -- konu anlatımlı kaynaklarda
  test_no INT                                          -- soru bankalarında
);
```

**Kayıt akışı:** Öğretmen açıklamayı yazıp kaydet dediğinde → `parseKapsam()` çalışır → eşleşen konu(lar)/test(ler) bulunur → küçük bir onay chip'i gösterilir (kamera modülündeki OCR önizlemesiyle aynı mantık): *"Bu ödev şu konuları/testleri kapsıyor: Üslü Sayılar, Kareköklü İfadeler — doğru mu?"* → onaylanınca `odev_kaynak_kapsam`'a yazılır.

> Not: `odevler` tablosuna 2.2'de eklenen `kaynak_konu_id`, `test_no`, `sayfa_baslangic`, `sayfa_bitis` kolonları, ödevin **kendi görünümünde** özet bilgi olarak (hangi aralık/testler girildi) tutulmaya devam edebilir; ama ilerleme hesaplaması ve raporlama **`odev_kaynak_kapsam`** tablosu üzerinden yapılmalı, çünkü bir ödev birden fazla konu/testi kapsayabiliyor.

### 2.7 Otomatik İlerleme / Tamamlama Oranı (Güncellenmiş Sorgu)

`ilerleme_yuzdesi` artık manuel sayaç değil, `odev_kaynak_kapsam` üzerinden hesaplanan değer:

```sql
SELECT
  o.ogrenci_id,
  o.kaynak_id,
  COUNT(DISTINCT k.kaynak_konu_id) FILTER (WHERE o.durum = 'TAMAMLANDI') AS tamamlanan_konu,
  (SELECT COUNT(*) FROM kaynak_konulari kk WHERE kk.kaynak_id = o.kaynak_id) AS toplam_konu
FROM odevler o
JOIN odev_kaynak_kapsam k ON k.odev_id = o.odev_id
WHERE o.kaynak_id = :kaynak_id
GROUP BY o.ogrenci_id, o.kaynak_id;
```

`DISTINCT` kritik: aynı konu birden fazla kez (örn. tekrar amaçlı) ödev olarak verilebilir. Distinct olmadan bu, ilerlemeyi yapay olarak şişirir — önemli olan kaç *farklı* konunun bitmiş olduğu.

Soru bankalarında (cevap anahtarlı kaynaklarda) birim "konu" değil `test_no` olur; aynı sorgu mantığı `kaynak_cevap_anahtari`'ndaki toplam test sayısına göre uyarlanır.

Bu değer:
- "Kaynaklar" bölümündeki ilerleme çubuğuna
- "Rapor" sayfasına
- Öğrenci/Veli panelindeki "Başarı" sekmesine

bağlanacak.

### 2.8 Kenar Durumlar

- **Parse edilemeyen açıklama** (örn. "biraz tekrar yapsın" gibi serbest yazım, sayfa/test bilgisi içermeyen) → kapsam boş kalır, ilerlemeye dahil edilmez, öğretmene zorunlu uyarı gösterilmez.
- **Aralık dışı sayfa** (kaynağın son konusundan sonraki bir sayfa girilmişse) → eşleşme bulunamaz, onay chip'i boş döner, öğretmen bunu fark edip düzeltebilir.
- **Kısmi konu ilerlemesi** (örn. 45 sayfalık bir konunun sadece 20 sayfası ödev olarak verildi) → şu an model bunu ikili (tamamlandı/tamamlanmadı) olarak görüyor, sayfa bazlı kısmi ağırlıklı ilerleme **bu sürümün kapsamı dışında** (ileride geliştirme notu olarak değerlendirilebilir).
- **Test aralığı belirsizliği yok:** tire her zaman liste anlamına gelir (`test 21-25` = Test 21 ve Test 25), aralık olarak yorumlanmaz — bu kural kesin, gri alan bırakılmaz.

### 2.9 Ek Görsel (opsiyonel, zaman kalırsa)
Kitabın toplam sayfa aralığı, öğrenciye verilen sayfa aralığı ve tamamlanan sayfa aralığının üst üste bindirildiği basit bir kapsama çubuğu (kitap / verildi / tamamlandı).

---

## 3. İLERİYE DÖNÜK NOT — Bu Sürümde YAPILMAYACAK

> **Not:** Eski `odevler` kayıtlarının (yeni kolonlar eklenmeden önce girilmiş olanlar) `kaynak_id` ve `kaynak_konu_id` alanları bu değişiklikle birlikte **NULL kalacak** ve yeni ilerleme hesaplamasına dahil edilmeyecek.
>
> İleride, bu eski kayıtları **isim eşleştirmesiyle (serbest metin `kaynak` / `konu` alanlarını `kaynaklar.kaynak_adi` ve `kaynak_konulari.konu_adi` ile karşılaştırarak)** geriye dönük bağlayan ayrı bir **migration script'i** yazılabilir. Bu script:
> - Bulanık/yaklaşık string eşleştirme (örn. `pg_trgm` benzerlik skoru veya normalize edilmiş metin karşılaştırması) gerektirebilir
> - Eşleşmeyen veya belirsiz kayıtları raporlayıp öğretmen onayına sunmalı, otomatik ve sessizce güncelleme yapmamalı
> - Bu dokümanın kapsamı **dışındadır** — ayrı bir görev olarak ele alınacaktır, şimdilik sadece not olarak düşülmüştür.

---

## 4. Teknik Notlar

- Chart.js 4.4.4 zaten mevcut, yeni import gerekmiyor
- Tüm değişiklikler `scholar_metric.html` ve `www/index.html`'de eşzamanlı uygulanmalı (V1/V2/V3'te izlenen kural)
- Anthropic API çağrıları için API key istemci tarafında saklanmamalı — güvenli bir proxy/edge function üzerinden yapılmalı
- Mevcut manuel kaynak ekleme akışı **kaldırılmıyor**, kamera akışı ek seçenek olarak sunuluyor
- Fotoğraf resize adımı (1.2/4) implementasyon sırasında atlanmamalı; API otomatik küçültüyor olsa da resize edilmeden gönderim gecikme ve gereksiz veri transferine yol açıyor
- `parseSayfaAraligi` / `parseTestNumbers` fonksiyonları önce birim test'lerle (2.4'teki örnekler) doğrulanmalı, ardından "Ödev Gir" ekranına bağlanmalı — özellikle "test 21-25" gibi ifadelerin **liste** (21 ve 25), **aralık değil** olarak yorumlandığından emin olunmalı
