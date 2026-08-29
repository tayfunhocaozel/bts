import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Soru Bankası (Yanlış Defteri) — öğrencinin çözemediği sorunun fotoğrafını
// kazanım listesiyle birlikte Gemini'ye verir; kapalı liste içinden ders / konu /
// kazanim_kodu SEÇTİRİR, güven skoru ve (cevabı vermeyen) bir ipucu ürettirir.
// kaynak-ocr ile aynı desen: tek turluk, responseSchema ile kısıtlanmış JSON çıktı.

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SISTEM_PROMPT =
  "Aşağıda bir öğrencinin çözemediği bir sorunun fotoğrafı var. Öğrenci {SINIF} " +
  "düzeyindedir. Sana bu düzeye ait kazanım listesi JSON olarak veriliyor: her öğe " +
  "{ konu, kazanim_kodu, kazanim_aciklamasi }.\n" +
  "Görevlerin:\n" +
  "1. Sorunun hangi derse ait olduğunu belirle (ders).\n" +
  "2. Verilen listeden sorunun EN UYGUN olduğu 'konu' ve 'kazanim_kodu' değerini SEÇ. " +
  "Listede olmayan bir kazanım UYDURMA; en yakın eşleşmeyi seç. Seçtiğin kazanim_kodu " +
  "listedeki değerlerden BİRİ olmak zorunda.\n" +
  "3. Eşleşmene ne kadar güvendiğini 0 ile 1 arasında bir sayı ile belirt (ai_guven_skoru).\n" +
  "4. Öğrenciye soruyu çözmesi için CEVABI VERMEDEN kısa (en fazla 2 cümle) bir ipucu yaz (ipucu).\n" +
  "5. Fotoğrafta sorunun net doğru şıkkı (A-E) açıkça görünüyorsa dogru_cevap alanına yaz; " +
  "emin değilsen boş bırak.\n" +
  "6. Sorunun TAM metnini yaz (soru_metni): soru kökü ve varsa A-E şıkları. Matematiksel " +
  "ifadeleri düz metinde okunabilir yaz (örn. x^2, kök(3), 1/2, ∴). Şıkları 'A) ... B) ...' " +
  "biçiminde ayrı satırlara koy. Soruda şekil/grafik/tablo varsa yerine [ŞEKİL: kısa açıklama] " +
  "yaz. Fotoğrafta birden çok soru varsa yalnızca ana/ilk soruyu al. Metni aynen çıkar, yorum ekleme.\n" +
  "Emin olmadığın alanları boş/null bırak, uydurma.";

const SCHEMA = {
  type: "OBJECT",
  properties: {
    ders: { type: "STRING" },
    konu: { type: "STRING" },
    kazanim_kodu: { type: "STRING" },
    ai_guven_skoru: { type: "NUMBER" },
    ipucu: { type: "STRING" },
    dogru_cevap: { type: "STRING" },
    soru_metni: { type: "STRING" },
  },
  required: ["konu", "kazanim_kodu", "ai_guven_skoru"],
};

function gecerliGorsel(v: unknown): v is { mimeType: string; data: string } {
  return !!v && typeof v === "object" &&
    typeof (v as any).mimeType === "string" && typeof (v as any).data === "string";
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
    const { foto, sinif, kazanimlar } = body;

    if (!gecerliGorsel(foto)) {
      return new Response(
        JSON.stringify({ error: "foto: { mimeType, data } gerekli." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!Array.isArray(kazanimlar) || !kazanimlar.length) {
      return new Response(
        JSON.stringify({ error: "kazanimlar: en az bir öğe içeren dizi olmalı." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Prompt'u fazla şişirmemek için kazanım listesini sadeleştir
    const sadeKazanimlar = kazanimlar.slice(0, 400).map((k: any) => ({
      konu: k.konu ?? "",
      kazanim_kodu: k.kazanim_kodu ?? "",
      kazanim_aciklamasi: (k.kazanim_aciklamasi ?? "").slice(0, 240),
    }));

    const parts: any[] = [
      { text: SISTEM_PROMPT.replace("{SINIF}", String(sinif || "ortaokul")) },
      { text: "KAZANIM LİSTESİ (JSON):\n" + JSON.stringify(sadeKazanimlar) },
      { text: "--- SORU FOTOĞRAFI ---" },
      { inlineData: { mimeType: foto.mimeType, data: foto.data } },
    ];

    const geminiBody = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
      },
    };

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
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
      return new Response(
        JSON.stringify({ error: "Gemini yanıtı geçerli JSON değil.", raw: text }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Güven skorunu 0-1 aralığına sıkıştır
    let skor = Number(parsed.ai_guven_skoru);
    if (!Number.isFinite(skor)) skor = null;
    else skor = Math.max(0, Math.min(1, skor));
    parsed.ai_guven_skoru = skor;

    // Model liste dışı bir kazanım uydurduysa temizle
    if (parsed.kazanim_kodu) {
      const varMi = sadeKazanimlar.some((k) => k.kazanim_kodu === parsed.kazanim_kodu);
      if (!varMi) parsed.kazanim_kodu = "";
    }
    if (parsed.dogru_cevap && !/^[A-E]$/.test(String(parsed.dogru_cevap).trim().toUpperCase())) {
      parsed.dogru_cevap = "";
    } else if (parsed.dogru_cevap) {
      parsed.dogru_cevap = String(parsed.dogru_cevap).trim().toUpperCase();
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
