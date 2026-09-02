import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Kamera ile kaynak ekleme akışının OCR fonksiyonu.
//
// MİMARİ (V4 — fotoğraf başına ayrı istek):
//  - Kapak, içindekiler ve cevap anahtarı fotoğraflarının HER BİRİ kendi bağımsız
//    Gemini isteği olarak işlenir. Tek dev "parts" isteği yerine küçük, şemayla
//    kısıtlanmış çok sayıda istek → uzun listelerde kesilme/başarısızlık biter.
//  - İçindekiler/cevap anahtarı fotoğrafları gruplar halinde paralel işlenir
//    (PARALEL_LIMIT) — Gemini rate limit'ine takılmamak için.
//  - Sonuçlar burada birleştirilir, frontend'e ESKİSİYLE AYNI formatta döner:
//      { kaynak_adi, yayin_evi, sinif, konu_listesi:[{konu_adi,sayfa_no}],
//        cevap_anahtari:[{test_no,sayfa_no,cevaplar:[...]}], uyarilar:[], hatalar:[] }
//  - Kısmi hata yönetimi: bir fotoğraf başarısız olursa yalnızca o fotoğraf için
//    "hatalar" dizisine mesaj eklenir, diğerlerinin sonucu korunur. Yalnızca HİÇBİR
//    istek başarılı olmadıysa üst düzey { error } (502) döner.
//  - Eksiksiz çıkarma: her içindekiler/cevap isteği kendi "toplam_satir_sayisi"
//    değerini döndürür; liste uzunluğu bu sayıyla uyuşmazsa 1 kez otomatik retry
//    yapılır, hâlâ uyuşmazsa "uyarilar" dizisine "eksik olabilir" notu eklenir.
//
// ada-chat'teki Anthropic-uyumlu sohbet/tool-calling katmanından bağımsızdır.

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Bir "Tümünü Analiz Et" çağrısında Gemini'ye aynı anda gönderilecek en fazla istek.
const PARALEL_LIMIT = 4;
// Fotoğraf başına çıktı zaten küçük; 65536 pratik olarak hiç zorlanmayacak, güvenlik payı.
const MAX_OUTPUT_TOKENS = 65536;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Prompt & şemalar (fotoğraf türü başına ayrı) ──────────────────────────────

const SAYIM_KURALI =
  "\n\nKURAL: Fotoğrafta gördüğün HER SATIRI, HER KONUYU, HER TEST SORUSUNU eksiksiz çıkar. " +
  "Asla 'örnek olarak birkaçını' listeleme, asla özetleme, asla 'vb.' ile kısaltma yapma. " +
  "Görüntüde 40 öğe varsa 40 öğe döndür, 5 değil. Bu kritik bir gereksinimdir.\n" +
  "Adım 1: Önce fotoğrafta kaç satır/konu/soru gördüğünü say ve bu sayıyı toplam_satir_sayisi alanına yaz.\n" +
  "Adım 2: Tam olarak o sayıda öğe içeren bir liste döndür.\n" +
  "Liste uzunluğun toplam_satir_sayisi ile eşleşmiyorsa tekrar say ve düzelt.";

const KAPAK_PROMPT =
  "Sen bir ders kaynağı (soru bankası / deneme kitabı) kataloglama asistanısın. " +
  "Verilen KAPAK fotoğrafından kaynağın adını (kaynak_adi), yayınevini/yazarını (yayin_evi) ve " +
  "hedeflediği sınıfı (sinif, '5. Sınıf' - '8. Sınıf' formatında) çıkar. " +
  "Emin olmadığın alanı boş bırak, uydurma.";

const KAPAK_SCHEMA = {
  type: "OBJECT",
  properties: {
    kaynak_adi: { type: "STRING" },
    yayin_evi: { type: "STRING" },
    sinif: { type: "STRING" },
  },
  required: ["kaynak_adi"],
};

const ICINDEKILER_PROMPT =
  "Sen bir ders kaynağı kataloglama asistanısın. Verilen TEK bir İÇİNDEKİLER fotoğrafından " +
  "ana konu başlıklarını ve yanlarındaki sayfa numaralarını çıkar (konular dizisi). " +
  "Alt başlıkları değil ana başlıkları al; sayfa numarası okunamıyorsa sayfa_no'yu boş bırak. " +
  "'Cevap Anahtarı', 'Önsöz', 'İçindekiler', 'Kaynakça' gibi konu olmayan satırları listeye ekleme." +
  SAYIM_KURALI;

const ICINDEKILER_SCHEMA = {
  type: "OBJECT",
  properties: {
    toplam_satir_sayisi: { type: "INTEGER" },
    konular: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          konu_adi: { type: "STRING" },
          sayfa_no: { type: "INTEGER" },
        },
        required: ["konu_adi"],
      },
    },
  },
  required: ["konular", "toplam_satir_sayisi"],
};

