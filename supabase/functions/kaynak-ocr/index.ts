import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Kamera ile kaynak ekleme akışının OCR fonksiyonu.
// Tek bir fotoğraf (kapak / içindekiler / cevap anahtarı) alır, Gemini vision'a
// gönderir ve adıma özel bir JSON şeması içinde yapılandırılmış veri döndürür.
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

const ADIMLAR: Record<string, { prompt: string; schema: any }> = {
  kapak: {
    prompt:
      "Bu bir ders kaynağı (soru bankası/deneme kitabı) kapak fotoğrafıdır. " +
      "Kaynağın adını, yayınevini/yazarını ve hedeflediği sınıfı çıkar. " +
      "Sınıfı '5. Sınıf' - '8. Sınıf' formatında yaz. Emin olmadığın alanı boş bırak, uydurma.",
    schema: {
      type: "OBJECT",
      properties: {
        kaynak_adi: { type: "STRING" },
        yayin_evi: { type: "STRING" },
        sinif: { type: "STRING" },
      },
      required: ["kaynak_adi"],
    },
  },
  icindekiler: {
    prompt:
      "Bu bir ders kaynağının içindekiler sayfası fotoğraf(lar)ıdır. Birden fazla ardışık sayfa " +
      "fotoğrafı verilmiş olabilir; fotoğrafların sırası sayfa sırasıdır. Hepsini birlikte " +
      "değerlendirip TEK, birleşik ve sıralı bir konu listesi döndür — sayfalar arasında tekrar " +
      "eden başlıkları (örn. bir sonraki fotoğrafın başında önceki sayfanın son satırı tekrar " +
      "görünüyorsa) yalnızca bir kez say. Sırasıyla her konu başlığını ve yanındaki sayfa " +
      "numarasını çıkar. Alt başlıkları değil, ana konu başlıklarını al. Sayfa numarası " +
      "okunamıyorsa null bırak.",
    schema: {
      type: "OBJECT",
      properties: {
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
      },
      required: ["konu_listesi"],
    },
  },
  cevap_anahtari: {
    prompt:
      "Bu bir soru bankası cevap anahtarı fotoğraf(lar)ıdır. Birden fazla ardışık sayfa fotoğrafı " +
      "verilmiş olabilir; fotoğrafların sırası sayfa sırasıdır. Hepsini birlikte değerlendirip TEK, " +
      "birleşik bir test listesi döndür — aynı test birden fazla fotoğrafta görünüyorsa tekrar " +
      "etme. Her test/bölüm için test numarasını, bulunduğu sayfa numarasını ve sıradaki " +
      "cevapları (A/B/C/D/E) bir dizi olarak çıkar.",
    schema: {
      type: "OBJECT",
      properties: {
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
      required: ["cevap_anahtari"],
    },
  },
};

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
    const { adim, images } = body;

    const tanim = ADIMLAR[adim];
    if (!tanim) {
      return new Response(
        JSON.stringify({ error: `Geçersiz adım: ${adim}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!Array.isArray(images) || !images.length || images.some((img: any) => !img?.mimeType || !img?.data)) {
      return new Response(
        JSON.stringify({ error: "images: en az bir { mimeType, data (base64) } öğesi zorunlu." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const geminiBody = {
      contents: [{
        role: "user",
        parts: [
          { text: tanim.prompt },
          ...images.map((img: any) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
        ],
      }],
      generationConfig: {
        maxOutputTokens: 4000,
        responseMimeType: "application/json",
        responseSchema: tanim.schema,
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

    const text = responseData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      const reason = responseData?.promptFeedback?.blockReason || "bilinmeyen neden";
      return new Response(
        JSON.stringify({ error: `Gemini yanıt üretmedi (${reason})` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Response(
        JSON.stringify({ error: "Gemini yanıtı geçerli JSON değil.", raw: text }),
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
