"""2026-2027 MEB çerçeve yıllık planlarından `kazanimlar` tablosu verisi üretir.

Kaynaklar (sadece okunur):
  - 2026-2027cerceve_plan/*.xlsx  -> resmî kod, konu (içerik çerçevesi), açıklama, hafta sırası
  - KAZANIMLAR/*.xlsx             -> Din Kültürü 5-8 + planda süreç bileşeni olmayan kazanımlara alt kazanım
  - Supabase Yedek/<son>/data.sql -> fark raporu için mevcut kazanimlar tablosu

Çıktılar:
  - 2026-2027cerceve_plan/kazanimlar_2026_2027.csv
  - 2026-2027cerceve_plan/fark_raporu.md
  - supabase/migrations/20260929_kazanimlar_2026_2027.sql (+ _rollback.sql)

Kullanım:  python scripts/cerceve_plan_to_kazanim.py
Bağımlılık yok (openpyxl gerekmez; xlsx zipfile + XML ile okunur).
"""
import csv
import glob
import os
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from collections import OrderedDict, defaultdict

KOK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLAN_DIR = os.path.join(KOK, '2026-2027cerceve_plan')
LISTE_DIR = os.path.join(KOK, 'KAZANIMLAR')
YEDEK_DIR = os.path.join(KOK, 'Supabase Yedek')
MIG_DIR = os.path.join(KOK, 'supabase', 'migrations')

# ── xlsx okuyucu ──────────────────────────────────────────────
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
T_TAG = '{%s}t' % NS['m']


def _sutun_no(harf):
    n = 0
    for ch in harf:
        n = n * 26 + ord(ch) - 64
    return n - 1


def xlsx_oku(yol):
    """{sayfa_adı: [(satır_no, [hücreler...]), ...]} döndürür (sayfa sırası korunur)."""
    z = zipfile.ZipFile(yol)
    ortak = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS):
            ortak.append(''.join(t.text or '' for t in si.iter(T_TAG)))
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    rmap = {r.get('Id'): r.get('Target') for r in rels}
    sonuc = OrderedDict()
    for s in wb.find('m:sheets', NS):
        hedef = rmap[s.get('{%s}id' % NS['r'])].lstrip('/')
        if not hedef.startswith('xl/'):
            hedef = 'xl/' + hedef
        kok = ET.fromstring(z.read(hedef))
        satirlar = []
        for row in kok.iter('{%s}row' % NS['m']):
            degerler = {}
            for c in row.findall('m:c', NS):
                ref = re.match(r'[A-Z]+', c.get('r')).group()
                v = c.find('m:v', NS)
                ist = c.find('m:is', NS)
                if c.get('t') == 's' and v is not None:
                    deger = ortak[int(v.text)]
                elif ist is not None:
                    deger = ''.join(x.text or '' for x in ist.iter(T_TAG))
                elif v is not None:
                    deger = v.text
                else:
                    continue
                degerler[_sutun_no(ref)] = deger
            if degerler:
                enc = max(degerler)
                satirlar.append((int(row.get('r')), [degerler.get(i, '') for i in range(enc + 1)]))
        sonuc[s.get('name')] = satirlar
    return sonuc


# ── yardımcılar ───────────────────────────────────────────────
# Kod kalıpları: MAT.7.1.1.  FB.5.1.1.  SB 7.1.1.  İTA.8.1.1.  T.D.5.3.  T.8.3.1.
# M.8.1.1.1.  F.8.1.1.1.  ENG.5.1.L1.  E8.2.SI1.
KOD_RE = re.compile(
    r'(?<![\w.])'
    r'((?:MAT|FB|SB|İTA|ENG|T\.[DOKY]|[MFTE])\s?\.?\s?\d+(?:\.(?:\d+|[A-Z]{1,2}\s?\d+))+)\.?'
)


def kod_normalize(ham):
    k = re.sub(r'\s+', '', ham).rstrip('.')
    k = re.sub(r'^(MAT|FB|SB|İTA|ENG)(\d)', r'\1.\2', k)  # 'ENG5.7' -> 'ENG.5.7', 'SB7.1.1' -> 'SB.7.1.1'
    return k + '.'


def temiz(s):
    # tipografik kesme işareti -> düz (eski kayıtlardaki "Atatürk'ün" gibi konu adlarıyla aynı kalsın)
    s = (s or '').replace('\r', '').replace('’', "'").replace('‘', "'")
    s = re.sub(r'[ \t ]+', ' ', s)
    return '\n'.join(x.strip() for x in s.split('\n')).strip()


def bloklara_bol(hucre):
    """'A\n\nB' -> ['A','B'] (boş satırla ayrılmış parçalar)."""
    return [p.strip() for p in re.split(r'\n\s*\n', temiz(hucre)) if p.strip()]


UNITE_ONEK_RE = re.compile(r'^\s*\d*\s*\.?\s*(?:ÜNİTE|ÖĞRENME ALANI)\s*:?\s*', re.I)


