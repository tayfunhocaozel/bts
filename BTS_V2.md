# AdaptiX — Bireysel Takip Sistemi (BTS) V2

**Geliştiren:** Tayfun Hoca  
**Sürüm:** 2.0  
**Hedef Kitle:** LGS hazırlık öğrencileri, velileri ve matematik öğretmenleri  
**Canlı Repo:** https://github.com/tayfunhocaozel/bts

---

## V2'de Yapılan Değişiklikler

| # | Değişiklik |
|---|---|
| 1 | Öğretmen şifresi koddan çıkarılıp Supabase `kullanicilar` tablosuna SHA-256 hash olarak taşındı |
| 2 | AdaptiX logosu uygulamaya eklendi (giriş ekranı, sol menü, mobil header) |
| 3 | Öğrenci silme akışı düzeltildi — ilişkili tüm tablolar cascade sırasıyla temizleniyor |
| 4 | Sol menü lacivert (`#005d8d`) yapıldı, yazılar beyaza çevrildi |
| 5 | Sol menüde "Matematik Öğretmeni" yerine "Dijital Eğitim Çözümleri" yazısı eklendi |
| 6 | Dashboard stat kartları renklendi: mavi (Öğrenci), sarı (Bekleyen Ödev), yeşil (Bu Ay Ders) |
| 7 | Denemeler bölümüne **Net Trendi** çizgi grafiği eklendi (Chart.js) |

---

## Genel Bakış

AdaptiX, özel ders öğrencilerini bireysel olarak takip etmeye yarayan, tek HTML dosyasından oluşan bir web uygulamasıdır. Öğretmen, öğrenci ve veli olmak üzere üç farklı kullanıcı rolü sunar. Veriler gerçek zamanlı olarak Supabase (PostgreSQL) üzerinde saklanır.

---

## Teknik Yapı

| Bileşen | Teknoloji |
|---|---|
| Arayüz | Vanilla JavaScript + Tailwind CSS (CDN) |
| Veritabanı | Supabase (PostgreSQL) |
| Kimlik Doğrulama | Özel (SHA-256 hash + TC/telefon) |
| Grafik | Chart.js 4.4.4 (CDN) |
| Dağıtım | Tek HTML dosyası (`scholar_metric.html`) |
| Mobil | Capacitor (Android APK — `www/index.html`) |
| Derleme adımı | Yok — doğrudan tarayıcıda çalışır |
| Yazı tipleri | Manrope (başlık), Inter (metin) — Google Fonts |
| İkonlar | Material Symbols Outlined |

### Supabase Tabloları

| Tablo | Amaç | Önemli Sütunlar |
|---|---|---|
| `ogrenciler` | Öğrenci kayıtları | `ogrenci_id`, `tc_no`, `ad_soyad`, `sinif`, `veli_telefon`, `kayit_durumu` |
| `dersler` | Ders kayıtları | `ogrenci_id`, `tarih`, `islenen_konu`, `kazanim_kodu`, `ders_gorusu`, `sonraki_ders_hatirlatma` |
| `odevler` | Ödev kayıtları | `ogrenci_id`, `gun`, `kaynak`, `konu`, `kazanim`, `durum`, `dogru`, `yanlis`, `bos`, `toplam` |
| `denemeler` | Deneme sınavı sonuçları | `deneme_id` (UUID), `ogrenci_id`, `tarih`, `deneme_adi`, `dogru`, `yanlis`, `bos`, `net`, `basari_yuzdesi` |
| `ogrn_kaynak` | Öğrenciye atanmış kaynaklar | `kayit_id`, `ogrenci_id`, `kaynak_adi`, `konu_sayisi`, `islened_konu`, `ilerleme_yuzdesi` |
| `kaynaklar` | Kaynak kitap/materyal listesi | `kaynak_adi`, `sinif` |
| `kazanimlar` | Müfredat kazanımları | `sinif`, `konu`, `kazanim_kodu`, `kazanim_aciklamasi` |
| `kullanicilar` | Öğretmen giriş bilgileri | `rol`, `sifre_hash` (SHA-256) |
| `ders_programi` | Haftalık program | `ogrenci_id`, `gun`, `baslangic`, `bitis` |

