import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Deneme sonuç belgesi (karne) OCR fonksiyonu.
//
// Öğretmen bir deneme sonuç belgesinin (fotoğraf ya da PDF) fotoğrafını/dosyasını
// yükler. Belgede birden fazla ders yan yana olabilir (her karne farklı bir
// yerleşime sahip olabileceğinden SABİT KOORDİNAT VARSAYILMAZ) — Gemini'den
// öğretmenin branşına semantik olarak en yakın satırı bulması istenir
// (örn. "MATEMATİK" == "İlköğretim Matematik").
//
// soru-analiz ile AYNI KAPALI LİSTE deseni: kazanım eşleştirmesi yalnızca
// frontend'den gönderilen kazanimlar listesi içinden yapılır, model listede
// olmayan bir kazanım UYDURAMAZ — sunucu tarafında da bu kural tekrar doğrulanır.
//
// net/başarı% burada HESAPLANMAZ — ham doğru/yanlış/boş döner, frontend zaten
// denemeNetHesapla() ile aynı formülü uyguluyor (tutarlılık tek yerde kalsın diye).
//
// kaynak-ocr ile aynı çağrı altyapısı: responseSchema ile kısıtlanmış JSON,
// geçici (429/503) hatalarda artan bekleme ile 3 deneme, süre bütçesi koruması.

const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MAX_OUTPUT_TOKENS = 8192;
// Tek belge (foto veya PDF), tek istek — kaynak-ocr'daki çoklu-foto bütçesinden
// daha küçük tutulabilir; yine de çok sayfalı PDF ihtimaline karşı cömert.
const SURE_BUTCESI_MS = 60_000;
const ISTEK_TIMEOUT_MS = 55_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SISTEM_PROMPT_SABIT =
  "Sen bir deneme sınavı sonuç belgesi (karne) okuma asistanısın. Öğretmenin branşı: " +
  "{BRANS}.\n\n" +
  "Belgede genellikle DERS BAZLI BİR ÖZET TABLOSU vardır: Ders | Soru | Doğru | Yanlış | " +
  "Boş | Net | % gibi sütunlar, birden fazla ders yan yana olabilir. HER KARNE FARKLI " +
  "TASARIMDA OLABİLİR — sabit bir konum/sütun sırası varsayma, tabloyu anlamına göre bul.\n\n" +
  "GÖREV 1 — Ders eşleştirme: Tablodaki derslerden hangisinin '{BRANS}' branşına karşılık " +
  "geldiğini belirle. Ders adları karnede farklı yazılmış olabilir (örn. 'MATEMATİK' → " +
  "'İlköğretim Matematik', 'FEN BİLİMLERİ' → 'Fen Bilimleri', 'İNKILAP' veya 'T.C. İNKILAP " +
  "TARİHİ' → 'T.C. İnkılap Tarihi ve Atatürkçülük'). En yakın anlamlı eşleşmeyi seç. Eşleşen " +
  "satırdan SORU, DOĞRU, YANLIŞ, BOŞ sayılarını çıkar (soru, dogru, yanlis, bos). NET veya " +
  "BAŞARI YÜZDESİ değerlerini KENDİN HESAPLAMA/DÜZELTME — sadece ham sayıları çıkar. Branşa " +
  "ait bir satır belgede yoksa dogru/yanlis/bos/soru alanlarını 0 bırak, ders_eslesme_guveni'ni " +
  "0'a yakın tut ve uyarilar dizisine 'Branşa ait sonuç satırı bulunamadı' benzeri bir not ekle. " +
  "Eşleşmene ne kadar güvendiğini 0-1 arasında ders_eslesme_guveni alanına yaz.\n\n" +
  "GÖREV 2 — Deneme adı/tarihi: Belgeden denemenin adını (deneme_adi, örn. 'TYT Deneme 3') ve " +
  "tarihini (tarih, YYYY-MM-DD formatında) çıkarmayı dene. Emin değilsen veya belgede yoksa " +
  "boş bırak, ASLA UYDURMA.\n\n" +
  "GÖREV 3 — Kazanım eşleştirme: Belgede ayrıca bir KAZANIM TABLOSU olabilir (Drs kısaltması | " +
  "Kazanım açıklaması | D | Y şeklinde, her satır bir kazanıma karşılık gelir). BÖYLE BİR TABLO " +
  "HER ZAMAN OLMAYABİLİR — yoksa eksik_kazanimlar'ı boş dizi bırak. Varsa, SADECE branşına " +
  "({BRANS}) ait satırları değerlendir ve YANLIŞ SAYISI (Y) > 0 olan her satır için, sana JSON " +
  "olarak verilen KAPALI KAZANIM LİSTESİ içinden en uygun kazanim_kodu'nu SEÇ. Listede olmayan " +
  "bir kazanim_kodu UYDURMA — en yakın eşleşmeyi seç, hiçbiri anlamlı ölçüde uymuyorsa " +
  "kazanim_kodu'nu boş bırak. Seçtiğin kazanim_kodu her durumda listedeki değerlerden BİRİ " +
  "olmak zorunda (ya da boş). Karnedeki kazanımın orijinal metnini HER ZAMAN " +
  "kazanim_metni_karne alanına aynen yaz (eşleşme bulunamasa bile), yanlış sayısını " +
  "yanlis_sayisi alanına yaz.\n\n" +
  "Emin olmadığın hiçbir alanı uydurma, boş/null bırak.";