def konu_bol(hucre, satir_bol):
    """Konu hücresini konulara böler. satir_bol=True ise tek satır sonu da ayırıcıdır
    (Matematik/Fen: 'Tam Sayılar\\nRasyonel Sayılar...'); değilse sadece boş satır
    (Sosyal: 'Dijitalleşme ve Teknolojik\\nGelişmelerin...' tek konu, satır kaydırılmış)."""
    parcalar = []
    hucre = re.sub(r' {15,}', '\n', hucre or '')  # bazı hücrelerde alt satır boşlukla yapılmış
    for blok in bloklara_bol(hucre):
        if not satir_bol:
            parcalar.append(' '.join(blok.split('\n')))
            continue
        for satir in blok.split('\n'):
            satir = satir.strip()
            if not satir:
                continue
            if parcalar and (satir[0] in '(' or satir[0].islower() or re.search(r'(\bve|\bveya|,)$', parcalar[-1])):
                parcalar[-1] += ' ' + satir
            else:
                parcalar.append(satir)
    return parcalar


def konu_temizle(s):
    s = temiz(s).replace('\n', ' ')
    s = UNITE_ONEK_RE.sub('', s)
    s = re.sub(r'^\s*(?:[A-ZİÇŞĞÜÖ]{1,3}\.)?\d+(?:\.\d+)*\.?\s*', '', s)  # 'M.8.1.1. X', '8.1.1. X'
    s = re.sub(r'\s*\(Öğrencilerin.*$', '', s)  # 'Yıl Sonu Bilim Şenliği (Öğrencilerin ... beklenir.)'
    s = re.sub(r'\s+', ' ', s).strip(' -:')
    return s


def unite_temizle(s):
    s = temiz(s).replace('\n', ' ')
    s = re.sub(r'\s+', ' ', s).strip()
    s = UNITE_ONEK_RE.sub('', s)
    s = re.sub(r'^(?:[A-Z]\.)?\d+(?:\.\d+)*\.?\s*', '', s)  # 'M.8.1. SAYILAR...', '1.ÜNİTE'
    return baslik_duzelt(s.strip())


def baslik_duzelt(s, ingilizce=False):
    """'SAYILAR VE İŞLEMLER' -> 'Sayılar ve İşlemler' (Türkçe büyük/küçük harf)."""
    if not s or s != s.upper():
        return s
    if ingilizce:
        kucuk_en = {'and', 'of', 'the', 'in', 'at', 'on', 'for'}
        return ' '.join(w.lower() if i > 0 and w.lower() in kucuk_en else w.capitalize()
                        for i, w in enumerate(s.split(' ')))
    kucuk = {'VE', 'İLE', 'DA', 'DE', 'Mİ', 'AND', 'OF', 'THE', 'IN', 'AT'}
    kel = []
    for i, w in enumerate(s.split(' ')):
        lw = w.replace('I', 'ı').replace('İ', 'i').lower()
        if i > 0 and w in kucuk:
            kel.append(lw)
        else:
            kel.append(lw[:1].replace('i', 'İ').replace('ı', 'I').upper() + lw[1:])
    return ' '.join(kel)


def hafta_no(s):
    m = re.search(r'(\d+)\s*\.?\s*Hafta|Week\s*(\d+)', s or '', re.I)
    return int(m.group(1) or m.group(2)) if m else None


def metin_anahtar(s):
    s = unicodedata.normalize('NFKC', (s or '').lower())
    s = s.replace('â', 'a').replace('î', 'i').replace('û', 'u')
    return re.sub(r'[^0-9a-zçğıöşü]+', ' ', s).strip()


def dice(a, b):
    def ikili(x):
        x = x.replace(' ', '')
        return {x[i:i + 2] for i in range(len(x) - 1)}
    A, B = ikili(a), ikili(b)
    return 2 * len(A & B) / (len(A) + len(B)) if A and B else 0.0


ING_BECERI_BASLIK = {'Listening', 'Spoken Interaction', 'Spoken Production', 'Reading', 'Writing'}


def kodlara_bol(metin):
    """Metni kod başlangıçlarından böler: [(kod, baslik, detay), ...]."""
    metin = temiz(metin)
    eslesmeler = list(KOD_RE.finditer(metin))
    parcalar = []
    for i, m in enumerate(eslesmeler):
        son = eslesmeler[i + 1].start() if i + 1 < len(eslesmeler) else len(metin)
        govde = metin[m.end():son].strip()
        satirlar = [x for x in govde.split('\n') if x.strip() not in ING_BECERI_BASLIK]
        # başlık birden çok satıra kaydırılmış olabilir: nokta ile bitmeyen satırı küçük harfle
        # başlayan sonraki satırla birleştir ('Güneş sistemindeki\ngezegenleri...')
        baslik = satirlar[0].strip() if satirlar else ''
        i = 1
        while i < len(satirlar) and satirlar[i].strip() and not baslik.endswith('.') \
                and satirlar[i].strip()[0].islower() and not re.match(r'[a-zçğıöşü]\s*\)', satirlar[i].strip()):
            baslik += ' ' + satirlar[i].strip()
            i += 1
        detay = temiz('\n'.join(satirlar[i:]))
        parcalar.append((kod_normalize(m.group(1)), baslik, detay))
    return parcalar


