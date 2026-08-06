import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Bu fonksiyon istemciye (tarayıcıya) Anthropic Messages API ile uyumlu bir
// arayüz sunar (content bloklu mesajlar, tool_use/tool_result, stop_reason),
// ama arkada Gemini'nin (legacy, stateless) generateContent endpoint'ini
// çağırır. Frontend kodu (adaAPICall/adaToolLoop) bu sayede değişmeden kalır;
// çeviri tamamen burada yapılır.

const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Anthropic input_schema (lowercase JSON Schema) -> Gemini Schema (uppercase type enum)
function toGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const out: any = {};
  if (schema.type) out.type = String(schema.type).toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = toGeminiSchema(v);
    }
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.required) out.required = schema.required;
  return out;
}

function toolsToGemini(tools: any[] | undefined) {
  if (!tools || !tools.length) return undefined;
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toGeminiSchema(t.input_schema),
    })),
  }];
}

// Önceki asistan turlarındaki tool_use bloklarından id -> fonksiyon adı haritası çıkarır.
// Anthropic'in tool_result bloğu sadece tool_use_id taşır, ismi taşımaz.
function buildToolNameMap(messages: any[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === "tool_use" && b.id) map.set(b.id, b.name);
      }
    }
  }
  return map;
}

function messagesToGeminiContents(messages: any[]) {
  const nameById = buildToolNameMap(messages);
  const contents: any[] = [];

  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts: any[] = [];
    const content = m.content;

    if (typeof content === "string") {
      parts.push({ text: content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        // Önceki turda bu bloğu biz ürettiysek (_gemini), Gemini'nin ham part'ını
        // aynen geri veriyoruz — thoughtSignature gibi opak alanlar korunmuş olur.
        if (b && b._gemini) {
          parts.push(b._gemini);
          continue;
        }
        if (b?.type === "text") {
          parts.push({ text: b.text });
        } else if (b?.type === "tool_use") {
          parts.push({ functionCall: { name: b.name, args: b.input || {}, id: b.id } });
        } else if (b?.type === "tool_result") {
          const name = nameById.get(b.tool_use_id) || "unknown_function";
          let response: any;
          try {
            response = JSON.parse(b.content);
          } catch {
            response = { result: b.content };
          }
          parts.push({ functionResponse: { name, id: b.tool_use_id, response } });
        }
      }
    }

    if (parts.length) contents.push({ role, parts });
  }

  return contents;
}

function geminiResponseToAnthropicShape(geminiData: any) {
  const candidate = geminiData?.candidates?.[0];
  if (!candidate) {
    const reason = geminiData?.promptFeedback?.blockReason || "bilinmeyen neden";
    throw new Error(`Gemini yanıt üretmedi (${reason})`);
  }

  const parts = candidate?.content?.parts || [];
  const content: any[] = [];
  let hasToolUse = false;

  for (const p of parts) {
    if (p.functionCall) {
      hasToolUse = true;
      content.push({
        type: "tool_use",
        id: p.functionCall.id || `toolu_${crypto.randomUUID()}`,
        name: p.functionCall.name,
        input: p.functionCall.args || {},
        _gemini: p,
      });
    } else if (typeof p.text === "string") {
      content.push({ type: "text", text: p.text, _gemini: p });
    }
  }

  return {
    content,
    stop_reason: hasToolUse ? "tool_use" : "end_turn",
  };
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
    const { system, tools, messages, max_tokens } = body;

    const geminiBody: any = {
      contents: messagesToGeminiContents(messages || []),
      generationConfig: { maxOutputTokens: max_tokens || 1500 },
    };
    if (system) geminiBody.systemInstruction = { parts: [{ text: system }] };
    const geminiTools = toolsToGemini(tools);
    if (geminiTools) geminiBody.tools = geminiTools;

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(geminiBody),
    });

    const data = await response.json();

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: data?.error?.message || "Gemini API hatası", details: data }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const anthropicShaped = geminiResponseToAnthropicShape(data);
    return new Response(JSON.stringify(anthropicShaped), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Beklenmeyen hata" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