const SCHEMA = {
  type: "OBJECT",
  properties: {
    ders_eslesme_guveni: { type: "NUMBER" },
    deneme_adi: { type: "STRING" },
    tarih: { type: "STRING" },
    soru: { type: "INTEGER" },
    dogru: { type: "INTEGER" },
    yanlis: { type: "INTEGER" },
    bos: { type: "INTEGER" },
    eksik_kazanimlar: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          kazanim_kodu: { type: "STRING" },
          kazanim_metni_karne: { type: "STRING" },
          yanlis_sayisi: { type: "INTEGER" },
        },
        required: ["kazanim_metni_karne"],
      },
    },
    uyarilar: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["ders_eslesme_guveni", "dogru", "yanlis", "bos", "eksik_kazanimlar", "uyarilar"],
};

function gecerliBelge(v: unknown): v is { mimeType: string; data: string } {
  if (!v || typeof v !== "object") return false;
  const mt = (v as any).mimeType;
  const data = (v as any).data;
  if (typeof data !== "string" || !data) return false;
  return typeof mt === "string" && (mt.startsWith("image/") || mt === "application/pdf");
}

const uyu = (ms: number) => new Promise((r) => setTimeout(r, ms));

// kaynak-ocr'daki ile aynı: geçici (yeniden denenebilir) Gemini hatası mı?
function geciciHataMi(status: number | null, mesaj: string): boolean {
  if (status !== null && [429, 500, 502, 503, 529].includes(status)) return true;
  return /high demand|overloaded|try again later|unavailable|resource[_ ]exhausted|rate limit/i
    .test(mesaj || "");
}