---

## Kullanıcı Rolleri ve Giriş

Uygulama açıldığında tek bir giriş ekranı gelir. Üç sekme arasından rol seçilir:

### Öğretmen Girişi
- Şifre ile giriş yapılır
- Girilen şifre tarayıcıda SHA-256 ile hashlenir, `kullanicilar` tablosundaki hash ile karşılaştırılır
- Şifre değiştirmek için Supabase SQL Editor'de yeni hash ile `UPDATE` çalıştırılır
- Şifre kaynakta düz metin olarak **görünmez**

### Öğrenci Girişi
- TC kimlik numarası ile giriş yapılır
- `ogrenciler` tablosundaki `tc_no` alanı ile eşleşme aranır

### Veli Girişi
- Telefon numarası ile giriş yapılır
- `ogrenciler` tablosundaki `veli_telefon` alanı ile eşleşme aranır
- Giriş yapılan veliye ait öğrencinin tüm verileri görüntülenir

Oturum, `localStorage`'da saklanır. Sayfa yenilendiğinde oturum korunur.

---

## Öğretmen Paneli

Giriş yapan öğretmen 7 bölüme erişir. Sol kenar çubuğu (masaüstü) ve alt navigasyon (mobil) ile sayfalar arası geçiş yapılır.

### 1. Ana Sayfa (Dashboard)

Renkli stat kartları ile anlık özet:

| Kart | Renk | İçerik |
|---|---|---|
| Öğrenci | Lacivert (`#005d8d`) | Toplam aktif öğrenci sayısı |
| Bekleyen Ödev | Amber (`#feb223`) | Tamamlanmayı bekleyen ödev sayısı |
| Bu Ay Ders | Yeşil (`#008228`) | Bu ay kaydedilen ders sayısı |

Ayrıca:
- Sınıf dağılımı (ilerleme çubukları ile, açık mavi arka plan)
- Bekleyen ödevlerin öğrenci ve konuya göre listesi (en fazla 5 kayıt)

### 2. Ders Kaydet

Öğretmenin gerçekleştirdiği dersleri kaydettiği bölümdür.

**Akış:**
1. Öğrenci seçilir → öğrencinin sınıfına göre kazanımlar Supabase'den çekilir
2. Konu seçilir → konuya ait kazanımlar listeye dökülür (checkbox)
3. İşlenecek kazanımlar seçilir (birden fazla seçilebilir)
4. İsteğe bağlı: ders görüşü ve sonraki ders hatırlatma notu girilir
5. Kaydedilir → her seçili kazanım için `dersler` tablosuna ayrı satır eklenir

### 3. Ödev Gir

Öğrenciye haftalık ödev atamanın yapıldığı bölümdür. Taslak sistemi ile birden fazla ödev tek seferde kaydedilebilir.

**Akış:**
1. Öğrenci seçilir → öğrenciye atanmış kaynaklar ve sınıf kazanımları çekilir
2. Kaynak atanmamış öğrenciler için uyarı gösterilir
3. Ödev formu doldurulur: gün, kaynak, konu, kazanım (opsiyonel), sayfa/test detayı
4. "Tabloya Ekle" ile taslak listeye eklenir (güne göre sıralanır)
5. "Tümünü Kaydet" ile tüm taslaklar `odevler` tablosuna toplu yazılır

**Durum Yönetimi (mevcut ödevler için):**
- BEKLİYOR → TAMAMLANDI / EKSİK / YAPILMADI
- TAMAMLANDI ödevlere sonuç girişi yapılabilir (D/Y/B/Toplam)

### 4. Öğrenciler

Öğrenci ekleme, düzenleme ve silme işlemlerinin yapıldığı bölümdür.

**Öğrenci kaydı:** Ad soyad, TC no, sınıf, şube, okul, veli adı, veli telefonu