# ── sayfa yapılandırması ─────────────────────────────────────
# unite/konu/cikti/surec: sütun indeksleri. konu=None -> ünite adı konu olur.
# beceri: Türkçe'de konu = beceri sütununun adı (Dinleme/İzleme, Okuma...).
MAT = 'İlköğretim Matematik'
FEN = 'Fen Bilimleri'
SOS = 'Sosyal Bilgiler'
ITA = 'T.C. İnkılap Tarihi ve Atatürkçülük'
TUR = 'Türkçe'
ING = 'İngilizce'
DIN = 'Din Kültürü ve Ahlak Bilgisi'

PLANLAR = [
    ('MATEMATİK (5-8. SINIF) TASLAK ÇERÇEVE YILLIK PLAN.xlsx', [
        ('5.Sınıf', MAT, 5, dict(unite=3, konu=4, cikti=[5], surec=6)),
        ('6.Sınıf', MAT, 6, dict(unite=3, konu=4, cikti=[5], surec=6)),
        ('7.Sınıf', MAT, 7, dict(unite=3, konu=4, cikti=[5], surec=6)),
        ('8.Sınıf', MAT, 8, dict(unite=3, konu=4, cikti=[5], surec=6)),
    ]),
    ('FEN BİLİMLERİ  (3-8. SINIFLAR) TASLAK ÇERÇEVE YILLIK PLAN.xlsx', [
        ('FEN BİLİMLERİ 5 (TYMM)', FEN, 5, dict(unite=3, konu=4, cikti=[5], surec=6)),
        ('FEN BİLİMLERİ 6 (TYMM)', FEN, 6, dict(unite=3, konu=4, cikti=[5], surec=6)),
        ('FEN BİLİMLERİ 7 (TYMM)', FEN, 7, dict(unite=3, konu=4, cikti=[5], surec=6)),
        ('FEN BİLİMLERİ 8', FEN, 8, dict(unite=3, konu=4, cikti=[5], surec=6)),
    ]),
    ('SOSYAL BİLGİLER (4-7. SINIFLAR) TASLAK ÇERÇEVE YILLIK PLAN.xlsx', [
        ('5. SINIF YILLIK PLAN', SOS, 5, dict(unite=3, konu=4, cikti=[5], surec=6)),
        ('6. SINIF YILLIK PLAN', SOS, 6, dict(unite=3, konu=4, cikti=[5], surec=6)),
        ('7. SINIF YILLIK PLAN', SOS, 7, dict(unite=3, konu=4, cikti=[5], surec=6)),
    ]),
    ('T. C. INKILAP TARİHİ VE ATATÜRKÇÜLÜK (8. SINIF)  TASLAK ÇERÇEVE YILLIK PLAN.xlsx', [
        ('8. SINIF YILLIK PLAN', ITA, 8, dict(unite=3, konu=None, cikti=[4], surec=5)),
    ]),
    ('TÜRKÇE (5-8. SINIFLAR) TASLAK ÇERÇEVE YILLIK PLAN.xlsx', [
        ('TÜRKÇE 5 ÇERÇEVE YILLIK PLANLAR', TUR, 5,
         dict(unite=3, beceri={6: 'Dinleme/İzleme', 7: 'Dinleme/İzleme', 8: 'Dinleme/İzleme',
                               9: 'Okuma', 10: 'Konuşma', 11: 'Yazma'})),
        ('6. SINIF ÇERÇEVE YILLIK PLA (3)', TUR, 6,
         dict(unite=3, beceri={6: 'Dinleme/İzleme', 7: 'Okuma', 8: 'Konuşma', 9: 'Yazma'})),
        ('7. SINIF ÇERÇEVE YILLIK PLAN', TUR, 7,
         dict(unite=3, beceri={6: 'Dinleme/İzleme', 7: 'Okuma', 8: 'Konuşma', 9: 'Yazma'})),
        ('Türkçe 8. SINIF MEB YILLIK PLAN', TUR, 8,
         dict(unite=3, beceri={5: 'Dinleme/İzleme', 6: 'Konuşma', 7: 'Okuma', 8: 'Yazma'})),
    ]),
    ('İNGİLİZCE (2-8. SINIF) TASLAK YILLIK ÇERÇEVE PLAN.xlsx', [
        ('TYMM 5', ING, 5, dict(unite=3, konu=None, cikti=[5, 6], surec=None)),
        ('TYMM 6', ING, 6, dict(unite=3, konu=None, cikti=[5, 6], surec=None)),
        ('7. Sınıf ', ING, 7, dict(unite=3, konu=None, cikti=[5], surec=None)),
        ('8. Sınıf', ING, 8, dict(unite=3, konu=None, cikti=[5], surec=None)),
    ]),
]

