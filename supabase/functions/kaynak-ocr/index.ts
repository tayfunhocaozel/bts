import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Kamera ile kaynak ekleme akışının OCR fonksiyonu.
// Kapak, içindekiler ve (varsa) cevap anahtarı fotoğraflarının TAMAMINI TEK bir
// Gemini isteğinde birlikte alır ve tek bir birleşik JSON sonucu döndürür.
// ada-chat'teki Anthropic-uyumlu sohbet/tool-calling katmanından bağımsızdır;
// burada tek turluk, şemayla kısıtlanmış bir çıkarım yeterli.

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SISTEM_PROMPT =
  "Sen bir ders kaynağı (soru bankası/deneme kitabı) kataloglama asistanısın. Aşağıda gruplar " +
  "halinde fotoğraf verilecek; her grubun başında hangi gruba ait olduğunu belirten bir metin " +
  "etiketi var. Gruplar arasındaki ve her grup içindeki fotoğraf sırası (sayfa sırası) önemlidir. " +
  "Tek bir JSON nesnesi olarak şunları çıkar:\n" +
  "- KAPAK fotoğrafından: kaynağın adı (kaynak_adi), yayınevi/yazarı (yayin_evi), hedeflediği " +
  "sınıf (sinif, '5. Sınıf' - '8. Sınıf' formatında).\n" +
  "- İÇİNDEKİLER fotoğraflarının TAMAMINI birlikte değerlendirerek: TEK, sıralı, birleşik bir " +
  "konu listesi (konu_listesi) — ana konu başlıkları ve yanlarındaki sayfa numaraları. Alt " +
  "başlıkları değil ana başlıkları al; sayfalar arasında tekrar eden başlıkları bir kez say; " +
  "sayfa numarası okunamıyorsa null bırak.\n" +
  "- CEVAP ANAHTARI fotoğrafları verildiyse TAMAMINI birlikte değerlendirerek: TEK birleşik bir " +
  "test listesi (cevap_anahtari) — test numarası, bulunduğu sayfa numarası, sıradaki cevaplar " +
  "(A/B/C/D/E) dizisi. Aynı test birden fazla fotoğrafta görünüyorsa tekrar etme. Cevap anahtarı " +
  "fotoğrafı verilmediyse boş dizi döndür.\n" +
  "Emin olmadığın alanları boş/null bırak, uydurma.";

const SCHEMA = {
  type: "OBJECT",
  properties: {
    kaynak_adi: { type: "STRING" },
    yayin_evi: { type: "STRING" },
    sinif: { type: "STRING" },
    konu_listesi: {
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
    cevap_anahtari: {
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
  required: ["kaynak_adi", "konu_listesi"],
};

function gecerliGorselDizisi(v: unknown): v is { mimeType: string; data: string }[] {
  return Array.isArray(v) && v.every((img: any) => img?.mimeType && img?.data);
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
    const { kapak, icindekiler, cevap_anahtari } = body;

    if (!gecerliGorselDizisi(kapak) || kapak.length !== 1) {
      return new Response(
        JSON.stringify({ error: "kapak: tam olarak 1 fotoğraf ({ mimeType, data }) gerekli." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!gecerliGorselDizisi(icindekiler) || !icindekiler.length) {
      return new Response(
        JSON.stringify({ error: "icindekiler: en az 1 fotoğraf ({ mimeType, data }) gerekli." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (cevap_anahtari !== undefined && !gecerliGorselDizisi(cevap_anahtari)) {
      return new Response(
        JSON.stringify({ error: "cevap_anahtari: { mimeType, data } öğelerinden oluşan bir dizi olmalı." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const cevapAnahtariGorselleri = cevap_anahtari || [];

    const gorselPart = (img: { mimeType: string; data: string }) => ({
      inlineData: { mimeType: img.mimeType, data: img.data },
    });

    const parts: any[] = [
      { text: SISTEM_PROMPT },
      { text: "--- KAPAK FOTOĞRAFI ---" },
      ...kapak.map(gorselPart),
      { text: "--- İÇİNDEKİLER FOTOĞRAFLARI (sırasıyla) ---" },
      ...icindekiler.map(gorselPart),
    ];
    if (cevapAnahtariGorselleri.length) {
      parts.push({ text: "--- CEVAP ANAHTARI FOTOĞRAFLARI (sırasıyla) ---" });
      parts.push(...cevapAnahtariGorselleri.map(gorselPart));
    }

    const geminiBody = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
      },
    };

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(geminiBody),
    });

    const responseData = await response.json();

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: responseData?.error?.message || "Gemini API hatası", details: responseData }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const candidate = responseData?.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;
    if (!text) {
      const reason = responseData?.promptFeedback?.blockReason || candidate?.finishReason || "bilinmeyen neden";
      return new Response(
        JSON.stringify({ error: `Gemini yanıt üretmedi (${reason})` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      const kesikMi = candidate?.finishReason === "MAX_TOKENS";
      return new Response(
        JSON.stringify({
          error: kesikMi
            ? "Gemini yanıtı çok uzun olduğu için yarıda kesildi. Daha az fotoğrafla tekrar deneyin."
            : "Gemini yanıtı geçerli JSON değil.",
          raw: text,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Beklenmeyen hata" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