**Silme (V2 düzeltmesi):** Öğrenci silindiğinde ona bağlı tüm kayıtlar aşağıdaki sırayla otomatik temizlenir:
```
ders_programi → ogrn_kaynak → denemeler → odevler → dersler → ogrenciler
```

### 5. Kaynaklar

Öğrencilere kaynak kitap/materyal atanmasının yapıldığı bölümdür.

- Öğrenci seçilir, sınıfına uygun kaynaklar filtrelenir
- Seçilen kaynak `ogrn_kaynak` tablosuna eklenir (varsayılan 12 konu)
- Her kaynak için işlenen konu sayısı güncellenir → ilerleme çubuğu güncellenir
- Kaynak kaldırılabilir

### 6. Denemeler

Deneme sınavı sonuçlarının girildiği ve takip edildiği bölümdür.

**Giriş:** Öğrenci, tarih, deneme adı, doğru/yanlış/boş sayıları

**Otomatik hesaplama (anlık önizleme):**
- Toplam soru = D + Y + B
- Net = D − (Y / 3)
- Başarı % = Net / Toplam × 100
- Renk kodu: %80+ yeşil, %60–80 turuncu, altı kırmızı

**Net Trendi Grafiği (V2 yeni özellik):**
- En az 2 deneme varsa tablonun üstünde otomatik çizgi grafik gösterilir
- X ekseni: deneme tarihleri, Y ekseni: net skoru
- Noktalar başarı yüzdesine göre renk kodlu (yeşil / turuncu / kırmızı)
- Üzerine gelindiğinde deneme adı, net ve başarı % gösterilir
- Chart.js 4.4 kullanılır

Sonuçlar tarih sıralı tabloda listelenir. Her kayıt tek tek silinebilir.

### 7. Rapor

Seçilen öğrencinin tüm performans verilerini tek sayfada derleyen ve yazdırmaya uygun rapor bölümüdür.

**Rapor içeriği:**
- Öğrenci bilgileri (ad, okul, sınıf, tarih, ders sayısı)
- Konu Analiz Tablosu: her konu için D/Y/B/Toplam (genel toplam ile)
- Başarı Analizi: konulara göre yatay bar grafik (renk kodlu)
- Konu Tamamlama Durumu: donut grafik (işlenen/toplam konu)
- Ödev istatistikleri: tamamlanan, bekleyen, yapılmayan sayıları
- Deneme sonuçları tablosu: tarih, ad, D/Y/B/Net/Başarı%
- Ders Akışı: son 15 ders kaydı (tarih + konu + kazanım kodları)

**PDF / Yazdırma:** Tarayıcının yazdırma özelliği ile A4 formata optimize edilmiş çıktı alınır.

---

## Öğrenci Paneli

Öğrenci TC numarasıyla giriş yaptığında kendi paneli açılır. 4 sekme bulunur:

### Ödevler Sekmesi
- Bekleyen ödevlerin listesi (konu, gün, kaynak, detay)
- Her ödev kartının renk kodlu durum rozeti

### Denemeler Sekmesi
- En iyi net ve ortalama başarı özet kartları
- **Net Trendi grafiği** (V2 — en az 2 deneme varsa gösterilir)
- Tüm deneme sonuçları tablosu (tarih, ad, D/Y/B, Net, Başarı%)

### Dersler Sekmesi
- İşlenen konu listesi (tarihe göre azalan)
- Her derste işlenen kazanım kodları

### Başarı Sekmesi
- İşlenen konu sayısı / toplam konu (donut grafik)
- Konu bazlı başarı yüzdesi bar grafikleri
- Ödev tamamlama oranı

**Ek özellikler:**
- LGS geri sayım kartı (8. sınıf öğrencileri için, 13 Haziran 2026)
- Motivasyon mesajları (günlük değişen)
- Hedef belirleme ve `localStorage`'a kaydetme

---

## Veli Paneli

Veli telefon numarasıyla giriş yaptığında çocuğunun özet bilgileri görünür. 5 sekme bulunur:

### Özet Sekmesi
- Çocuğun adı ve sınıfı
- Son aktivite durumu (Bugün / Dün / X gün önce)
- Bu aya ait ders sayısı, ödev sayısı ve başarı yüzdesi kartları
- LGS geri sayım (8. sınıf için)

### Ödevler Sekmesi
- Bekleyen, tamamlanan ve eksik/yapılmayan ödev sayıları
- Son ödevlerin durum listesi

### Dersler Sekmesi
- Son derslerin tarihe göre listesi

### Denemeler Sekmesi
- **Net Trendi grafiği** (V2 — en az 2 deneme varsa gösterilir)
- Tüm deneme sonuçları tablosu

### Başarı Sekmesi
- Konu bazlı analiz ve başarı grafikleri

---

## Tasarım Sistemi

Uygulama Material Design 3 renk tokenlarını Tailwind ile uygular:

| Token | Renk | Kullanım |
|---|---|---|
| `primary` | `#005d8d` | Sol menü arka planı, ana butonlar, vurgu |
| `secondary` | `#805600` | Turuncu — bekleyen ödev metni |
| `secondary-container` | `#feb223` | Bekleyen Ödev stat kartı arka planı |
| `tertiary` | `#00661d` | Yeşil metin — tamamlanan, başarı |
| `tertiary-container` | `#008228` | Bu Ay Ders stat kartı arka planı |
| `error` | `#ba1a1a` | Kırmızı — hata, düşük başarı |
| `surface` | `#f5faff` | Sayfa arka planı |
| `primary-fixed` | `#cce5ff` | Sınıf Dağılımı kartı arka planı |

**Sol Menü (V2):**
- Arka plan: `primary` (#005d8d) lacivert
- Yazılar: beyaz / %75 beyaz
- Aktif menü: %15 beyaz arka plan + beyaz yazı
- Avatar: beyaz arka plan, lacivert harf
- Alt bilgi: "Dijital Eğitim Çözümleri"

---

## Güvenlik

- Öğretmen şifresi düz metin olarak **kodda veya DB'de saklanmaz**; yalnızca SHA-256 hash'i `kullanicilar` tablosunda tutulur
- Hash karşılaştırması tarayıcının yerleşik `crypto.subtle.digest` API'si ile yapılır, harici kütüphane gerekmez
- Supabase `anon` anahtarı istemci tarafında kullanılır — RLS politikaları aktif edilmelidir
- Öğrenci/veli girişleri TC no ve telefon numarasına dayanır; ek şifre koruması yoktur

---

## Bilinen Kısıtlamalar

- Uygulama tek HTML dosyasıdır; modüler yapıya geçiş yapılmamıştır
- Öğretmen adı (`Tayfun Hoca`) kod içinde sabit tanımlıdır
- Deneme sınavı yalnızca matematik formatında (D − Y/3) hesaplar
- Kaynak ilerleme güncellemesinde `islened_konu` sütun adında yazım hatası mevcuttur
- Çevrimdışı mod desteklenmez; internet bağlantısı zorunludur

---

## APK / Mobil

Uygulama **Capacitor** ile Android APK'ya dönüştürülebilir.

```json
// capacitor.config.json
{
  "appId": "com.bts.app",
  "appName": "BTS Web",
  "webDir": "www"
}
```

Web değişikliklerini APK'ya yansıtmak için:
```powershell
npx cap sync android
cd android
.\gradlew assembleDebug
# Çıktı: android\app\build\outputs\apk\debug\app-debug.apk
```

---

## Klasör Yapısı

```
D:\BTS_web\
├── scholar_metric.html        # Ana uygulama dosyası
├── www\
│   └── index.html             # Capacitor/mobil dağıtım kopyası
├── public\
│   └── adaptix_renk_logo.png  # Uygulama logosu
├── BTS_V1.md                  # V1 dokümantasyonu
├── BTS_V2.md                  # Bu dosya
└── android\                   # Capacitor Android projesi
```