LISTE_DOSYALARI = {5: '5.SINIF YENİ.xlsx', 6: '6.SINIF YENİ.xlsx', 7: '7.SINIF YENİ.xlsx', 8: '8.SINIF YENİ.xlsx'}
LISTE_SAYFA = {MAT: 'MATEMATİK', FEN: 'FEN BİLİMLERİ', SOS: 'SOSYAL BİLGİLER', ITA: 'İNKILAP TARİHİ',
               TUR: 'TÜRKÇE', ING: 'İNGİLİZCE', DIN: 'DİN KÜLTÜRÜ'}


def ingilizce_tema(s):
    s = re.sub(r'\s+', ' ', temiz(s)).strip()
    s = re.sub(r'^THEME\s*\d+\s*:\s*', '', s, flags=re.I)
    s = re.sub(r'^\d+\s+', '', s)
    s = baslik_duzelt(s.strip(), ingilizce=True)
    return re.sub(r'(?<=\s)(And|Of|The|In|At|On|For)(?=\s)', lambda m: m.group(1).lower(), s)


# ── plan ayrıştırma ──────────────────────────────────────────
class Kazanim:
    def __init__(self, ders, sinif, kod):
        self.ders, self.sinif, self.kod = ders, sinif, kod
        self.unite = ''
        self.baslik = ''
        self.detay = ''
        self.sira = None
        self.konu_adaylari = []  # (güç, hafta, konu)
        self.alt_kaynak = ''

    @property
    def konu(self):
        if not self.konu_adaylari:
            return self.unite
        return sorted(self.konu_adaylari, key=lambda x: (-x[0], x[1]))[0][2]

    def aciklama(self):
        return temiz(self.baslik + ('\n' + self.detay if self.detay else ''))


def plan_sayfasi_isle(satirlar, ders, sinif, cfg, depo, uyarilar):
    son_unite = ''
    son_konu = ''
    son_hafta = None
    for rno, v in satirlar:
        v = v + [''] * 25
        hafta = hafta_no(v[1])
        if hafta is None:
            # birleştirilmiş hafta hücresi: aynı haftanın ikinci satırı
            if son_hafta is None or v[1].strip():
                continue
            hafta = son_hafta
        son_hafta = hafta
        unite_ham = v[cfg['unite']].strip()
        if unite_ham:
            # hücre içinde birden çok ünite olabilir ('A\n\nB'); ilki bu satırın ünitesi, sonuncusu sonrakilerin
            ub = bloklara_bol(unite_ham)
            son_unite = ub[-1] if ub else son_unite
            unite_listesi = ub
        else:
            unite_listesi = [son_unite]

        if 'beceri' in cfg:
            for sut, beceri in cfg['beceri'].items():
                for kod, baslik, detay in kodlara_bol(v[sut]):
                    k = kazanim_al(depo, ders, sinif, kod, hafta, unite_temizle(unite_listesi[0]), baslik, detay)
                    k.konu_adaylari.append((3, hafta, beceri))
            continue

        # konu hücresi
        if cfg.get('konu') is not None:
            konu_ham = v[cfg['konu']].strip()
            if konu_ham:
                konular = [konu_temizle(x) for x in konu_bol(konu_ham, ders in (MAT, FEN))]
                konular = [x for x in konular if x]
                son_konu = konular[-1] if konular else son_konu
            else:
                konular = [son_konu] if son_konu else []
        else:
            konular = None

        ciktilar = []
        for sut in cfg['cikti']:
            ciktilar.extend(kodlara_bol(v[sut]))
        if not ciktilar:
            continue

        # süreç bileşenleri ayrı sütundaysa kazanımlara dağıt
        surec_parcalari = {}
        if cfg.get('surec') is not None and v[cfg['surec']].strip():
            sh = v[cfg['surec']]
            kodlu = kodlara_bol(sh)
            if kodlu:
                for kod, b, d in kodlu:
                    surec_parcalari[kod] = temiz((b + '\n' + d) if d else b)
            elif len(ciktilar) == 1:
                surec_parcalari[ciktilar[0][0]] = temiz(sh)
            else:
                # 'a)' ile yeniden başlayan bloklara böl, sırayla eşle
                bloklar = re.split(r'\n\s*(?=a\s*\))', '\n' + temiz(sh))
                bloklar = [b.strip() for b in bloklar if b.strip()]
                if len(bloklar) == len(ciktilar):
                    for (kod, _, _), b in zip(ciktilar, bloklar):
                        surec_parcalari[kod] = b
                else:
                    uyarilar.append(f'{ders} {sinif}. sınıf hafta {hafta}: {len(ciktilar)} çıktı / '
                                    f'{len(bloklar)} süreç bloğu eşleşmedi, süreç bileşeni atlandı')

        for i, (kod, baslik, detay) in enumerate(ciktilar):
            if ders == ING:
                unite = ingilizce_tema(unite_listesi[min(i, len(unite_listesi) - 1)])
            else:
                unite = unite_temizle(unite_listesi[min(i, len(unite_listesi) - 1)])
            if kod in surec_parcalari:
                detay = temiz((detay + '\n' + surec_parcalari[kod]) if detay else surec_parcalari[kod])
            k = kazanim_al(depo, ders, sinif, kod, hafta, unite, baslik, detay)
            if konular is None:
                k.konu_adaylari.append((3, hafta, unite))
            elif len(konular) == 1:
                k.konu_adaylari.append((3, hafta, konular[0]))
            elif len(konular) == len(ciktilar):
                k.konu_adaylari.append((2, hafta, konular[i]))
            elif konular:
                k.konu_adaylari.append((1, hafta, konular[min(i, len(konular) - 1)]))