const CEVAP_PROMPT =
  "Sen bir ders kaynağı kataloglama asistanısın. Verilen TEK bir CEVAP ANAHTARI fotoğrafından " +
  "her testi çıkar (testler dizisi): test numarası (test_no), bulunduğu sayfa numarası (sayfa_no) ve " +
  "sıradaki cevaplar (A/B/C/D/E) dizisi (cevaplar). Okunamayan alanı boş bırak." +
  SAYIM_KURALI;

const CEVAP_SCHEMA = {
  type: "OBJECT",
  properties: {
    toplam_satir_sayisi: { type: "INTEGER" },
    testler: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          test_no: { type: "INTEGER" },
          sayfa_no: { type: "INTEGER" },
          cevaplar: { type: "ARRAY", items: { type: "STRING" } },
        },
      },
    },
  },
  required: ["testler", "toplam_satir_sayisi"],
};

// ── Yardımcılar ──────────────────────────────────────────────────────────────

type Gorsel = { mimeType: string; data: string };

function gecerliGorselDizisi(v: unknown): v is Gorsel[] {
  return Array.isArray(v) && v.every((img: any) => img?.mimeType && img?.data);
}

function hataYaniti(mesaj: string, status: number) {
  return new Response(JSON.stringify({ error: mesaj }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Tek fotoğraf + tek şema için tek Gemini isteği. Hata durumunda anlamlı mesajla throw eder.
async function geminiCagir(
  apiKey: string,
  sistemPrompt: string,
  schema: unknown,
  img: Gorsel,
): Promise<any> {
  const body = {
    contents: [{
      role: "user",
      parts: [
        { text: sistemPrompt },
        { inlineData: { mimeType: img.mimeType, data: img.data } },
      ],
    }],
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  };

  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });

  const responseData = await response.json();
  if (!response.ok) {
    throw new Error(responseData?.error?.message || "Gemini API hatası");
  }

  const candidate = responseData?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = responseData?.promptFeedback?.blockReason ||
      candidate?.finishReason || "bilinmeyen neden";
    throw new Error(`Gemini yanıt üretmedi (${reason})`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      candidate?.finishReason === "MAX_TOKENS"
        ? "Gemini yanıtı çok uzun olduğu için kesildi"
        : "Gemini yanıtı geçerli JSON değil",
    );
  }
}

// Sayım doğrulamalı çağrı: liste uzunluğu toplam_satir_sayisi ile uyuşmazsa 1 kez retry;
// retry daha çok öğe çıkarırsa onu kullanır. Sonuç hâlâ kendi sayımıyla uyuşmazsa eksik=true.
async function sayimliCagir(
  apiKey: string,
  prompt: string,
  schema: unknown,
  img: Gorsel,
  listeAlani: "konular" | "testler",
): Promise<{ liste: any[]; eksik: boolean }> {
  const listeOf = (r: any) => (Array.isArray(r?.[listeAlani]) ? r[listeAlani] : []);
  const uyumlu = (r: any) => {
    const beklenen = Number(r?.toplam_satir_sayisi) || 0;
    return beklenen > 0 && listeOf(r).length === beklenen;
  };

  const ilk = await geminiCagir(apiKey, prompt, schema, img);
  let secili = ilk;

  if (!uyumlu(ilk)) {
    try {
      const tekrar = await geminiCagir(
        apiKey,
        prompt +
          "\n\nUYARI: Önceki denemende liste eksikti (sayım ile liste uzunluğu uyuşmadı). " +
          "Bu sefer istisnasız TÜM satırları çıkar.",
        schema,
        img,
      );
      if (listeOf(tekrar).length >= listeOf(secili).length) secili = tekrar;
    } catch {
      // retry başarısız — ilk sonucu koru
    }
  }

  return { liste: listeOf(secili), eksik: !uyumlu(secili) };
}

// items'ı limit boyutlu gruplara böler, her grubu Promise.all ile paralel işler.
async function gruplarHalinde<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const sonuc: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const grup = items.slice(i, i + limit);
    const grupSonuc = await Promise.all(grup.map((item, j) => fn(item, i + j)));
    sonuc.push(...grupSonuc);
  }
  return sonuc;
}

