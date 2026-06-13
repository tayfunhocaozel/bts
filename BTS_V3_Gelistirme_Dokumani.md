# AdaptiX BTS V3 — Geliştirme Dokümanı

**Hazırlanma Tarihi:** 13 Haziran 2026
**Sürüm:** BTS V2 → V3
**Geliştirici:** Tayfun Hoca + Claude (Sonnet 4.6)
**İlgili Dosyalar:** `scholar_metric.html`, `www/index.html`
**GitHub Commit:** `3e4438f` (master → main)

---

## Özet

Bu sürümde üç büyük özellik eklendi:

1. **Ders Programı Modülü** — Haftalık seans grid görünümü
2. **Ders Kaydet İyileştirmeleri** — Kazanım bazlı tamamlama durumu + alan yeniden isimlendirme
3. **Konu Bazlı Zaman Serisi ve Proaktif Uyarı Sistemi** — Üç panelde konu grafikleri + öğretmene otomatik uyarılar

---

## 1. Ders Programı Modülü

### 1.1 Yeni Menü Öğesi

Sol menüye (masaüstü) ve alt navigasyona (mobil) `calendar_month` ikonlu **"Ders Programı"** sayfası eklendi. Sadece `ogretmen` rolünde görünür.

### 1.2 Veritabanı Değişiklikleri — `ders_programi`

Mevcut tabloya iki sütun eklendi:

| Sütun | Tip | Açıklama |
|---|---|---|
| `tip` | text | `'kalici'` (her hafta tekrar) veya `'ek'` (tek seferlik) |
| `tarih` | date, nullable | Yalnızca `tip = 'ek'` için doldurulur |

Migration:
```sql
ALTER TABLE ders_programi ADD COLUMN tip TEXT DEFAULT 'kalici';
ALTER TABLE ders_programi ADD COLUMN tarih DATE;
UPDATE ders_programi SET tip = 'kalici' WHERE tip IS NULL;
```

### 1.3 Haftalık Grid Görünümü