def kazanim_al(depo, ders, sinif, kod, hafta, unite, baslik, detay):
    anahtar = (ders, sinif, kod)
    k = depo.get(anahtar)
    if k is None:
        k = depo[anahtar] = Kazanim(ders, sinif, kod)
        k.sira = hafta
        k.unite = unite
    if baslik and len(baslik) > len(k.baslik):
        k.baslik = baslik
    if detay and len(detay) > len(k.detay):
        k.detay = detay
    return k


# ── KAZANIMLAR listesi ───────────────────────────────────────
ALT_RE = re.compile(r'\.[A-ZÇĞİÖŞÜ]$')


def liste_oku():
    """{(ders, sinif): [ {kod, metin, altlar:[...], unite} ]}"""
    sonuc = defaultdict(list)
    for sinif, dosya in LISTE_DOSYALARI.items():
        yol = os.path.join(LISTE_DIR, dosya)
        if not os.path.exists(yol):
            continue
        sayfalar = xlsx_oku(yol)
        for ders, sayfa in LISTE_SAYFA.items():
            if sayfa not in sayfalar:
                continue
            unite = ''
            satirlar = [(v + [''] * 4) for _, v in sayfalar[sayfa][1:]]
            # kazanım kademesi = sayfadaki en derin (alt kazanım olmayan) kod; daha sığ kodlar başlıktır
            derinlik = lambda k: len(re.findall(r'\d+', k))
            kaz_derinlik = max((derinlik(v[2]) for v in satirlar if v[2].strip() and not ALT_RE.search(v[2].strip())), default=0)
            for v in satirlar:
                kod, metin = v[2].strip(), temiz(v[3])
                if not metin:
                    continue
                if not kod or (not ALT_RE.search(kod) and derinlik(kod) < kaz_derinlik):
                    # ünite başlığı (en sığ kademe) konu olarak tutulur
                    if not kod or derinlik(kod) <= 2:
                        unite = metin
                    continue
                if ALT_RE.search(kod):
                    if sonuc[(ders, sinif)]:
                        sonuc[(ders, sinif)][-1]['altlar'].append(metin)
                    continue
                sonuc[(ders, sinif)].append({'kod': kod, 'metin': metin, 'altlar': [], 'unite': unite})
    # 5. sınıf Türkçe ayrı dosya: kod A sütunu, metin B sütunu
    yol = os.path.join(LISTE_DIR, '5. sınıf türkçe.xlsx')
    if os.path.exists(yol):
        for _, satirlar in xlsx_oku(yol).items():
            for rno, v in satirlar:
                v = v + [''] * 3
                kod, metin = v[0].strip(), temiz(v[1])
                if not kod or not metin:
                    continue
                if ALT_RE.search(kod):
                    if sonuc[(TUR, 5)]:
                        sonuc[(TUR, 5)][-1]['altlar'].append(metin)
                else:
                    sonuc[(TUR, 5)].append({'kod': kod, 'metin': metin, 'altlar': [], 'unite': ''})
    return sonuc


def din_kulturu(liste):
    depo = OrderedDict()
    for sinif in (5, 6, 7, 8):
        for i, k in enumerate(liste.get((DIN, sinif), []), start=1):
            kod = kod_normalize(k['kod'])
            kz = Kazanim(DIN, sinif, kod)
            kz.unite = baslik_duzelt(k['unite'])
            kz.konu_adaylari.append((3, i, kz.unite))
            kz.baslik = k['metin']
            kz.detay = '\n'.join(f'{chr(97 + j) if j < 26 else "-"}) {a}' for j, a in enumerate(k['altlar']))
            kz.sira = i
            kz.alt_kaynak = 'KAZANIMLAR'
            depo[(DIN, sinif, kod)] = kz
    return depo