// ── HTTP handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return hataYaniti("GEMINI_API_KEY ortam değişkeni tanımlı değil.", 500);
    }

    const body = await req.json();
    const { kapak, icindekiler, cevap_anahtari } = body;

    // kapak: yeni-kaynak akışında tam 1 foto; "zenginleştirme" akışında (Bölüm 4)
    // hiç gönderilmeyebilir. Verildiyse dizi ve en fazla 1 öğe olmalı.
    if (kapak !== undefined && (!gecerliGorselDizisi(kapak) || kapak.length > 1)) {
      return hataYaniti("kapak: en fazla 1 fotoğraf ({ mimeType, data }) olmalı.", 400);
    }
    if (!gecerliGorselDizisi(icindekiler) || !icindekiler.length) {
      return hataYaniti("icindekiler: en az 1 fotoğraf ({ mimeType, data }) gerekli.", 400);
    }
    if (cevap_anahtari !== undefined && !gecerliGorselDizisi(cevap_anahtari)) {
      return hataYaniti("cevap_anahtari: { mimeType, data } öğelerinden oluşan bir dizi olmalı.", 400);
    }

    const kapakGorselleri: Gorsel[] = Array.isArray(kapak) ? kapak : [];
    const icindekilerGorselleri: Gorsel[] = icindekiler;
    const cevapGorselleri: Gorsel[] = cevap_anahtari || [];

    const hatalar: string[] = [];
    const uyarilar: string[] = [];
    let basariliCagri = 0;

    // 1) KAPAK — tek istek
    let kaynakAdi = "", yayinEvi = "", sinif = "";
    if (kapakGorselleri.length) {
      try {
        const k = await geminiCagir(apiKey, KAPAK_PROMPT, KAPAK_SCHEMA, kapakGorselleri[0]);
        kaynakAdi = k?.kaynak_adi || "";
        yayinEvi = k?.yayin_evi || "";
        sinif = k?.sinif || "";
        basariliCagri++;
      } catch (e) {
        hatalar.push(`Kapak fotoğrafı okunamadı: ${(e as Error).message}`);
      }
    }

    // 2) İÇİNDEKİLER — her foto ayrı istek, gruplar halinde paralel, foto sırası korunur
    const icSonuclar = await gruplarHalinde(
      icindekilerGorselleri,
      PARALEL_LIMIT,
      (img, i) =>
        sayimliCagir(apiKey, ICINDEKILER_PROMPT, ICINDEKILER_SCHEMA, img, "konular")
          .then((r) => ({ i, ...r }))
          .catch((e) => ({ i, hata: (e as Error).message })),
    );

    const konuListesi: { konu_adi: string; sayfa_no: number | null }[] = [];
    icSonuclar
      .sort((a: any, b: any) => a.i - b.i)
      .forEach((r: any) => {
        if (r.hata) {
          hatalar.push(`İçindekiler fotoğraf ${r.i + 1} okunamadı: ${r.hata}`);
          return;
        }
        basariliCagri++;
        if (r.eksik) {
          uyarilar.push(
            `İçindekiler fotoğraf ${r.i + 1}: bazı satırlar eksik çıkarılmış olabilir, kontrol edin.`,
          );
        }
        (r.liste || []).forEach((k: any) => {
          konuListesi.push({ konu_adi: k?.konu_adi || "", sayfa_no: k?.sayfa_no ?? null });
        });
      });

    // 3) CEVAP ANAHTARI — her foto ayrı istek; test_no'ya göre birleştir + sırala
    const cevapAnahtari: { test_no: number | null; sayfa_no: number | null; cevaplar: string[] }[] = [];
    if (cevapGorselleri.length) {
      const caSonuclar = await gruplarHalinde(
        cevapGorselleri,
        PARALEL_LIMIT,
        (img, i) =>
          sayimliCagir(apiKey, CEVAP_PROMPT, CEVAP_SCHEMA, img, "testler")
            .then((r) => ({ i, ...r }))
            .catch((e) => ({ i, hata: (e as Error).message })),
      );

      const testMap = new Map<string, any>();
      caSonuclar
        .sort((a: any, b: any) => a.i - b.i)
        .forEach((r: any) => {
          if (r.hata) {
            hatalar.push(`Cevap anahtarı fotoğraf ${r.i + 1} okunamadı: ${r.hata}`);
            return;
          }
          basariliCagri++;
          if (r.eksik) {
            uyarilar.push(
              `Cevap anahtarı fotoğraf ${r.i + 1}: bazı testler eksik olabilir, kontrol edin.`,
            );
          }
          (r.liste || []).forEach((t: any) => {
            const anahtar = t?.test_no != null ? `t${t.test_no}` : `_${testMap.size}`;
            if (!testMap.has(anahtar)) {
              testMap.set(anahtar, {
                test_no: t?.test_no ?? null,
                sayfa_no: t?.sayfa_no ?? null,
                cevaplar: Array.isArray(t?.cevaplar) ? t.cevaplar : [],
              });
            }
          });
        });

      cevapAnahtari.push(
        ...[...testMap.values()].sort(
          (a, b) => (a.test_no ?? Number.MAX_SAFE_INTEGER) - (b.test_no ?? Number.MAX_SAFE_INTEGER),
        ),
      );
    }

    // Hiçbir istek başarılı olmadıysa üst düzey hata
    if (basariliCagri === 0) {
      return hataYaniti(
        hatalar.length ? hatalar.join(" · ") : "Hiçbir fotoğraf işlenemedi.",
        502,
      );
    }

    return new Response(
      JSON.stringify({
        kaynak_adi: kaynakAdi,
        yayin_evi: yayinEvi,
        sinif: sinif,
        konu_listesi: konuListesi,
        cevap_anahtari: cevapAnahtari,
        uyarilar,
        hatalar,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return hataYaniti((err as Error).message || "Beklenmeyen hata", 500);
  }
});