- Sütunlar: Pazartesi–Pazar (7 gün)
- Saat ekseni: 07:00–21:00, 64px/saat, absolute positioning
- Sınıf bazlı renk: 8. sınıf → primary (#005d8d), 7. sınıf → tertiary (#00661d), 6. sınıf → secondary (#805600), diğer → neutral
- Karta tıklayınca öğrenci rapor sayfası açılır
- İstatistik şeridi: toplam haftalık seans + sınıf bazlı dağılım

### 1.4 Form Güncellemeleri

- **Seans Türü** seçimi eklendi: "Kalıcı" (gün dropdown) / "Bu Hafta Özel" (tarih seçici)
- **Çakışma kontrolü:** Aynı güne ait seanslarla kesişim kontrolü — `(yeniStart < mevcutEnd) AND (yeniEnd > mevcutStart)`
- Çakışma varsa kayıt engellenir, hangi öğrenciyle çakıştığı gösterilir

### 1.5 Lazy-Load Hook

```javascript
function goPage(id) {
  // ...
  if (id === 'ders-programi') loadHaftalikProgram();
  // ...
}
```

### 1.6 Yeni Fonksiyonlar

| Fonksiyon | Açıklama |
|---|---|
| `loadHaftalikProgram()` | DB'den çeker, haftayı filtreler, `renderHaftalikGrid()` çağırır |
| `renderHaftalikGrid(pazartesi)` | 7 günlük CSS grid + absolute kart render |
| `checkCakisma(gun, baslangic, bitis, excludeId)` | Bellek içi çakışma kontrolü |
| `programEkle()` | Form validasyonu + çakışma kontrolü + Supabase insert |
| `programSil(id)` | Supabase delete + listeyi yenile |

---

## 2. Ders Kaydet İyileştirmeleri

### 2.1 Alan Yeniden İsimlendirme (UI Etiketi — Şema Değişmedi)

| Eski Etiket | Yeni Etiket | DB Kolonu |
|---|---|---|
| Ders Görüşü | Sorun Alanı | `ders_gorusu` |
| Sonraki Ders Hatırlatma | Sonraki Ders Notu | `sonraki_ders_hatirlatma` |

### 2.2 Kazanım Bazlı Tamamlama Durumu

Her seçili kazanımın yanında üç toggle butonu:

- **Tam** (varsayılan, seçilince `tam`)
- **Kısmi** (`kismi`)
- **Başlandı** (`baslandi`)

Seçim `tamamlama_durumu` kolonu olarak `dersler` tablosuna yazılır.

```sql
-- Gerekli sütun (henüz yoksa)
ALTER TABLE dersler ADD COLUMN tamamlama_durumu TEXT DEFAULT 'tam';
```

### 2.3 Yeni / Güncellenen Fonksiyonlar

| Fonksiyon | Açıklama |
|---|---|
| `setTD(idx, val)` | Tamamlama durumu butonlarını günceller, hidden input'a değeri yazar |
| `toggleKazanim(event, id)` | Kazanım seçilince tamamlama durumu butonlarını göster/gizler |
| `dersSave()` | Her kazanım satırı için `tamamlama_durumu` dahil `dersler`'e insert |

### 2.4 Öğrenci/Veli Dersler Paneli

Son 3 ders özet kart formatında gösterilir: tarih, konu, kazanımlar, tamamlama durumu rozeti, sorun alanı notu.

---

## 3. Konu Bazlı Zaman Serisi ve Proaktif Uyarı Sistemi

### 3.1 Veri Kaynağı

`odevler` tablosundaki `durum = 'TAMAMLANDI'` kayıtlar konu bazında gruplandırılır. Her ödev için:

```javascript
{
  tarih: o.tarih,
  dogru_yuzde:  Math.round(dogru / toplam * 100),
  yanlis_yuzde: Math.round(yanlis / toplam * 100),
  bos_yuzde:    Math.round(bos / toplam * 100)
}
```

### 3.2 Uyarı Tipleri

| Tip | Koşul | Renk |
|---|---|---|
| `kronik` | 3+ ödev, son 3 ödev ortalaması < %50 | 🔴 Kırmızı |
| `dusus` | 6+ ödev, son 3 ortalama önceki 3'ten ≥15 puan düşük | ⚠️ Turuncu |
| `dalgalanma` | 4+ ödev, son 4 ödevin standart sapması > 20 | 🟡 Sarı |
| `basarili` | 3+ ödev, son 3 ortalama ≥%75 ve std sapma < 10 | 🟢 Yeşil |

### 3.3 Yeni Supabase Tablosu — `konu_uyarilari`

```sql
CREATE TABLE konu_uyarilari (
  uyari_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ogrenci_id        TEXT NOT NULL REFERENCES ogrenciler(ogrenci_id) ON DELETE CASCADE,
  konu              TEXT NOT NULL,
  uyari_tipi        TEXT NOT NULL CHECK (uyari_tipi IN ('dusus','kronik','dalgalanma','basarili')),
  uyari_tarihi      DATE NOT NULL DEFAULT CURRENT_DATE,
  tetikleyen_deger  NUMERIC,
  ogretmen_notu     TEXT,
  aksiyon_tarihi    DATE,
  durum             TEXT NOT NULL DEFAULT 'acik'
                    CHECK (durum IN ('acik','aksiyon_alindi','cozuldu','kronik_tekrar'))
);

ALTER TABLE konu_uyarilari ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_konu_uyarilari" ON konu_uyarilari
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

### 3.4 Uyarı Akışı (DB Upsert Mantığı)

`loadRapor()` her çağrıldığında:

1. Her konu için `analizEt()` çalışır
2. `konu_uyarilari` tablosundan mevcut uyarılar çekilir
3. Yeni tespit edilen uyarı için `acik` kayıt yoksa insert yapılır
   - Daha önce `aksiyon_alindi` varsa `kronik_tekrar` olarak insert edilir
4. `basarili` veya `null` sonuç gelirse `acik` uyarı `cozuldu` olarak güncellenir

### 3.5 Panel Görünürlüğü

| Özellik | Öğretmen | Öğrenci | Veli |
|---|---|---|---|
| Konu listesi | ✅ | ✅ | ✅ |
| Çizgi grafik (D/Y/B) | ✅ | ✅ | ✅ |
| Uyarı rozetleri | ✅ | ❌ | ❌ |
| Uyarı mesajı | ✅ | ❌ | ❌ |
| Aksiyon notu UI | ✅ | ❌ | ❌ |
| Kronikleşme mesajı | ✅ | ❌ | ❌ |

### 3.6 Öğretmen Rapor Paneli

- Konu listesi `lg:col-span-2`, grafik paneli `lg:col-span-3`
- Her konu butonunun yanında uyarı rozeti
- Grafik üzerinde D/Y/B toggle butonları (`toggleKonuLine`)
- Aksiyon notu textarea + "Aksiyon Alındı" butonu

### 3.7 Global State Değişkenleri

| Değişken | İçerik |
|---|---|
| `window._raporData` | `{ ogrenciId, konuOdevler, uyariSonuclari, uyarilar, _chart, _activeKonu }` |
| `window._ogrKonuData` | `{ konuOdevler, _chart, _pfx: 'sl' }` |
| `window._veliKonuData` | `{ konuOdevler, _chart, _pfx: 'vl', _idPrefix }` |

### 3.8 Yeni Fonksiyonlar

| Fonksiyon | Açıklama |
|---|---|
| `standardSapma(arr)` | Standart sapma hesabı |
| `analizEt(gecmis)` | Konu ödev geçmişini analiz eder, uyarı tipi döner |
| `uyariRozetHtml(tip)` | Renk kodlu rozet HTML döner |
| `acKonuGrafigi(konu)` | Öğretmen rapor panelinde grafik açar (uyarı + aksiyon UI ile) |
| `toggleKonuLine(line)` | Öğretmen grafiğinde D/Y/B çizgisini göster/gizle |
| `uyariAksiyonKaydet(uyariId)` | Öğretmen aksiyon notunu DB'ye yazar |
| `acOgrKonuGrafigi(konu)` | Öğrenci panelinde grafik açar |
| `acVeliKonuGrafigi(konu)` | Veli panelinde grafik açar |
| `_renderSimpleKonuChart(gecmis, konu, panelId, store, pfx)` | Öğrenci/veli için paylaşılan grafik renderer |
| `toggleSimpleLine(line, pfx)` | Öğrenci/veli grafiğinde D/Y/B çizgisini göster/gizle |

---

## 4. Teknik Notlar

- Chart.js 4.4.4 CDN üzerinden mevcut — yeni import gerekmedi
- `_renderSimpleKonuChart` öğrenci (`pfx='sl'`) ve veli (`pfx='vl'`) için `id` çakışmasını önler
- `store._pfx` alanı `toggleSimpleLine` fonksiyonunun doğru store'u bulmasını sağlar
- Tüm değişiklikler `scholar_metric.html` ve `www/index.html`'de eşzamanlı uygulandı

---

## 5. Commit Geçmişi (Bu Sürüm)

| Hash | Açıklama |
|---|---|
| `3707423` | Ders Programı: haftalık grid ve tüm JS fonksiyonları eklendi |
| `12be139` | Ders Kaydet: kazanım bazlı tamamlama durumu + sorun alanı eklendi |
| `3e4438f` | Konu bazlı zaman serisi + proaktif uyarı sistemi eklendi |

---

*AdaptiX BTS V3 — Öğrenci Takip Sistemi*