def alt_kazanim_tamamla(depo, liste, uyarilar):
    """Planda detay (süreç bileşeni / açıklama) olmayan kazanımlara listeden alt kazanım ekler."""
    eklenen = 0
    for (ders, sinif, kod), k in depo.items():
        if k.detay or ders == DIN:
            continue
        adaylar = liste.get((ders, sinif), [])
        if not adaylar:
            continue
        a = metin_anahtar(k.baslik)
        en_iyi, skor = None, 0.0
        for c in adaylar:
            s = dice(a, metin_anahtar(c['metin']))
            if s > skor:
                en_iyi, skor = c, s
        if en_iyi and skor >= 0.85 and en_iyi['altlar']:
            k.detay = '\n'.join(f'{chr(97 + j)}) {x}' for j, x in enumerate(en_iyi['altlar']))
            k.alt_kaynak = f"KAZANIMLAR {en_iyi['kod']} (%{int(skor * 100)})"
            eklenen += 1
    return eklenen


def kod_kalibi(kod):
    return re.sub(r'\d+', '#', kod)


TUR_BECERI = {'T.D': 'Dinleme/İzleme', 'T.O': 'Okuma', 'T.K': 'Konuşma', 'T.Y': 'Yazma'}


def listeden_tamamla(depo, liste):
    """Planda hiç geçmeyen ama listede planla AYNI kod düzeniyle bulunan kazanımları ekler.
    Numaralandırması farklı olanlara dokunmaz (listedeki M.7.2.1, plandaki MAT.7.2.1. ile aynı şey değil)."""
    eklenenler = []
    for (ders, sinif), adaylar in liste.items():
        plan_kodlari = {k: v for (d, s, k), v in depo.items() if d == ders and s == sinif}
        if not plan_kodlari or ders == DIN:
            continue
        kaliplar = {kod_kalibi(k) for k in plan_kodlari}
        for c in adaylar:
            kod = kod_normalize(c['kod'])
            if kod in plan_kodlari or (ders, sinif, kod) in depo or kod_kalibi(kod) not in kaliplar:
                continue
            ebeveyn = kod.rstrip('.').rsplit('.', 1)[0] + '.'
            kardes = sorted((v for k, v in plan_kodlari.items() if k.startswith(ebeveyn)), key=lambda v: v.sira or 0)
            if ders == TUR and kod[:3] in TUR_BECERI:
                konu = TUR_BECERI[kod[:3]]
            elif kardes:
                konu = kardes[-1].konu
            else:
                konu = baslik_duzelt(c['unite'])
            kz = Kazanim(ders, sinif, kod)
            kz.unite = kardes[-1].unite if kardes else baslik_duzelt(c['unite'])
            kz.konu_adaylari.append((3, 0, konu))
            kz.sira = kardes[-1].sira if kardes else None
            kz.baslik = c['metin']
            kz.detay = '\n'.join(f'{chr(97 + j)}) {a}' for j, a in enumerate(c['altlar']))
            kz.alt_kaynak = 'KAZANIMLAR'
            depo[(ders, sinif, kod)] = kz
            eklenenler.append(f'{ders} {sinif}. sınıf {kod} → {konu}')
    return eklenenler


# ── mevcut tablo (yedek) ─────────────────────────────────────
def mevcut_tablo():
    klasorler = sorted(d for d in glob.glob(os.path.join(YEDEK_DIR, '*')) if os.path.isdir(d))
    for d in reversed(klasorler):
        yol = os.path.join(d, 'data.sql')
        if not os.path.exists(yol):
            continue
        satirlar, icinde, kolonlar = [], False, []
        with open(yol, encoding='utf-8') as f:
            for line in f:
                line = line.rstrip('\n')
                if line.startswith('COPY public.kazanimlar '):
                    kolonlar = re.search(r'\((.*)\)', line).group(1).split(', ')
                    icinde = True
                    continue
                if icinde:
                    if line == '\\.':
                        break
                    satirlar.append(dict(zip(kolonlar, line.split('\t'))))
        return os.path.basename(d), satirlar
    return None, []


# ── çıktı ────────────────────────────────────────────────────
def sql_str(s):
    if s is None:
        return 'NULL'
    return "'" + str(s).replace("'", "''") + "'"


