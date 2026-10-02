"""KAZANIMLAR/*.xlsx kazanım listelerinden `kazanimlar` tablosu verisi üretir (tek kaynak bu liste).

Liste düzeni: `Ders Adı | Sınıf | Kazanım Kodu | Ünite/Konu/Kazanım/Alt Kazanım` (5. sınıf Türkçe
ayrı dosyada: `Kod | Metin`). Satırlar kademeli: ünite -> (konu) -> kazanım -> alt kazanım (.A, .B ...).
Bazı sayfalarda kazanımın kendi kodu yok, kod sadece alt kazanımlarda yazılı (T.D.6.4.A -> T.D.6.4).

Çıktılar:
  - KAZANIMLAR/kazanimlar_liste.csv
  - KAZANIMLAR/fark_raporu.md
  - supabase/migrations/20261002_kazanimlar_liste.sql (+ _rollback.sql)

Kullanım:  python scripts/kazanim_listesi_to_kazanim.py
"""
import csv
import json
import os
import re
import sys
from collections import OrderedDict, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cerceve_plan_to_kazanim import (  # noqa: E402
    KOK, MIG_DIR, xlsx_oku, kod_normalize, temiz, baslik_duzelt, mevcut_tablo, sql_str, metin_anahtar, dice,
    MAT, FEN, SOS, ITA, TUR, ING, DIN,
)

LISTE_DIR = os.path.join(KOK, 'KAZANIMLAR')
ARSIV = 'kazanimlar_arsiv_20261002'

SAYFA_DERS = {
    'MATEMATİK': MAT, 'FEN BİLİMLERİ': FEN, 'SOSYAL BİLGİLER': SOS, 'İNKILAP TARİHİ': ITA,
    'TÜRKÇE': TUR, 'İNGİLİZCE': ING, 'DİN KÜLTÜRÜ': DIN,
}
DOSYALAR = [(5, '5.SINIF YENİ.xlsx'), (6, '6.SINIF YENİ.xlsx'), (7, '7.SINIF YENİ.xlsx'), (8, '8.SINIF YENİ.xlsx')]

ALT_RE = re.compile(r'^(.*\d)\s*\.\s*([A-ZÇĞİÖŞÜ])\.?$')       # T.D.6.4.A -> (T.D.6.4, A)
KOD_GECERLI = re.compile(r'^[A-ZÇĞİÖŞÜ]+(?:\.[A-ZÇĞİÖŞÜ]+)*\s?\.?\s?\d+(?:\s?\.\s?\d+)*\.?$')
ING_BECERI = {'listening', 'spoken interaction', 'spoken production', 'reading', 'writing', 'speaking'}
TUR_BECERI_UNITE = {'OKUMA', 'YAZMA', 'KONUŞMA', 'DİNLEME', 'DİNLEME/İZLEME'}


def onek(kod):
    """Kodun harf ön eki, eşdeğer önekler birleştirilmiş: MAT.7.1.1 / M.7.1.1 -> 'M', T.D.6.2 -> 'TD'."""
    harfler = re.sub(r'[\d.\s]', '', re.match(r'^[^\d]*', kod).group())
    return {'MAT': 'M', 'FB': 'F', 'ENG': 'E'}.get(harfler, harfler)


def kod_temizle(k):
    return re.sub(r'\s+', '', (k or '').replace('\xa0', ' ')).rstrip('.')


def buyuk_mu(s):
    # 'TEKNOLOJİ ve SOSYAL BİLİMLER' de büyük harfli başlık sayılır (bağlaçlar hariç)
    kelimeler = [w for w in re.findall(r'\w+', s) if w.lower() not in ('ve', 'ile', 'and', 'of', 'the')]
    return bool(kelimeler) and all(w == w.upper() for w in kelimeler) and any(c.isalpha() for c in s)


def baslik_yaz(s, ders):
    if not s:
        return ''
    if buyuk_mu(s) and s != s.upper():
        s = s.upper().replace('i', 'İ')
    s = baslik_duzelt(s, ingilizce=(ders == ING))
    if ders == ING:
        s = re.sub(r'(?<=\s)(And|Of|The|In|At|On|For)(?=\s)', lambda m: m.group(1).lower(), s)
    # 'Dinleme/izleme' -> 'Dinleme/İzleme' (Türkçe büyük harf: i -> İ)
    return re.sub(r'/(\w)', lambda m: '/' + ('İ' if m.group(1) == 'i' else m.group(1).upper()), s)


