# AdaptiX BTS V3 — Geliştirme Dokümanı

**Hazırlanma Tarihi:** 13 Haziran 2026  
**Son Güncelleme:** 28 Haziran 2026 (14.12–14.13 eklendi)  
**Sürüm:** BTS V2 → V3  
**Geliştirici:** Tayfun Hoca + Claude (Sonnet 4.6)  
**İlgili Dosyalar:** `scholar_metric.html`, `www/index.html`  
**GitHub Commit:** bkz. Bölüm 14

---

## Özet

Bu sürümde on altı büyük özellik / geliştirme eklendi:

1. **Ders Programı Modülü** — Haftalık seans grid görünümü
2. **Ders Kaydet İyileştirmeleri** — Kazanım bazlı tamamlama durumu + alan yeniden isimlendirme
3. **Konu Bazlı Zaman Serisi ve Proaktif Uyarı Sistemi** — Üç panelde konu grafikleri + öğretmene otomatik uyarılar
4. **Ders Kayıt Yönetimi** — Kaydedilmiş dersleri düzenleme ve silme
5. **Hızlı Navigasyon** — Dashboard kartı ve öğrenci listesinden doğrudan sayfa yönlendirme
6. **Rapor Ödev Analizi** — Rapor sayfasında ödev istatistik kartları ve filtrelenmiş liste
7. **Bekleyen Ödev Yönetim Modali** — Dashboard'dan tüm bekleyen ödevleri tek ekranda işleme
8. **Çok Veli Desteği** — Öğrenci başına birden fazla veli kaydı, ayrı `veliler` tablosu
9. **Öğrenci Ödev Sekmesi İyileştirmeleri** — Detay alanı, 7 gün filtresi, YAPILMADI/EKSİK bölümü, Bekleyen toggle kart
10. **Rapor Ödev Bölümü İyileştirmeleri** — BEKLİYOR kart, grid yeniden düzenleme, `odev_detay` sorgu fix
11. **Öğrenci Paneli Hedef Toggle** — Kaydet sonrası label görünümü, Düzenle ile geri dönüş
12. **Ada Bileşeni Düzeltmeleri** — Rol koruması, `#page-ada` görünürlük fix, localStorage key ayrımı
13. **Ödev Sekmeleri ve Düzenleme** — Öğrenci + öğretmen panelinde Bekleyenler/Tamamlananlar/Tümü sekmeleri; tamamlanan ödevlerde inline Düzenle formu
14. **AdaptiX Platform Yönetim Paneli** — `rol='adaptix'` ile giriş yapan platform yöneticisi için ayrı panel: öğretmen ekleme/yönetim, fatura oluşturma/takip, genel bakış dashboard'u
15. **Çok Öğretmen Desteği** — `ogretmen_id` şema değişikliği, 7 tabloda sorgu izolasyonu, session yönetimi
16. **Ada AI Koç Entegrasyonu** — Anthropic API, 7 tool tanımı, WhatsApp veli mesajı, API key Supabase'de saklama

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

## 4. Ders Kayıt Yönetimi (Düzenle / Sil)

### 4.1 Genel Akış

Öğretmen, ders kaydettikten sonra "Kayıtlı Dersler" bölümünden geçmiş dersleri düzenleyebilir veya silebilir. Şema değişikliği gerekmez; mevcut `tarih + ogrenci_id + islenen_konu` üçlüsü oturum anahtarı olarak kullanılır.

### 4.2 UI Değişiklikleri

- **"Kayıtlı Dersler" bölümü** — Ders Kaydet sayfasında, form kartının altına eklendi. Öğrenci seçildiğinde otomatik yüklenir; ders sayısı rozet olarak gösterilir.
- Her ders kartında **Düzenle** ve **Sil** butonu bulunur.
- **Ders Tarihi** input alanı — Form'a eklendi. Bugünün tarihi varsayılan; değiştirilebilir. Kaydet sonrasında bugüne sıfırlanır.

### 4.3 Sil Akışı

```
confirm() → sb.from('dersler').delete()
  .eq('ogrenci_id', id).eq('tarih', tarih).eq('islenen_konu', konu)
→ loadDersGecmisi()
```

### 4.4 Düzenle Akışı

1. Mevcut satırlar `kazanim_kodu, tamamlama_durumu, ders_gorusu, sonraki_ders_hatirlatma` ile çekilir
2. Konu select'e set edilir, `konuSecildi()` çağrılarak checkboxlar render edilir
3. İlgili kazanımlar işaretlenir, TD durumları restore edilir
4. Textarea'lar ve tarih alanı doldurulur
5. `state._dersEditSession = { ogrenciId, tarih, konu }` ile edit modu aktif edilir
6. Kaydet butonu "Dersi Güncelle" olarak güncellenir
7. **Kaydet:** eski satırlar silinir, yeni satırlar orijinal tarih üzerinden insert edilir

### 4.5 State Değişkenleri

| Değişken | Tip | Açıklama |
|---|---|---|
| `state._dersGecmisGruplar` | array | Gruplanan ders oturumları (index ile erişilir) |
| `state._dersEditSession` | object \| null | `{ ogrenciId, tarih, konu }` — edit modu |

### 4.6 Yeni Fonksiyonlar

| Fonksiyon | Açıklama |
|---|---|
| `loadDersGecmisi()` | Seçili öğrencinin derslerini çeker, gruplar, render eder |
| `dersSil(idx)` | Onay sonrası `_dersGecmisGruplar[idx]`'e karşılık gelen satırları siler |
| `dersDuzenleAc(idx)` | Formu mevcut ders verileriyle doldurur, edit modunu aktif eder |

### 4.7 `dersSave()` Güncelleme

Edit modunda `state._dersEditSession` dolu ise önce eski satırlar silinir, ardından form değerleriyle yeni satırlar orijinal tarih üzerinden insert edilir. Edit modu temizlenir, buton metni "Dersi Kaydet"e döner.

---

## 5. Hızlı Navigasyon İyileştirmeleri

### 5.1 Dashboard → Öğrenciler

Anasayfadaki **Öğrenci** stat kartına `onclick="goPage('ogrenciler')"` ve `cursor:pointer` eklendi.