def main():
    uyarilar = []
    depo = OrderedDict()
    for dosya, sayfalar in PLANLAR:
        wb = xlsx_oku(os.path.join(PLAN_DIR, dosya))
        for sayfa, ders, sinif, cfg in sayfalar:
            if sayfa not in wb:
                sys.exit(f'HATA: {dosya} içinde "{sayfa}" sayfası yok')
            plan_sayfasi_isle(wb[sayfa], ders, sinif, cfg, depo, uyarilar)

    liste = liste_oku()
    alt_eklenen = alt_kazanim_tamamla(depo, liste, uyarilar)
    listeden = listeden_tamamla(depo, liste)
    depo.update(din_kulturu(liste))

    # kod benzersizliği (PK = kazanim_kodu)
    kod_say = defaultdict(list)
    for (ders, sinif, kod) in depo:
        kod_say[kod].append((ders, sinif))
    cakisan = {k: v for k, v in kod_say.items() if len(v) > 1}
    if cakisan:
        sys.exit('HATA: tekrar eden kodlar: %r' % cakisan)

    satirlar = []
    for (ders, sinif, kod), k in depo.items():
        if not k.baslik:
            uyarilar.append(f'{ders} {sinif}. sınıf {kod}: başlık boş')
        satirlar.append({
            'sinif': f'{sinif}. Sınıf', 'ders': ders, 'unite': k.unite, 'konu': k.konu,
            'kazanim_kodu': kod, 'kazanim_aciklamasi': k.aciklama(), 'sira': k.sira,
        })
    satirlar.sort(key=lambda r: (r['ders'], r['sinif'], r['sira'] if r['sira'] is not None else 999, [int(x) if x.isdigit() else 0 for x in re.findall(r'\w+', r['kazanim_kodu'])]))

    csv_yol = os.path.join(PLAN_DIR, 'kazanimlar_2026_2027.csv')
    with open(csv_yol, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['sinif', 'ders', 'unite', 'konu', 'kazanim_kodu', 'kazanim_aciklamasi', 'sira'])
        w.writeheader()
        w.writerows(satirlar)

    # ── fark raporu ──
    yedek_adi, eski = mevcut_tablo()
    eski_grup = defaultdict(dict)
    for r in eski:
        s = int(re.search(r'\d+', r.get('sinif', '0')).group())
        eski_grup[(r['ders'], s)][kod_normalize(r['kazanim_kodu'])] = r
    yeni_grup = defaultdict(dict)
    for r in satirlar:
        yeni_grup[(r['ders'], int(r['sinif'][0]))][r['kazanim_kodu']] = r

    rp = []
    rp.append('# kazanimlar 2026-2027 fark raporu\n')
    rp.append(f'Karşılaştırılan yedek: `Supabase Yedek/{yedek_adi}` ({len(eski)} satır). Yeni veri: {len(satirlar)} satır.\n')
    rp.append('Kodlar karşılaştırılırken sondaki nokta yok sayıldı (`MAT.7.1.1` = `MAT.7.1.1.`).\n')
    rp.append(f'Planda süreç bileşeni/açıklama olmayıp KAZANIMLAR listesinden alt kazanım eklenen: {alt_eklenen}\n')
    rp.append(f'\nPlanda hiç geçmeyip KAZANIMLAR listesinden (aynı kod düzeniyle) eklenen kazanım: {len(listeden)}\n')
    if listeden:
        rp.append('\n' + '\n'.join('- ' + x for x in listeden) + '\n')
    rp.append('\n## Özet\n\n| Ders | Sınıf | Eski | Yeni | Aynı kod | Sadece eskide | Sadece yenide | Konusu değişen |\n|---|---|---:|---:|---:|---:|---:|---:|\n')
    anahtarlar = sorted(set(eski_grup) | set(yeni_grup))
    detay = []
    for key in anahtarlar:
        e, y = eski_grup.get(key, {}), yeni_grup.get(key, {})
        ortak = set(e) & set(y)
        konu_deg = [k for k in ortak if (e[k].get('konu') or '') != y[k]['konu']]
        kapsam = key in yeni_grup
        rp.append(f'| {key[0]} | {key[1]} | {len(e)} | {len(y)} | {len(ortak)} | {len(set(e) - set(y))} | '
                  f'{len(set(y) - set(e))} | {len(konu_deg)} |' + ('' if kapsam else ' ⚠️ planda yok, dokunulmaz') + '\n')
        if not kapsam:
            continue
        d = [f'\n### {key[0]} — {key[1]}. sınıf\n']
        yeni_konular = list(OrderedDict.fromkeys(r['konu'] for r in sorted(y.values(), key=lambda r: r['sira'] or 0)))
        eski_konular = list(OrderedDict.fromkeys((r.get('konu') or '') for r in e.values()))
        d.append('**Yeni konu listesi (hafta sırasıyla):** ' + ' → '.join(yeni_konular) + '\n\n')
        if eski_konular:
            d.append('**Eski konu listesi:** ' + ' · '.join(eski_konular) + '\n\n')
        if konu_deg:
            d.append('Konusu değişen kodlar:\n\n| Kod | Eski konu | Yeni konu |\n|---|---|---|\n')
            for k in sorted(konu_deg):
                d.append(f"| {k} | {e[k].get('konu')} | {y[k]['konu']} |\n")
        if set(e) - set(y):
            d.append('\nSadece eskide olan (silinecek) kodlar: ' + ', '.join(sorted(set(e) - set(y))[:80]) + '\n')
        if set(y) - set(e):
            d.append('\nYeni eklenecek kodlar: ' + ', '.join(sorted(set(y) - set(e))[:80]) + '\n')
        detay.append(''.join(d))
    rp.extend(detay)
    if uyarilar:
        rp.append('\n## Uyarılar\n\n' + '\n'.join('- ' + u for u in uyarilar) + '\n')
    with open(os.path.join(PLAN_DIR, 'fark_raporu.md'), 'w', encoding='utf-8') as f:
        f.write(''.join(rp))

    # ── migration SQL ──
    kapsam = sorted({(r['ders'], r['sinif']) for r in satirlar})
    mig = []
    mig.append('-- 2026-2027 çerçeve planlarına göre kazanimlar tablosunu yeniler.\n')
    mig.append('-- Üreten: scripts/cerceve_plan_to_kazanim.py — elle düzenlemeyin, betiği yeniden çalıştırın.\n')
    mig.append('-- Supabase SQL Editor\'da tek seferde çalıştırın. Geri almak için: 20260929_kazanimlar_2026_2027_rollback.sql\n\n')
    mig.append('BEGIN;\n\n')
    mig.append('-- 1) Tam yedek (bir kez oluşturulur; tekrar çalıştırmada üzerine yazılmaz)\n')
    mig.append('CREATE TABLE IF NOT EXISTS public.kazanimlar_arsiv_2025_2026 AS TABLE public.kazanimlar;\n')
    mig.append('ALTER TABLE public.kazanimlar_arsiv_2025_2026 ENABLE ROW LEVEL SECURITY;\n')
    mig.append('DROP POLICY IF EXISTS auth_select ON public.kazanimlar_arsiv_2025_2026;\n')
    mig.append('CREATE POLICY auth_select ON public.kazanimlar_arsiv_2025_2026 FOR SELECT TO authenticated USING (true);\n\n')
    mig.append('-- 2) Hafta sırası kolonu\n')
    mig.append('ALTER TABLE public.kazanimlar ADD COLUMN IF NOT EXISTS sira integer;\n\n')
    mig.append('-- 3) Planın kapsadığı ders/sınıf çiftlerini sil\n')
    mig.append('DELETE FROM public.kazanimlar WHERE (ders, sinif) IN (\n  ' +
               ',\n  '.join(f'({sql_str(d)}, {sql_str(s)})' for d, s in kapsam) + '\n);\n\n')
    mig.append('-- 4) Yeni satırlar\n')
    mig.append('INSERT INTO public.kazanimlar (sinif, unite, konu, kazanim_kodu, kazanim_aciklamasi, ders, sira) VALUES\n')
    mig.append(',\n'.join(
        f"({sql_str(r['sinif'])}, {sql_str(r['unite'])}, {sql_str(r['konu'])}, {sql_str(r['kazanim_kodu'])}, "
        f"{sql_str(r['kazanim_aciklamasi'])}, {sql_str(r['ders'])}, {r['sira'] if r['sira'] is not None else 'NULL'})"
        for r in satirlar) + ';\n\n')
    mig.append('-- 5) Eski kayıtlarda sonu noktasız yeni-model kodlarını yeni biçime çek (ör. MAT.7.1.1 -> MAT.7.1.1.)\n')
    mig.append("UPDATE public.yanlis_defteri SET kazanim_kodu = kazanim_kodu || '.'\n"
               " WHERE kazanim_kodu ~ '^[A-ZİÇŞĞÜÖ]+\\.[0-9.]*[0-9]$'\n"
               "   AND EXISTS (SELECT 1 FROM public.kazanimlar k WHERE k.kazanim_kodu = yanlis_defteri.kazanim_kodu || '.');\n\n")
    mig.append('COMMIT;\n')
    with open(os.path.join(MIG_DIR, '20260929_kazanimlar_2026_2027.sql'), 'w', encoding='utf-8') as f:
        f.write(''.join(mig))

    rb = ('-- 20260929_kazanimlar_2026_2027.sql geri alma: kazanimlar tablosunu arşivden geri yükler.\n'
          '-- yanlis_defteri kod düzeltmesi (sona nokta) geri alınmaz; zararsızdır.\n\n'
          'BEGIN;\n'
          'DELETE FROM public.kazanimlar;\n'
          'INSERT INTO public.kazanimlar (sinif, unite, konu, kazanim_kodu, kazanim_aciklamasi, ders)\n'
          '  SELECT sinif, unite, konu, kazanim_kodu, kazanim_aciklamasi, ders FROM public.kazanimlar_arsiv_2025_2026;\n'
          'ALTER TABLE public.kazanimlar DROP COLUMN IF EXISTS sira;\n'
          'COMMIT;\n')
    with open(os.path.join(MIG_DIR, '20260929_kazanimlar_2026_2027_rollback.sql'), 'w', encoding='utf-8') as f:
        f.write(rb)

    print(f'{len(satirlar)} satır yazıldı -> {csv_yol}')
    by = defaultdict(int)
    for r in satirlar:
        by[(r['ders'], r['sinif'])] += 1
    for k in sorted(by):
        print(f'  {k[0]:40s} {k[1]:10s} {by[k]}')
    print(f'Alt kazanım eklenen: {alt_eklenen}; listeden eklenen: {len(listeden)}; uyarı: {len(uyarilar)}')
    for x in listeden:
        print('  +', x)
    for u in uyarilar[:30]:
        print('  !', u)


if __name__ == '__main__':
    main()