async function geminiCagir(
  apiKey: string,
  parts: any[],
  schema: unknown,
  sonlanmaZamani: number,
): Promise<any> {
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  };

  const DENEME = 3;
  const MIN_DENEME_MS = 3000;
  let sonHata = "Gemini API hatası";

  for (let deneme = 1; deneme <= DENEME; deneme++) {
    const kalanSure = sonlanmaZamani - Date.now();
    if (kalanSure < MIN_DENEME_MS) {
      throw new Error(`${sonHata} (süre bütçesi doldu)`);
    }
    const istekTimeout = Math.min(ISTEK_TIMEOUT_MS, kalanSure);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), istekTimeout);
    let response: Response;
    try {
      response = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      sonHata = (e as Error).name === "AbortError"
        ? "Gemini isteği zaman aşımına uğradı"
        : `Gemini isteği başarısız: ${(e as Error).message}`;
      clearTimeout(timer);
      const kalanBekleme = sonlanmaZamani - Date.now();
      if (deneme < DENEME && kalanBekleme >= MIN_DENEME_MS) {
        await uyu(Math.min(deneme * 4000, kalanBekleme - MIN_DENEME_MS));
        continue;
      }
      throw new Error(sonHata);
    } finally {
      clearTimeout(timer);
    }

    const responseData = await response.json();
    if (!response.ok) {
      sonHata = responseData?.error?.message || "Gemini API hatası";
      const kalanBekleme = sonlanmaZamani - Date.now();
      if (
        deneme < DENEME && geciciHataMi(response.status, sonHata) &&
        kalanBekleme >= MIN_DENEME_MS
      ) {
        await uyu(Math.min(deneme * 4000, kalanBekleme - MIN_DENEME_MS));
        continue;
      }
      throw new Error(sonHata);
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

  throw new Error(sonHata);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "GEMINI_API_KEY ortam değişkeni tanımlı değil." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json();
    const { belge, brans, kazanimlar } = body;

    if (!gecerliBelge(belge)) {
      return new Response(
        JSON.stringify({ error: "belge: { mimeType (image/* veya application/pdf), data } gerekli." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!brans || typeof brans !== "string") {
      return new Response(
        JSON.stringify({ error: "brans: öğretmenin branşı (string) gerekli." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Kapalı liste — soru-analiz'deki gibi prompt'u şişirmemek için sadeleştir.
    const sadeKazanimlar = (Array.isArray(kazanimlar) ? kazanimlar : []).slice(0, 400).map((k: any) => ({
      konu: k?.konu ?? "",
      kazanim_kodu: k?.kazanim_kodu ?? "",
      kazanim_aciklamasi: (k?.kazanim_aciklamasi ?? "").slice(0, 240),
    })).filter((k: any) => k.kazanim_kodu);

    const parts: any[] = [
      { text: SISTEM_PROMPT_SABIT.replaceAll("{BRANS}", brans) },
      {
        text: sadeKazanimlar.length
          ? "KAPALI KAZANIM LİSTESİ (JSON — SADECE bu listeden seç):\n" + JSON.stringify(sadeKazanimlar)
          : "KAPALI KAZANIM LİSTESİ verilmedi — eksik_kazanimlar'ı boş dizi döndür.",
      },
      { text: "--- DENEME SONUÇ BELGESİ ---" },
      { inlineData: { mimeType: belge.mimeType, data: belge.data } },
    ];

    const sonlanmaZamani = Date.now() + SURE_BUTCESI_MS;
    let parsed: any;
    try {
      parsed = await geminiCagir(apiKey, parts, SCHEMA, sonlanmaZamani);
    } catch (e) {
      return new Response(
        JSON.stringify({ error: (e as Error).message || "Gemini API hatası" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Sunucu tarafı doğrulama/temizlik (modelin uydurmasına karşı savunma) ──
    let guven = Number(parsed.ders_eslesme_guveni);
    if (!Number.isFinite(guven)) guven = 0;
    guven = Math.max(0, Math.min(1, guven));
    parsed.ders_eslesme_guveni = guven;

    const uyarilar: string[] = Array.isArray(parsed.uyarilar)
      ? parsed.uyarilar.filter((u: any) => typeof u === "string")
      : [];
    if (guven < 0.35 && !uyarilar.some((u) => /branş/i.test(u))) {
      uyarilar.unshift(
        `Belgede "${brans}" branşına ait bir sonuç satırı güvenilir biçimde bulunamadı. Değerleri kontrol edin.`,
      );
    }
    parsed.uyarilar = uyarilar;

    parsed.soru = Number.isFinite(Number(parsed.soru)) ? Math.max(0, Math.round(Number(parsed.soru))) : 0;
    parsed.dogru = Number.isFinite(Number(parsed.dogru)) ? Math.max(0, Math.round(Number(parsed.dogru))) : 0;
    parsed.yanlis = Number.isFinite(Number(parsed.yanlis)) ? Math.max(0, Math.round(Number(parsed.yanlis))) : 0;
    parsed.bos = Number.isFinite(Number(parsed.bos)) ? Math.max(0, Math.round(Number(parsed.bos))) : 0;

    // tarih YYYY-MM-DD değilse (model kuralı bozarsa) boş bırak — <input type=date> zaten
    // geçersiz değeri kabul etmez, ama sunucu tarafında da tutarlı olsun.
    if (typeof parsed.tarih !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.tarih)) {
      parsed.tarih = "";
    }
    parsed.deneme_adi = typeof parsed.deneme_adi === "string" ? parsed.deneme_adi : "";

    const izinliKodlar = new Set(sadeKazanimlar.map((k: any) => k.kazanim_kodu));
    parsed.eksik_kazanimlar = (Array.isArray(parsed.eksik_kazanimlar) ? parsed.eksik_kazanimlar : [])
      .map((e: any) => {
        const kod = typeof e?.kazanim_kodu === "string" ? e.kazanim_kodu : "";
        return {
          kazanim_kodu: izinliKodlar.has(kod) ? kod : "",
          kazanim_metni_karne: typeof e?.kazanim_metni_karne === "string" ? e.kazanim_metni_karne : "",
          yanlis_sayisi: Number.isFinite(Number(e?.yanlis_sayisi))
            ? Math.max(0, Math.round(Number(e?.yanlis_sayisi)))
            : 0,
        };
      })
      .filter((e: any) => e.kazanim_metni_karne);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message || "Beklenmeyen hata" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