### 5.2 Öğrenciler Listesi → Rapor

`renderOgrenciler()` fonksiyonunda her satırın sol kısmı (avatar + ad/sınıf) tıklanabilir `div`'e alındı:

```javascript
onclick="goRaporFor('${o.ogrenci_id}')"
```

Sağdaki **✏️ Düzenle** butonu etkilenmedi. `goRaporFor(id)` fonksiyonu zaten mevcuttu; `rapor-ogrenci` select'ini set edip `loadRapor()` çağırır.

---

## 6. Rapor Ödev Analizi

### 6.1 Genel

Rapor sayfasında "Ders Akışı" bölümünün altına "Ödevler" başlıklı bir analiz bölümü eklendi.

### 6.2 İstatistik Kartları

| Kart | Renk | Tıklanabilir |
|---|---|---|
| Toplam | Gri | — |
| Tamamlanan | Yeşil (#00661d) | ✅ — liste toggle |
| Yapılmadı | Kırmızı (#ba1a1a) | ✅ — liste toggle |
| Eksik | Turuncu (#805600) | ✅ — liste toggle |

### 6.3 Filtrelenmiş Ödev Listesi

Karta tıklayınca kartın altında o duruma ait ödevler açılır/kapanır. Kolonlar: **Gün | Kaynak | Konu | Durum**.

- `TAMAMLANDI` satırlarında `dogru/yanlis/bos/toplam` null değilse `D: X  Y: X  B: X  Top: X` gösterilir.
- Öğretmen rolünde her satırda **↺ Tekrar Ver** butonu: `goPage('odev')` çağırır, ödev formunu o ödevin kaynak/konu/kazanım verileriyle önceden doldurur.

### 6.4 `loadRapor()` Değişiklikleri

- `odevler` sorgusu artık tüm durumları çeker (durum filtresi kaldırıldı).
- `tamamlananOdevler = tumOdevler.filter(o => o.durum === 'TAMAMLANDI')` — konu analizi bu alt küme üzerinden çalışır.
- `select('*')` yerine explicit sütun listesi: `odev_id, ogrenci_id, gun, kaynak, konu, kazanim, durum, verilis_tarihi, dogru, yanlis, bos, toplam` — gelecekteki şema değişikliklerine karşı güvenli.
- Hata durumunda `console.error` ile loglama eklendi.
- `window._raporData`'ya `tumOdevler` ve `_rol` alanları eklendi.

### 6.5 Yeni Fonksiyonlar

| Fonksiyon | Açıklama |
|---|---|
| `toggleRaporOdevFiltre(durum)` | Seçili duruma göre listeyi render eder, toggle açar/kapar |
| `raporTekrarVerByIdx(i)` | `_raporOdevFiltreListesi[i]`'den veriyi alıp `raporTekrarVer` çağırır |
| `raporTekrarVer(ogrenciId, kaynak, konu, kazanim)` | Ödev Gir sayfasına geçer ve formu önceden doldurur |

---

## 7. Bekleyen Ödev Yönetim Modali

### 7.1 Giriş Noktası

Dashboard'daki **Bekleyen Ödev** stat kartına `onclick="acBekleyenModal()"` ve `cursor:pointer` eklendi. Sadece `ogretmen` rolünde çalışır.

### 7.2 Modal Yapısı

`fixed inset-0 z-50` tam ekran overlay, `max-w-2xl` iç kart, `max-h-[90vh] overflow-y-auto` kaydırılabilir liste. Başlıkta anlık sayaç (`id="bm-sayac"`).

### 7.3 Veri Sorgusu

```js
sb.from('odevler').select('*')
  .eq('durum', 'BEKLİYOR')
  .order('verilis_tarihi', { ascending: true })  // eskiden yeniye
```

`state.ogrenciler` map'i üzerinden `ogrenci_id → ad_soyad` çözümlenir.

### 7.4 Satır Eylemleri

| Buton | Davranış |
|---|---|
| ✓ Yapıldı | Satır içi D/Y/B/Toplam alanları açılır; Doğru inputuna odaklanılır |
| Kaydet | `durum='TAMAMLANDI'`, D/Y/B/Toplam güncellenir; satır listeden kalkar |
| Eksik | `durum='EKSİK'`; satır anında kalkar |
| Yapılmadı | `durum='YAPILMADI'`; satır anında kalkar |

Kaydet toast'ı yüzde doğru oranını gösterir (`%73 doğru`). Tüm satırlar işlenince `🎉 Tüm ödevler işlendi!` mesajı çıkar.

### 7.5 Sayaç Senkronizasyonu

`bmSayacGuncelle()` hem modal başlığındaki `bm-sayac`'ı hem dashboard'daki `stat-bekleyen`'i günceller.

### 7.6 Yeni Fonksiyonlar

| Fonksiyon | Açıklama |
|---|---|
| `acBekleyenModal()` | Modali açar, DB'den bekleyen ödevleri çeker, listeler |
| `bekleyenModalYapildi(id)` | D/Y/B panelini toggle eder, Doğru inputuna focus verir |
| `bekleyenModalDurumGuncelle(id, durum)` | EKSİK/YAPILMADI günceller, satırı kaldırır |
| `bekleyenModalDybKaydet(id)` | D/Y/B değerleriyle TAMAMLANDI kaydeder, satırı kaldırır |
| `bmSayacGuncelle()` | Modal ve dashboard sayaçlarını DOM'dan sayarak günceller |

---

## 8. Çok Veli Desteği

### 8.1 Genel

Bir öğrenciye birden fazla veli (anne, baba, vasi, diğer) eklenebilmesi için ayrı `veliler` tablosu oluşturuldu. `ogrenciler` tablosundaki eski `veli_ad_soyad` ve `veli_telefon` sütunları silinmedi — geçiş dönemi için fallback olarak korunmaktadır.

### 8.2 Veritabanı Değişikliği

```sql
CREATE TABLE veliler (
  veli_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ogrenci_id TEXT NOT NULL REFERENCES ogrenciler(ogrenci_id) ON DELETE CASCADE,
  veli_adi   TEXT NOT NULL,
  telefon    TEXT NOT NULL,
  yakinlik   TEXT  -- 'Anne', 'Baba', 'Vasi', 'Diğer'
);

-- Mevcut velileri taşı
INSERT INTO veliler (ogrenci_id, veli_adi, telefon, yakinlik)
SELECT ogrenci_id, veli_ad_soyad, veli_telefon, 'Anne/Baba'
FROM ogrenciler
WHERE veli_telefon IS NOT NULL AND veli_telefon != '';
```

`ON DELETE CASCADE` sayesinde öğrenci silindiğinde veliler otomatik silinir.

### 8.3 UI — Dinamik Veli Satırları

**Yeni Öğrenci Formu** ve **Düzenle Modali** içinde sabit veli alanları kaldırılarak dinamik satır sistemi eklendi:

- Başlangıçta 1 satır: `[Yakınlık dropdown] [Veli Adı] [Telefon] [✕ Sil]`
- **+ Veli Ekle** butonu ile yeni satır eklenir (maksimum 3)
- En az 1 geçerli veli zorunlu; kaydet öncesi validasyon yapılır
- Düzenleme modalinde veliler `veliler` tablosundan async yüklenir; kayıt yoksa eski sütunlardan fallback

### 8.4 Veli Girişi Değişikliği

```javascript
// Eski — ogrenciler.veli_telefon taraması
const { data: tumVeli } = await sb.from('ogrenciler').select('ogrenci_id, veli_telefon, ad_soyad');
const veliOgr = tumVeli.find(o => o.veli_telefon === tel);

// Yeni — veliler tablosu JOIN
const { data: veliKayit } = await sb.from('veliler')
  .select('*, ogrenciler(*)')
  .eq('telefon', tel)
  .limit(1);
const ogr = veliKayit[0].ogrenciler;
```

Aynı telefon birden fazla öğrenciye atanmışsa (örn. iki kardeşin velisi) ilk eşleşen öğrencinin paneli açılır.

### 8.5 Kayıt Akışı

| İşlem | Öğrenci | Veliler |
|---|---|---|
| Yeni kayıt | `ogrenciler` INSERT | `veliler` INSERT (liste) |
| Düzenleme | `ogrenciler` UPDATE | `veliler` DELETE + INSERT |
| Silme | `ogrenciler` DELETE | CASCADE ile otomatik |

### 8.6 Yeni Fonksiyonlar

| Fonksiyon | Açıklama |
|---|---|
| `veliSatirHTML(yakinlik, adi, tel)` | Tek veli satırı HTML'i döner (seçili yakınlık ile) |
| `veliSatirEkle(containerId)` | Container'a yeni satır ekler (max 3 kontrolü) |
| `veliSatirSil(btn)` | Tıklanan satırı kaldırır (min 1 kontrolü) |
| `getVeliFormData(containerId)` | Container'dan veli verilerini dizi olarak okur (boş filtrelenir) |

---

## 9. Öğrenci Ödev Sekmesi İyileştirmeleri

### 9.1 Değişiklikler

| # | Değişiklik | Detay |
|---|---|---|
| 1 | **Detay alanı** | Bekleyen, tamamlanan ve yapılmayan bölümlerinde kaynak adının altında `odev_detay` ayrı satırda gösterilir (null/boş kontrolü ile) |
| 2 | **7 gün filtresi** | `TAMAMLANDI` ödevler son 7 güne filtrelendi; tarih için `verilis_tarihi \|\| created_at` kullanılır |
| 3 | **YAPILMADI/EKSİK bölümü** | Yeni `ogr-yapilmayan-bolum` div'i eklendi; bu statüdeki ödevler herhangi bir tarih filtresi uygulanmadan listelenir; her satırda **↺ Tekrar Ver** butonu |
| 4 | **Bekleyen toggle kart** | `ogr-stat-bekleyen` stat kartı primary (#005d8d) renge getirildi, tıklanınca `bekleyen-toggle-liste` div'i açılır/kapanır; liste basit (konu + gün + kaynak + detay), D/Y/B form yok |

### 9.2 Tekrar Ver (Öğrenci)

`ogrTekrarVer(odevId)` fonksiyonu: YAPILMADI/EKSİK ödev için `durum = 'BEKLİYOR'`, D/Y/B alanları `null` olarak güncellenir → panel yenilenir.

### 9.3 Yeni Fonksiyonlar

| Fonksiyon | Açıklama |
|---|---|
| `toggleBekleyenListe()` | `bekleyen-toggle-liste` div'ini toggle eder |
| `ogrTekrarVer(odevId)` | Ödev statüsünü BEKLİYOR'a sıfırlar, paneli yeniler |

---

## 10. Rapor Ödev Bölümü İyileştirmeleri

### 10.1 BEKLİYOR Kart Eklendi

`odevBekleyenSayi` değişkeni hesaplanarak istatistik grid'ine eklendi.

**Yeni kart sırası (2 sütun grid):**
```
[ Bekleyen  #005d8d ]  [ Toplam          ]
[ Tamamlanan        ]  [ Yapılmadı       ]
[ Eksik             ]
```

BEKLİYOR karta tıklayınca `toggleRaporOdevFiltre('BEKLİYOR')` çalışır. `durumBadge` map'e `BEKLİYOR: ['#e8f4fb','#005d8d']` eklendi.

### 10.2 `odev_detay` Sorgu Fix

`loadRapor()` içindeki `odevler` explicit SELECT listesinden `odev_detay` sütunu eksikti — rapor toggle tablosunda detay her zaman `undefined` geliyordu. Sütun listeye eklendi:

```javascript
// Düzeltilmiş sorgu
sb.from('odevler').select(
  'odev_id,ogrenci_id,gun,kaynak,konu,kazanim,durum,verilis_tarihi,dogru,yanlis,bos,toplam,odev_detay'
)
```

### 10.3 Toggle Tablo Kaynak Hücresi

`toggleRaporOdevFiltre` tablosunun Kaynak sütununda detay alanı `trim()` kontrolüyle eklendi:

```javascript
${o.odev_detay && o.odev_detay.trim()
  ? `<div style="font-size:10px;opacity:.7;">${o.odev_detay.trim()}</div>`
  : ''}
```

### 10.4 Detay Trim Fix (Genel)

Taslak listesi ve bekleyen ödev listesindeki detay kontrolü truthy → `trim() !== ''` kontrolüne güncellendi (whitespace-only string'lerde boş bullet görünümü giderildi).

---

## 11. Öğrenci Paneli Hedef Toggle

### 11.1 Genel

Öğrenci panelindeki "Hedefim" kartı daha önce her zaman textarea + Kaydet butonu gösteriyordu. Yeni davranış: hedef kaydedilince textarea yerine düz metin label gösterilir, Düzenle butonu ile geri dönülür.

### 11.2 HTML Yapısı

Tek `<textarea>` yerine iki `<div>` bloğu:

| Div | Görünürlük | İçerik |
|---|---|---|
| `#hedef-edit-mode` | Hedef boşsa veya düzenleme modunda | `<textarea>` + Kaydet butonu |
| `#hedef-view-mode` | Hedef kaydedilince | `<p id="ogr-hedef-label">` + Düzenle butonu |

Her iki bloka `transition: opacity .2s` eklendi.

### 11.3 Davranış Akışı

```
[Boş hedef] → edit-mode görünür
    ↓ Kaydet
[Hedef dolu] → view-mode görünür, label metni güncellenir
    ↓ Düzenle
[edit-mode] → textarea içinde mevcut metin, otomatik focus
```

### 11.4 Değiştirilen / Eklenen Fonksiyonlar

| Fonksiyon | Değişiklik |
|---|---|
| `hedefYukle()` | Hedef varsa view-mode, yoksa edit-mode gösterir |
| `hedefKaydet()` | Kayıt başarılıysa ve hedef doluysa view-mode'a geçer |
| `hedefDuzenle()` | **Yeni.** textarea'ya mevcut metni yükler, edit-mode'a geçer, focus verir |

### 11.5 localStorage Key

Değiştirilmedi. `state.user.hedef` Supabase `ogrenciler` tablosuna yazılır, oturum `adaptix_session` key'inde tutulur.

---

## 12. Ada Bileşeni Düzeltmeleri

### 12.1 `#page-ada` Görünürlük Fix

`#page-ada` div'inin inline `style` attribute'unda `display:flex;` bulunuyordu. Bu, `.page { display: none; }` CSS kuralını ezerek Ada'nın tüm sayfalarda render edilmesine neden oluyordu.

**Düzeltme:** Inline `display:flex;` kaldırıldı. Görünürlük tamamen CSS ile yönetiliyor:

```css
.page          { display: none; }          /* default gizli */
.page.active   { display: block; }         /* aktif sayfa */
#page-ada.active { display: flex !important; } /* Ada: flex layout */
```

### 12.2 Rol Koruması — `goPage()`

`goPage()` fonksiyonunun başına guard eklendi:

```javascript
function goPage(id) {
  if (id === 'ada' && state.rol !== 'ogretmen') return;
  // ...
}
```

`buildNav()` zaten Ada'yı yalnızca `ogretmen` pages dizisine ekliyordu; bu guard programatik erişimi de engeller.

### 12.3 localStorage Key Ayrımı

Ada konuşma geçmişi için localStorage key'i role göre ayrıldı:

| Rol | Eski Key | Yeni Key |
|---|---|---|
| `ogretmen` | `adaptix_ada_genel` / `adaptix_ada_<id>` | `adaptix_ada_ogretmen_genel` / `adaptix_ada_ogretmen_<id>` |
| `ogrenci` / `veli` | (erişim yoktu) | (erişim yok — guard ile engellendi) |

**Migration:** `adaGetConv()` ilk çalışmada eski key varsa ve yeni key yoksa veriyi otomatik taşır, eski key'i siler. Mevcut öğretmen sohbet geçmişi korunur.

### 12.4 Değiştirilen Fonksiyonlar

| Fonksiyon | Değişiklik |
|---|---|
| `adaGetConv(selId)` | `state.rol !== 'ogretmen'` ise `[]` döner; yeni key okur; eski key'den migration |
| `adaSaveConv(selId)` | `state.rol !== 'ogretmen'` ise no-op; yeni key'e yazar |
| `adaTemizle()` | `state.rol !== 'ogretmen'` ise no-op; yeni key'i siler |

---

## 13. Ödev Sekmeleri ve Düzenleme

### 13.1 Sorun

Öğrenci panelindeki Ödevler sekmesi yalnızca `durum = 'BEKLİYOR'` ödevleri gösteriyordu. Öğrenci bir ödevi tamamladığında ödev liste dışına çıkıyor, artık düzenlenemiyordu. Öğretmen Ödev Gir sayfasında da tamamlanan ödevler görünmüyordu.

### 13.2 Öğrenci Paneli — Ödevler Sekmesi

**HTML Değişikliği:**

İstatistik kartlarının altına üç alt sekme eklendi. Eski tek-bölüm yapısı (`ogr-bekleyen-bolum`, `ogr-yapilmayan-bolum`, `ogr-tamamlanan-bolum`) şu yapıya dönüştürüldü:

```html
<div class="tabbar">
  <button onclick="ogrOdevSubTab('bekleyen')"   id="ogr-sub-tab-bekleyen"   class="tab active">⏳ Bekleyenler</button>
  <button onclick="ogrOdevSubTab('tamamlanan')" id="ogr-sub-tab-tamamlanan" class="tab">✅ Tamamlananlar</button>
  <button onclick="ogrOdevSubTab('tumsi')"      id="ogr-sub-tab-tumsi"      class="tab">📋 Tümü</button>
</div>
<div id="ogr-sub-bekleyen">   <div id="ogr-bekleyen-bolum"></div>   </div>
<div id="ogr-sub-tamamlanan" class="hidden"> <div id="ogr-tamamlanan-bolum"></div> </div>
<div id="ogr-sub-tumsi"      class="hidden"> <div id="ogr-tumsi-bolum"></div>      </div>
```

`ogr-yapilmayan-bolum` kaldırıldı — EKSİK/YAPILMADI ödevler artık Tamamlananlar sekmesinde gösterilir.

**Sekme İçerikleri:**

| Sekme | Filtre | Özellik |
|---|---|---|
| Bekleyenler | `durum = 'BEKLİYOR'` | Mevcut D/Y/B giriş formu korunur |
| Tamamlananlar | `TAMAMLANDI \| EKSİK \| YAPILMADI` | Her kartta ✏️ Düzenle butonu |
| Tümü | Tüm ödevler | Salt okunur kompakt liste |

**`loadOgrenciPanel()` Değişiklikleri:**

- Tüm ödevler tek sorguda çekilir (durum filtresi yok), `verilis_tarihi DESC` sıralı
- `bekleyen` = BEKLİYOR, `tamamlananlar` = diğer üçü, stat sayıları buna göre güncellenir
- Tamamlananlar kartında durum, renk ve D/Y/B bilgisi inline gösterilir
- 7 günlük tarih filtresi kaldırıldı — tüm tamamlananlar listelenir

**Tamamlananlar Düzenle Formu:**

Her ödev kartında **✏️ Düzenle** butonuna tıklayınca inline açılan form:

```
[ Durum dropdown: TAMAMLANDI / EKSİK / YAPILMADI ]
[ D | Y | B | Toplam ]  ← yalnızca TAMAMLANDI seçiliyken görünür
[ İptal ]  [ Kaydet ]
```

`Kaydet` → `sb.from('odevler').update(...)` `.eq('odev_id', odevId).eq('ogrenci_id', state.user.ogrenci_id)` ile güncellenir, liste yenilenir.

### 13.3 Öğretmen Paneli — Ödev Gir Sayfası

**`loadBekleyenOdevlerForOgrenci()` Değişikliği:**

Eski: Yalnızca `['BEKLİYOR','EKSİK','YAPILMADI']` durumlarını çekiyordu, limit 20.  
Yeni: Filtre ve limit kaldırıldı — tüm ödevler çekilir.

İki ayrı bölüm olarak render edilir:

| Bölüm | Filtre | Eylemler |
|---|---|---|
| ⏳ Bekleyenler | `durum = 'BEKLİYOR'` | Yapıldı / Eksik / Yapılmadı / Sonuç Gir (mevcut butonlar) |
| ✅ Tamamlananlar | `TAMAMLANDI \| EKSİK \| YAPILMADI` | ✏️ Düzenle (inline form) |

Öğrenciye hiç ödev atanmamışsa "Bu öğrenciye henüz ödev atanmamış" mesajı gösterilir.

### 13.4 Renk Sistemi

| Durum | Arka Plan | Metin |
|---|---|---|
| BEKLİYOR | `#e8f4fb` | `#005d8d` |
| TAMAMLANDI ≥%80 | `rgba(0,130,40,0.12)` | `#00661d` |
| TAMAMLANDI %60–79 | `rgba(254,178,35,0.2)` | `#805600` |
| TAMAMLANDI <%60 / EKSİK / YAPILMADI | `rgba(186,26,26,0.1)` | `#ba1a1a` |

### 13.5 Yeni Fonksiyonlar

**Öğrenci Paneli:**

| Fonksiyon | Açıklama |
|---|---|
| `ogrOdevSubTab(tab)` | Alt sekmeyi değiştirir; container ve buton class'larını toggle eder |
| `ogrOdevDuzenleToggle(odevId)` | `ogr-duzenle-form-<id>` div'ini açar/kapar |
| `ogrOdevDurumInputToggle(odevId)` | Durum dropdown değişince D/Y/B alanlarını göster/gizle |
| `ogrOdevDuzenleKaydet(odevId)` | UPDATE + `ogrenci_id` koruması + panel yenile |

**Öğretmen Paneli:**

| Fonksiyon | Açıklama |
|---|---|
| `ogretmenOdevDuzenleToggle(odevId)` | `ogr-ogr-form-<id>` div'ini açar/kapar |
| `ogretmenOdevDurumInputToggle(odevId)` | Durum dropdown değişince D/Y/B alanlarını göster/gizle |
| `ogretmenOdevDuzenleKaydet(odevId)` | UPDATE sadece `odev_id` ile + `loadBekleyenOdevlerForOgrenci` yenile |

### 13.6 Teknik Notlar

- `ogr-yapilmayan-bolum` div'i ve `ogrTekrarVer()` çağrısı kaldırılmadı — `ogrTekrarVer()` hâlâ çalışabilir (manuel çağrı veya gelecek kullanım için); sadece otomatik render artık yoktur
- Öğrenci Düzenle formu `ogrenci_id` ile kısıtlanır → başka öğrencinin ödevi güncellenemez
- Öğretmen Düzenle formu yalnızca `odev_id` ile günceller — `ogretmen_id` filtresi `loadBekleyenOdevlerForOgrenci` sorgusunda zaten uygulanmış

---

## 14. AdaptiX Platform Yönetim Paneli

### 14.1 Genel

`kullanicilar` tablosunda `rol='adaptix'` olan kullanıcı giriş yaptığında öğretmen paneli yerine ayrı bir yönetim paneline (`page-adaptix`) yönlendirilir. Bu panel hiçbir `ogretmen_id` filtresi uygulamaz; tüm öğretmen, öğrenci ve fatura verilerini görür.

### 14.2 Giriş Akışı

`doLogin()` içinde `kullanicilar.rol` kontrolü:

```javascript
if (kullanici.rol === 'adaptix') {
  state.rol  = 'adaptix';
  state.user = { ad: 'AdaptiX', rol: 'adaptix' };
  initApp();   // → goPage('adaptix') + loadAdaptixDashboard()
  return;
}
```

`goPage()` güvenlik guard'ı — adaptix rolü yalnızca kendi sayfasına erişebilir:

```javascript
if (state.rol === 'adaptix' && id !== 'adaptix') return;
```

### 14.3 Panel Yapısı

Dört alt sekme (tabbar):

| Sekme | İçerik |
|---|---|
| **Genel Bakış** | 6 istatistik kartı + öğretmen özet listesi |
| **Öğretmenler** | Tablo: ad, email, öğrenci sayısı, durum, işlemler |
| **Faturalar** | Tablo + filtre (Tümü / Bekleyen / Ödenen) + fatura oluştur |
| **Öğretmen Detay** | Tıklanan öğretmenin öğrencileri, son dersler, fatura geçmişi |

### 14.4 Genel Bakış Dashboard

`loadAdaptixDashboard()` paralel 4 sorgu ile şu istatistikleri hesaplar:

| Kart | Kaynak |
|---|---|
| Aktif Öğretmen | `ogretmenler.durum='aktif'` sayısı |
| Toplam Öğrenci | `ogrenciler` tüm kayıtlar |
| Bu Ay Ders | `dersler.tarih >= ayBaşı` |
| Bekleyen Fatura | `faturalar.durum != 'odendi'` adet + toplam tutar |
| Tahsil Edilen | `faturalar.durum='odendi'` toplam tutar |
| Dönem | Aktif ay/yıl bilgisi |

### 14.5 Öğretmen Yönetimi

**Liste:** `loadAdaptixOgretmenler()` — öğrenci sayısı ve bekleyen fatura adedi her öğretmen için hesaplanır.

**Yeni Öğretmen Ekleme Akışı:**

1. Modal açılır (ad, email, telefon, şifre)
2. `ogretmenler` tablosuna INSERT (`durum: 'aktif'`)
3. `hashSifre()` ile SHA-256 şifre hash'i üretilir
4. `kullanicilar` tablosuna INSERT (`rol: 'ogretmen'`, `sifre_hash`, `deger: ogretmen_id`)

**Düzenleme:** ad/email/telefon güncellenir; şifre değiştirilmez (güvenlik).

**Durum Toggle:** `adaptixToggleDurum()` — aktif/pasif geçişi, tek tıkla.

### 14.6 Fatura Yönetimi

**Fatura Oluştur (`adaptixFaturaOlustur`):**

- Aktif tüm öğretmenler için mevcut ay başı tarihi (`donem`) ile kontrol yapılır
- Bu dönem için faturası olmayan öğretmenlere INSERT yapılır (duplicate korunur)
- `tutar` başlangıçta `0` — sonradan manuel düzenlenebilir
- `ogrenci_sayisi` alanı öğrenciler tablosundan hesaplanır

**Ödendi İşaretle (`adaptixFaturaOdendi`):**

```javascript
{ durum: 'odendi', odeme_tarihi: bugün }
```

**Not Ekleme:** Modal ile `faturalar.notlar` sütununa yazılır; tablo satırında `📝 Not` butonu mevcuttur.

**Filtreler:** Tümü / Bekleyen / Ödenen — sadece render filtresi, DB sorgusu yenilenmez.

### 14.7 Öğretmen Detay Görünümü

`adaptixOgretmenDetay(ogretmenId)` — paralel 3 sorgu:

- `ogrenciler` — ad, sınıf, kayıt tarihi
- `dersler` — son 10 ders (konu + öğrenci adı)
- `faturalar` — tüm fatura geçmişi (dönem + tutar + durum)

### 14.8 Tasarım

- Header: `linear-gradient(135deg, #005d8d, #013149)` — öğretmen panel header'ından farklı
- Stat kartları: `rounded-2xl`, renk kodlu (mavi, yeşil, turuncu, kırmızı)
- Tablolar: scrollable, border-collapse, `surface-container` thead
- Durum rozetleri: aktif → yeşil (`rgba(0,130,40,0.12)`), pasif → kırmızı

### 14.9 Güvenlik

| Kural | Uygulama |
|---|---|
| Adaptix kendi sayfasının dışına çıkamaz | `goPage()` guard |
| Öğretmen rolü adaptix paneline erişemez | `initApp()` rol dallanması |
| Şifre düzenleme modalda gizlenir | `sifre-grup` div'i düzenlemede `display:none` |
| ogrenci_id izolasyonu | Adaptix sorgularında kullanılmaz |

### 14.10 Kısıtlar

- Yeni Supabase tablosu oluşturulmadı — mevcut `ogretmenler`, `kullanicilar`, `faturalar` tabloları kullanıldı
- `www/index.html` (PWA/mobil) `scholar_metric.html` ile birebir senkronize — her iki dosyada da AdaptiX paneli mevcuttur

### 14.11 Yeni Fonksiyonlar

| Fonksiyon | Açıklama |
|---|---|
| `adaptixTab(tab)` | Alt sekme geçişi |
| `loadAdaptixDashboard()` | 6 stat kartı + öğretmen özet listesi |
| `loadAdaptixOgretmenler()` | Öğretmen tablosunu render eder |
| `adaptixToggleDurum(id, durum)` | Aktif/pasif toggle |
| `adaptixOgretmenModalAc(id?)` | Ekle/düzenle modalı açar |
| `adaptixOgretmenModalKapat()` | Modalı kapatır, state temizler |
| `adaptixOgretmenKaydet()` | ogretmenler + kullanicilar INSERT/UPDATE |
| `adaptixOgretmenDetay(id)` | Detay sekmesine geçer, 3 paralel sorgu ile doldurur |
| `adaptixFaturaFiltre(filtre)` | Render filtresini değiştirir |
| `loadAdaptixFaturalar()` | DB'den fatura ve öğretmen listesini çeker |
| `renderAdaptixFaturalar()` | Mevcut filtre ile tabloyu render eder |
| `adaptixFaturaOlustur()` | Aktif öğretmenler için ay faturası (duplicate korumalı) |
| `adaptixFaturaOdendi(id)` | Ödendi + ödeme tarihi günceller |
| `adaptixNotModalAc(id, not)` | Not modalını açar |
| `adaptixNotModalKapat()` | Not modalını kapatır |
| `adaptixNotKaydet()` | `faturalar.notlar` günceller |
| `adaptixOgretmenSil(id)` | Pasif öğretmeni ve tüm alt verilerini kalıcı siler |

### 14.12 Öğretmen Silme

**Kural:** Sadece `durum='pasif'` olan öğretmenler silinebilir; önce pasife al, sonra sil adımı zorunludur. Tayfun Hoca'nın sabit UUID'si (`b373a4e6-01b1-4131-99d4-a2deae98b1ea`) için Sil butonu hiç gösterilmez.

**Silme akışı (`adaptixOgretmenSil`):**

1. `confirm()` onayı alınır
2. `ogrenciler` tablosundan `ogrenci_id` listesi çekilir
3. Öğrencilere ait tüm veriler sırayla silinir:
   `ders_programi` → `ogrn_kaynak` → `konu_uyarilari` → `denemeler` → `odevler` → `dersler` → `ogrenciler`
4. `kullanicilar.deger = ogretmenId` kaydı silinir
5. `ogretmenler` kaydı silinir
6. `loadAdaptixOgretmenler()` ile liste yenilenir

**UI:** Öğretmen tablosunda her pasif satırın işlem sütununa kırmızı `🗑 Sil` butonu eklendi (`background:rgba(186,26,26,0.1); color:#ba1a1a`).

### 14.13 Düzeltmeler

| Sorun | Çözüm |
|---|---|
| `loadOgrenciPanel()` fonksiyonu kapanmamış `}` — tarayıcıda "Unexpected end of input" | `else` bloğunun kapandığı satırdan sonra `}` eklendi (fonksiyon gövdesi kapatıldı) |
| `kullanicilar` INSERT — "duplicate key violates unique constraint" hatası | `.insert({...}, { returning: 'minimal' })` ile Supabase cached schema bypass edildi; `console.error` ile tam hata logu eklendi |
| Öğretmen ekleme modali şeffaf görünüyor | Modal iç div'inin `background:var(--surface)` değeri `background:#fff` ile sabitlendi |

---


## 15. Çok Öğretmen Desteği

### 15.1 Veritabanı Değişiklikleri

```sql
-- Öğretmen profil tablosu
CREATE TABLE ogretmenler (
  ogretmen_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_soyad     TEXT NOT NULL,
  email        TEXT,
  telefon      TEXT,
  kayit_tarihi DATE DEFAULT CURRENT_DATE,
  durum        TEXT DEFAULT 'aktif'
);

-- Fatura tablosu
CREATE TABLE faturalar (
  fatura_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ogretmen_id      UUID NOT NULL REFERENCES ogretmenler(ogretmen_id),
  donem            DATE NOT NULL,
  ogrenci_sayisi   INT NOT NULL,
  birim_fiyat      NUMERIC DEFAULT 50,
  toplam_tutar     NUMERIC GENERATED ALWAYS AS (ogrenci_sayisi * birim_fiyat) STORED,
  durum            TEXT DEFAULT 'bekliyor',
  odeme_tarihi     DATE,
  notlar           TEXT,
  olusturma_tarihi TIMESTAMP DEFAULT NOW()
);

-- 7 tabloya ogretmen_id kolonu eklendi
ALTER TABLE ogrenciler ADD COLUMN IF NOT EXISTS ogretmen_id UUID;
ALTER TABLE dersler ADD COLUMN IF NOT EXISTS ogretmen_id UUID;
ALTER TABLE odevler ADD COLUMN IF NOT EXISTS ogretmen_id UUID;
ALTER TABLE denemeler ADD COLUMN IF NOT EXISTS ogretmen_id UUID;
ALTER TABLE konu_uyarilari ADD COLUMN IF NOT EXISTS ogretmen_id UUID;
ALTER TABLE ders_programi ADD COLUMN IF NOT EXISTS ogretmen_id UUID;
ALTER TABLE ogrn_kaynak ADD COLUMN IF NOT EXISTS ogretmen_id UUID;

-- Mevcut veriler Tayfun Hoca'ya bağlandı
UPDATE ogrenciler SET ogretmen_id = 'b373a4e6-01b1-4131-99d4-a2deae98b1ea';
-- (diğer 6 tablo aynı şekilde)

-- kullanicilar.deger alanı ogretmen_id taşımak için kullanıldı
-- rol='adaptix' kaydı eklendi
UPDATE kullanicilar SET rol = 'adaptix' WHERE rol = 'admin';
```

### 15.2 Giriş Akışı

`doLogin()` içinde şifre hash karşılaştırması sonrası:

```javascript
if (kullanici.rol === 'adaptix') {
  // AdaptiX yönetim paneline yönlendir
} else if (kullanici.rol === 'ogretmen') {
  // ogretmenler tablosundan profil çek (.single())
  // localStorage'a ogretmen_id ve ogretmen_adi kaydet
}
```

### 15.3 Sorgu İzolasyonu

| Tablo | SELECT | INSERT |
|---|---|---|
| ogrenciler | ✅ | ✅ |
| dersler | ✅ | ✅ |
| odevler | ✅ | ✅ |
| denemeler | ✅ | ✅ |
| konu_uyarilari | ✅ | ✅ |
| ders_programi | ✅ | ✅ |
| ogrn_kaynak | ✅ | ✅ |

Tüm sorgularda `_ogretmenId = localStorage.getItem('adaptix_ogretmen_id')` kullanılır.

### 15.4 Session Yönetimi

- `localStorage.adaptix_ogretmen_id` — UUID
- `localStorage.adaptix_ogretmen_adi` — ad soyad
- Çıkışta her ikisi de temizlenir
- Sol menüdeki sabit "Tayfun Hoca" yazısı `adaptix_ogretmen_adi`'nden okunur

---

## 16. Ada AI Koç Entegrasyonu

### 16.1 Genel

Ada, Anthropic API (claude-sonnet-4-6) üzerinde çalışan, BTS veritabanına bağlı öğrenci koç asistanı. Sadece `ogretmen` rolünde görünür.

### 16.2 API Key Yönetimi

API key `kullanicilar` tablosunda `rol='api_key'` satırının `deger` alanında saklanır:

```sql
INSERT INTO kullanicilar (rol, sifre_hash, deger)
VALUES ('api_key', 'n/a', 'sk-ant-api03-...');
```

Ada sayfası yüklendiğinde Supabase'den çekilir — kullanıcıdan key istenmez.

### 16.3 System Prompt

Ada'nın bilgi tabanı `adaptix_ai_system_prompt.md` dosyasında tanımlıdır:
- 5-8. sınıf MEB 2024 müfredatı ve işleniş sırası
- LGS 2018-2025 konu bazlı soru dağılımı (gerçek veriler)
- Yaygın öğrenme güçlükleri
- Özel ders pedagojisi, veli iletişimi, motivasyon/psikoloji

### 16.4 Tool Tanımları (7 adet)

| Tool | Açıklama |
|---|---|
| `get_ogrenci_ozet` | Ad, sınıf, okul, toplam ders/ödev/deneme |
| `get_son_dersler` | Son N ders — konu, kazanım, tamamlama durumu |
| `get_odev_analizi` | Konu bazlı D/Y/B ortalamaları, yapılmayan ödevler |
| `get_deneme_trendi` | Deneme sonuçları ve net trendi |
| `get_konu_uyarilari` | Aktif uyarılar — kronik, düşüş, dalgalanma |
| `get_ders_oncesi_brifing` | Tüm verileri tek sorguda birleştiren paket |
| `get_mufredat_detay` | MEB 2024 müfredatından konu/kazanım detayı |

### 16.5 WhatsApp Entegrasyonu

Ada veli mesajı ürettiğinde mesaj balonunun altında "📱 WhatsApp'ta Gönder" butonu çıkar:

```javascript
function formatWhatsappNo(tel) {
  let clean = tel.replace(/\D/g, '');
  if (clean.startsWith('0')) clean = '9' + clean;
  if (!clean.startsWith('90')) clean = '90' + clean;
  return clean;
}

function whatsappGonder(mesaj, telefon) {
  const no = formatWhatsappNo(telefon);
  window.open(`https://wa.me/${no}?text=${encodeURIComponent(mesaj)}`, '_blank');
}
```

Veli telefonu `veliler` tablosundan seçili öğrenciye göre çekilir. Birden fazla veli varsa seçim yaptırılır.

### 16.6 Ada Görseli

`public/ai_simge.png` — tüm robot/bot ikonlarının yerini aldı:
- Sol menü: 22px
- Chatbox üst kart: 38px
- Karşılama ekranı: 80px
- Mesaj baloncuğu: 30px

### 16.7 Kısıtlar

- Ada sadece `ogretmen` rolünde görünür
- Sohbet geçmişi `localStorage.ada_messages_ogretmen` key'inde saklanır
- Veli/öğrenci panelinde Ada bileşeni display:none ile gizlenir

---

## 17. Teknik Notlar

- Chart.js 4.4.4 CDN üzerinden mevcut — yeni import gerekmedi
- `_renderSimpleKonuChart` öğrenci (`pfx='sl'`) ve veli (`pfx='vl'`) için `id` çakışmasını önler
- `store._pfx` alanı `toggleSimpleLine` fonksiyonunun doğru store'u bulmasını sağlar
- Ders oturumu silinirken `tarih + islened_konu` grup anahtarı kullanılır — aynı gün aynı konuya iki farklı oturum desteklenmez
- `loadRapor()` içinde `odevler` sorgusuna `ORDER BY` eklenmemeli: `verilis_tarihi` null olan eski kayıtlar Supabase hatasına yol açar, `data: null` döner ve tüm rapor boşalır
- `veliler` tablosu için `ogrenciler(*)` JOIN sorgusu Supabase foreign key ilişkisine dayanır; tablo oluşturulmadan önce uygulama hata verir
- `odev_detay` rapor sorgusuna explicit olarak dahil edilmeli — `select('*')` yerine sütun listesi kullanılırken eksik kalırsa toggle tabloda her zaman `undefined` gelir

---

## 18. Commit Geçmişi (Bu Sürüm)

| Hash | Açıklama |
|---|---|
| `3707423` | Ders Programı: haftalık grid ve tüm JS fonksiyonları eklendi |
| `12be139` | Ders Kaydet: kazanım bazlı tamamlama durumu + sorun alanı eklendi |
| `3e4438f` | Konu bazlı zaman serisi + proaktif uyarı sistemi eklendi |
| `4631212` | Ders kayıtlarına düzenle ve sil desteği eklendi |
| `004f635` | Ders Kaydet formuna tarih alanı eklendi |
| `0f585c0` | Hızlı navigasyon: öğrenci kartı ve liste tıklamaları |
| `805c7dd` | Rapor: Ödev Analizi bölümü eklendi |
| `e52faa8` | Dashboard: Bekleyen Ödev kartına modal eklendi |
| `1b738fd` | Fix: loadRapor odevler sorgusunda tarih → verilis_tarihi |
| `7ac8de7` | Fix: loadRapor odevler sorgusundan ORDER BY kaldırıldı |
| `21c0aeb` | Fix: Giriş sol panel — slogan düzeltmesi |
| `d1bfeec` | Fix: Giriş sol panel — renk logosu dekoratif daire içine taşındı |
| `1da4aeb` | Feat: Çok veli desteği — veliler tablosu ve dinamik satır UI |
| `37b51ad` | Feat: Öğrenci ödev sekmesi — 4 iyileştirme |
| `8500918` | Fix: Rapor ödev — BEKLİYOR kart + detay trim kontrolü |
| `c24140a` | Fix: Rapor ödev grid yeniden düzenlendi + odev_detay sorgu hatası |
| `a6b039c` | Fix: Ada rol kontrolü, görünürlük fix, localStorage key ayrımı; hedef toggle |
| `a4481d1` | Feat: Ödev sekmeleri (Bekleyenler/Tamamlananlar/Tümü) + inline Düzenle formu |
| `f2a9c1d` | Feat: AdaptiX Platform Yönetim Paneli — öğretmen/fatura yönetimi |
| `c8e3b2a` | Feat: Çok öğretmen desteği — ogretmen_id şema + sorgu izolasyonu |
| `a1d4e7f` | Feat: Ada AI — Anthropic API entegrasyonu + WhatsApp veli mesajı |
| `6cbf6d8` | Sync: www/index.html ← scholar_metric.html ile birebir senkronize |
| `f4c73b3` | Fix: loadOgrenciPanel kapanmamış `}` syntax hatası düzeltildi |
| `21e0237` | Fix: kullanicilar INSERT `returning:minimal` + öğretmen modal arka plan beyaz |
| `533f3b3` | Feat: AdaptiX öğretmen silme — pasif öğretmen + tüm alt veriler cascade sil |

---

*AdaptiX BTS V3 — Öğrenci Takip Sistemi*