def satirlari_oku():
    """[(ders, sinif, [(kod, metin), ...]), ...]"""
    sayfalar = []
    for sinif, dosya in DOSYALAR:
        for ad, rows in xlsx_oku(os.path.join(LISTE_DIR, dosya)).items():
            ders = SAYFA_DERS.get(ad.strip())
            if not ders:
                sys.exit(f'HATA: tanınmayan sayfa {dosya} / {ad}')
            sayfalar.append((ders, sinif, [(r[2] if len(r) > 2 else '', r[3] if len(r) > 3 else '')
                                           for _, r in rows[1:]]))
    rows = xlsx_oku(os.path.join(LISTE_DIR, '5. sınıf türkçe.xlsx'))
    for ad, satirlar in rows.items():
        sayfalar.append((TUR, 5, [(r[0], r[1] if len(r) > 1 else '') for _, r in satirlar]))
    return sayfalar


def sayfa_isle(ders, sinif, satirlar, uyarilar):
    # boşları at, metni temizle
    sat = [(kod_temizle(k), re.sub(r'\s+', ' ', temiz(m).replace('\n', ' ')).strip()) for k, m in satirlar]
    sat = [(k, m) for k, m in sat if m]
    kazanimlar = OrderedDict()
    unite, konu = '', ''
    bekleyen = None          # kodsuz metin: başlık mı, kodu alt kazanımda olan kazanım mı?
    son_kaz = None

    kazanim_var = False      # son ünite başlığından beri kazanım eklendi mi

    def baslik_uygula(metin, seviye):
        nonlocal unite, konu, kazanim_var
        metin = re.sub(r'^(?:\d+\s*\.\s*)?(?:ÖĞRENME ALANI|ÜNİTE|TEMA)\s*:\s*', '', metin, flags=re.I).strip()
        if ders == ING:
            # İngilizce: beceri başlıkları (Listening, Reading…) konu değildir; tema başlığı ünite olur,
            # 'School Life: Listening…' gibi iki noktalı başlıklar konu olur
            if metin.lower() in ING_BECERI:
                return
            seviye = 'konu' if (':' in metin and unite) else 'unite'
        elif ders == TUR and seviye == 'konu' and unite.upper() in TUR_BECERI_UNITE:
            return  # Türkçe: 'OKUMA' altındaki 'AKICI OKUMA' gibi ara başlıklar konuyu bölmesin
        elif seviye == 'unite' and unite and not kazanim_var:
            if ders == TUR and unite.upper() in TUR_BECERI_UNITE:
                return
            seviye = 'konu'  # art arda iki büyük harfli başlık: ikincisi konu ('OKUMA' > 'AKICI OKUMA')
        if seviye == 'unite':
            unite, konu, kazanim_var = metin, '', False
        else:
            konu = metin

    def kazanim_ekle(kod, metin):
        nonlocal son_kaz, kazanim_var
        kazanim_var = True
        kod_n = kod_normalize(kod)
        if kod_n in kazanimlar:
            son_kaz = kazanimlar[kod_n]
            return
        son_kaz = kazanimlar[kod_n] = {
            'kod': kod_n, 'metin': metin, 'altlar': [],
            'unite': baslik_yaz(unite, ders),
            'konu': baslik_yaz(konu or unite, ders),
            'sira': len(kazanimlar) + 1,
        }

    for i, (kod, metin) in enumerate(sat):
        alt = ALT_RE.match(kod) if kod else None
        sonraki = sat[i + 1] if i + 1 < len(sat) else ('', '')

        if alt:
            ana_kod, harf = alt.group(1), alt.group(2)
            if bekleyen is not None:
                # kodsuz satır aslında kazanımdı; kodu alt kazanımdan türet
                kazanim_ekle(ana_kod, bekleyen)
                bekleyen = None
            elif son_kaz is None or kod_normalize(ana_kod) != son_kaz['kod']:
                uyarilar.append(f'{ders} {sinif}: {kod} alt kazanımının üst kazanımı bulunamadı, atlandı')
                continue
            son_kaz['altlar'].append((harf, metin))
            continue

        # alt değil: önce bekleyen kodsuz satırı başlık olarak kapat
        if bekleyen is not None:
            baslik_uygula(bekleyen, 'unite' if buyuk_mu(bekleyen) else 'konu')
            bekleyen = None

        if not kod or not KOD_GECERLI.match(kod) or not re.search(r'[A-ZÇĞİÖŞÜ]', kod):
            # kodsuz (veya '6.1' gibi önek taşımayan) satır
            if kod and not KOD_GECERLI.match(kod) and not re.fullmatch(r'[\d.]+', kod):
                uyarilar.append(f'{ders} {sinif}: tanınmayan kod {kod!r} başlık sayıldı: {metin[:50]}')
            if not kod and sonraki[0] and kod_temizle(sonraki[0]) and \
                    re.sub(r'\W', '', sonraki[1].lower()) == re.sub(r'\W', '', metin.lower()):
                continue  # 'Görselle iletilen…' + hemen ardından aynı metin kodlu: tekrar
            if kod:
                baslik_uygula(metin, 'unite')
            else:
                bekleyen = metin
            continue

        # kodlu, alt olmayan satır: çocuğu varsa başlık, yoksa kazanım.
        # Cümle gibi biten ('… kurar.') kodlu satır çocuğu olsa da kazanımdır.
        sonraki_kodlar = [kod_normalize(kod_temizle(k)) for k, _ in sat[i + 1:i + 4] if kod_temizle(k)]
        cocuk_var = any(k.startswith(kod_normalize(kod)) and not ALT_RE.match(k.rstrip('.'))
                        for k in sonraki_kodlar[:1])
        if cocuk_var and not metin.endswith('.'):
            ust_seviye = len(re.findall(r'\d+', kod)) <= 2 and buyuk_mu(metin)
            baslik_uygula(metin, 'unite' if ust_seviye or not unite else 'konu')
            continue
        kazanim_ekle(kod, metin)

    if bekleyen is not None:
        uyarilar.append(f'{ders} {sinif}: sondaki kodsuz satır atlandı: {bekleyen[:60]}')
    return kazanimlar


def main():
    uyarilar = []
    satirlar = []
    gorulen_kod = {}
    for ders, sinif, sat in satirlari_oku():
        kz = sayfa_isle(ders, sinif, sat, uyarilar)
        for k in kz.values():
            if k['kod'] in gorulen_kod:
                sys.exit(f"HATA: {k['kod']} iki kez: {gorulen_kod[k['kod']]} ve {ders} {sinif}")
            gorulen_kod[k['kod']] = (ders, sinif)
            aciklama = k['metin']
            # alt kazanımlar ayrı tutulur: [{"kod": "M.7.2.1.A", "metin": "..."}] (ders işlemede tek tek işaretlenir)
            altlar = [{'kod': k['kod'] + h, 'metin': m} for h, m in k['altlar']]
            satirlar.append({
                'sinif': f'{sinif}. Sınıf', 'ders': ders, 'unite': k['unite'], 'konu': k['konu'] or k['unite'],
                'kazanim_kodu': k['kod'], 'kazanim_aciklamasi': aciklama, 'sira': k['sira'],
                'alt_kazanimlar': json.dumps(altlar, ensure_ascii=False) if altlar else '',
            })

    with open(os.path.join(LISTE_DIR, 'kazanimlar_liste.csv'), 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['sinif', 'ders', 'unite', 'konu', 'kazanim_kodu', 'kazanim_aciklamasi', 'sira', 'alt_kazanimlar'])
        w.writeheader()
        w.writerows(satirlar)

    # ── fark raporu (son yerel yedeğe göre) ──
    yedek_adi, eski = mevcut_tablo()
    eski_grup, yeni_grup = defaultdict(dict), defaultdict(dict)
    for r in eski:
        eski_grup[(r['ders'], int(re.search(r'\d+', r['sinif']).group()))][kod_normalize(r['kazanim_kodu'])] = r
    for r in satirlar:
        yeni_grup[(r['ders'], int(r['sinif'][0]))][r['kazanim_kodu']] = r
    rp = ['# kazanimlar — KAZANIMLAR listesine göre fark raporu\n\n',
          f'Karşılaştırılan yedek: `Supabase Yedek/{yedek_adi}` ({len(eski)} satır). Yeni veri: {len(satirlar)} satır.\n\n',
          '| Ders | Sınıf | Eski | Yeni | Aynı kod | Sadece eskide | Sadece yenide |\n|---|---|---:|---:|---:|---:|---:|\n']
    detay = []
    for key in sorted(set(eski_grup) | set(yeni_grup)):
        e, y = eski_grup.get(key, {}), yeni_grup.get(key, {})
        rp.append(f'| {key[0]} | {key[1]} | {len(e)} | {len(y)} | {len(set(e) & set(y))} | {len(set(e) - set(y))} | {len(set(y) - set(e))} |'
                  + ('' if y else ' ⚠️ listede yok, dokunulmaz') + '\n')
        if not y:
            continue
        konular = list(OrderedDict.fromkeys(r['konu'] for r in sorted(y.values(), key=lambda r: r['sira'])))
        detay.append(f'\n### {key[0]} — {key[1]}. sınıf ({len(y)} kazanım)\n\n**Konular (listedeki sırayla):** '
                     + ' → '.join(konular) + '\n')
    rp.extend(detay)
    if uyarilar:
        rp.append('\n## Uyarılar\n\n' + '\n'.join('- ' + u for u in uyarilar) + '\n')
    with open(os.path.join(LISTE_DIR, 'fark_raporu.md'), 'w', encoding='utf-8') as f:
        f.write(''.join(rp))

    # ── migration ──
    kapsam = sorted({(r['ders'], r['sinif']) for r in satirlar})
    mig = [
        '-- kazanimlar tablosunu KAZANIMLAR/*.xlsx listelerine göre yeniler (tek kaynak bu liste).\n',
        '-- Üreten: scripts/kazanim_listesi_to_kazanim.py — elle düzenlemeyin, betiği yeniden çalıştırın.\n',
        '-- 20260929_kazanimlar_2026_2027.sql çalıştırılmış olsun ya da olmasın bunu tek başına çalıştırabilirsiniz.\n',
        f'-- Geri almak için: 20261002_kazanimlar_liste_rollback.sql\n\nBEGIN;\n\n',
        '-- 1) Çalıştırma anındaki tablonun tam yedeği\n',
        f'CREATE TABLE IF NOT EXISTS public.{ARSIV} AS TABLE public.kazanimlar;\n',
        f'ALTER TABLE public.{ARSIV} ENABLE ROW LEVEL SECURITY;\n',
        f'DROP POLICY IF EXISTS auth_select ON public.{ARSIV};\n',
        f'CREATE POLICY auth_select ON public.{ARSIV} FOR SELECT TO authenticated USING (true);\n\n',
        '-- 2) Yeni kolonlar: sira (listedeki sıra), alt_kazanimlar (kod+metin listesi),\n'
        '--    dersler.alt_kazanim_kodlari (o derste işaretlenen alt kazanımlar)\n'
        'ALTER TABLE public.kazanimlar ADD COLUMN IF NOT EXISTS sira integer;\n'
        'ALTER TABLE public.kazanimlar ADD COLUMN IF NOT EXISTS alt_kazanimlar jsonb;\n'
        'ALTER TABLE public.dersler ADD COLUMN IF NOT EXISTS alt_kazanim_kodlari text[];\n\n',
        '-- 3) Listenin kapsadığı ders/sınıf çiftlerini sil\nDELETE FROM public.kazanimlar WHERE (ders, sinif) IN (\n  '
        + ',\n  '.join(f'({sql_str(d)}, {sql_str(s)})' for d, s in kapsam) + '\n);\n\n',
        '-- 4) Yeni satırlar\nINSERT INTO public.kazanimlar (sinif, unite, konu, kazanim_kodu, kazanim_aciklamasi, ders, sira, alt_kazanimlar) VALUES\n',
        ',\n'.join(f"({sql_str(r['sinif'])}, {sql_str(r['unite'])}, {sql_str(r['konu'])}, {sql_str(r['kazanim_kodu'])}, "
                   f"{sql_str(r['kazanim_aciklamasi'])}, {sql_str(r['ders'])}, {r['sira']}, "
                   f"{(sql_str(r['alt_kazanimlar']) + '::jsonb') if r['alt_kazanimlar'] else 'NULL'})" for r in satirlar) + ';\n\n',
        'COMMIT;\n',
    ]
    with open(os.path.join(MIG_DIR, '20261002_kazanimlar_liste.sql'), 'w', encoding='utf-8') as f:
        f.write(''.join(mig))
    with open(os.path.join(MIG_DIR, '20261002_kazanimlar_liste_rollback.sql'), 'w', encoding='utf-8') as f:
        f.write('-- 20261002_kazanimlar_liste.sql geri alma: kazanimlar tablosunu o migration öncesi hâline döndürür.\n\n'
                '-- (sira kolonu kalır; arşivde sira yoksa geri yüklenen satırlarda boş olur, sıralama eski usule döner)\n\n'
                'BEGIN;\nDELETE FROM public.kazanimlar;\n'
                'INSERT INTO public.kazanimlar (sinif, unite, konu, kazanim_kodu, kazanim_aciklamasi, ders)\n'
                f'  SELECT sinif, unite, konu, kazanim_kodu, kazanim_aciklamasi, ders FROM public.{ARSIV};\n'
                'COMMIT;\n')

    # ── isteğe bağlı: geçmiş kayıtlardaki eski kodları yeni kodlara çevir ──
    # Eski tablodaki (yedek) her kodu, aynı ders/sınıftaki yeni kazanımlardan metni en benzer olana eşler.
    eslesme = []
    for key, e in eski_grup.items():
        y = yeni_grup.get(key, {})
        for eski_kod, er in e.items():
            if eski_kod in y or not y:
                continue
            # sadece ana metin (20260929 migration'ı açıklamaya a) b) satırlarını da eklemişti)
            a = metin_anahtar(re.split(r'\\r\\n|\\n|\r?\n', er.get('kazanim_aciklamasi') or '')[0])
            aday, skor = None, 0.0
            for yk, yr in y.items():
                s = dice(a, metin_anahtar(yr['kazanim_aciklamasi'].split('\n')[0]))
                # numarası da aynıysa (MAT.7.1.1 ~ M.7.1.1) küçük ifade farkları tolere edilir
                if re.findall(r'\d+', eski_kod) == re.findall(r'\d+', yk) and onek(eski_kod) == onek(yk) and s >= 0.6:
                    s = max(s, 0.9)
                if s > skor:
                    aday, skor = yr, s
            if aday and skor >= 0.88:
                eslesme.append((eski_kod, aday['kazanim_kodu'], aday['konu'], skor))
    gecmis = [
        '-- İSTEĞE BAĞLI: 20261002_kazanimlar_liste.sql SONRASINDA çalıştırın.\n',
        '-- Geçmiş ödev/ders/yanlış defteri kayıtlarındaki eski kazanım kodlarını (MAT.7.1.1 gibi)\n',
        '-- metni aynı olan yeni kodlara (M.7.1.1.) çevirir; konu adı yeni listede yoksa onu da yeni konuya çeker.\n',
        '-- Kaynak kitaptan (kaynak_konu_id dolu) verilen ödevlerin konu metnine dokunmaz.\n\nBEGIN;\n\n',
        'CREATE TEMP TABLE kod_esleme (eski text, yeni text, yeni_konu text) ON COMMIT DROP;\n',
        'INSERT INTO kod_esleme VALUES\n' + ',\n'.join(
            f"({sql_str(e.rstrip('.'))}, {sql_str(y)}, {sql_str(k)})" for e, y, k, _ in sorted(eslesme)) + ';\n\n',
        "UPDATE public.odevler o SET kazanim = m.yeni,\n"
        "  konu = CASE WHEN o.kaynak_konu_id IS NULL AND o.konu NOT IN (SELECT konu FROM public.kazanimlar WHERE konu IS NOT NULL)\n"
        "              THEN m.yeni_konu ELSE o.konu END\n"
        "  FROM kod_esleme m WHERE rtrim(o.kazanim, '.') = m.eski;\n\n",
        "UPDATE public.dersler d SET kazanim_kodu = m.yeni,\n"
        "  islenen_konu = CASE WHEN d.islenen_konu NOT IN (SELECT konu FROM public.kazanimlar WHERE konu IS NOT NULL)\n"
        "                      THEN m.yeni_konu ELSE d.islenen_konu END\n"
        "  FROM kod_esleme m WHERE rtrim(d.kazanim_kodu, '.') = m.eski;\n\n",
        "UPDATE public.yanlis_defteri y SET kazanim_kodu = m.yeni,\n"
        "  konu = CASE WHEN y.konu NOT IN (SELECT konu FROM public.kazanimlar WHERE konu IS NOT NULL)\n"
        "              THEN m.yeni_konu ELSE y.konu END\n"
        "  FROM kod_esleme m WHERE rtrim(y.kazanim_kodu, '.') = m.eski;\n\nCOMMIT;\n",
    ]
    if eslesme:
        with open(os.path.join(MIG_DIR, '20261002_kazanimlar_liste_gecmis_kodlar.sql'), 'w', encoding='utf-8') as f:
            f.write(''.join(gecmis))
    with open(os.path.join(LISTE_DIR, 'fark_raporu.md'), 'a', encoding='utf-8') as f:
        f.write(f'\n## Eski kod → yeni kod eşlemesi ({len(eslesme)} kod, metin benzerliğiyle)\n\n'
                '| Eski | Yeni | Yeni konu | Benzerlik |\n|---|---|---|---:|\n'
                + ''.join(f'| {e} | {y} | {k} | %{int(s * 100)} |\n' for e, y, k, s in sorted(eslesme)))

    print(f'{len(satirlar)} satır; eski→yeni kod eşlemesi: {len(eslesme)}')
    say = defaultdict(int)
    for r in satirlar:
        say[(r['ders'], r['sinif'])] += 1
    for k in sorted(say):
        print(f'  {k[0]:40s} {k[1]:10s} {say[k]}')
    print(f'uyarı: {len(uyarilar)}')
    for u in uyarilar:
        print('  !', u)


if __name__ == '__main__':
    main()
