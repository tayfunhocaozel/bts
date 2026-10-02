import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// basvuru-bildirim — yeni öğretmen başvurusunda yöneticiye Resend ile mail.
//
// Yalnızca basvurular AFTER INSERT tetikleyicisi (pg_net) çağırır. İstek
// x-webhook-secret başlığıyla doğrulanır (verify_jwt=false). Gövdede yalnızca
// {id} gelir; başvuru içeriği veritabanından service_role ile okunur, böylece
// dışarıdan uydurma içerikli mail attırılamaz.
//
// Secret'lar (supabase secrets set):
//   BASVURU_WEBHOOK_SECRET  Vault'taki basvuru_webhook_secret ile aynı değer
//   RESEND_API_KEY          Resend API anahtarı
//   BILDIRIM_ALICI          bildirimin gideceği adres
//   MAIL_GONDEREN           ör. "AdaptiX <onboarding@resend.dev>"
// ─────────────────────────────────────────────────────────────────────────────

const KONU = "AdaptiX: Yeni öğretmen başvurusu";
const PANEL_URL = "https://adaptix.com.tr/www/index.html#basvurular";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enc = new TextEncoder();

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Uzunluk sızdırmadan sabit süreli karşılaştırma: iki tarafın SHA-256'sı kıyaslanır.
async function secretEsit(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function kacir(v: unknown, max: number): string {
  let s = String(v ?? "").trim();
  if (s.length > max) s = s.slice(0, max) + "…";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function duzMetin(v: unknown, max: number): string {
  const s = String(v ?? "").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function trZaman(iso: string): string {
  try {
    return new Date(iso).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" });
  } catch {
    return iso;
  }
}

type Basvuru = {
  id: string; ad_soyad: string; brans: string; telefon: string;
  mesaj: string | null; created_at: string;
};

function mailGovdesi(b: Basvuru, sonHak: boolean) {
  const zaman = trZaman(b.created_at);
  const satirlar: [string, string][] = [
    ["Ad Soyad", kacir(b.ad_soyad, 120)],
    ["Branş", kacir(b.brans, 120)],
    ["Telefon", kacir(b.telefon, 120)],
    ["Not", b.mesaj ? kacir(b.mesaj, 1000).replace(/\r?\n/g, "<br>") : "<i>—</i>"],
    ["Başvuru zamanı", kacir(zaman, 60)],
  ];
  const limitNotu = sonHak
    ? `<p style="background:#fff4e5;border:1px solid #f0c36d;padding:10px;border-radius:6px">
         Bu saat için bildirim sınırı doldu. Sonraki başvurular için mail gelmeyecek;
         hepsi panelde görünmeye devam eder.</p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1a1a1a">
  <h2 style="margin:0 0 12px">Yeni öğretmen başvurusu</h2>
  <table cellpadding="6" style="border-collapse:collapse">
    ${satirlar.map(([k, v]) =>
      `<tr><td style="color:#666;vertical-align:top;white-space:nowrap"><b>${k}</b></td><td>${v}</td></tr>`
    ).join("")}
  </table>
  ${limitNotu}
  <p style="margin-top:18px"><a href="${PANEL_URL}"
     style="background:#0057ff;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">
     Başvurular sekmesini aç</a></p>
</body></html>`;

  const text = [
    "Yeni öğretmen başvurusu",
    "",
    `Ad Soyad: ${duzMetin(b.ad_soyad, 120)}`,
    `Branş: ${duzMetin(b.brans, 120)}`,
    `Telefon: ${duzMetin(b.telefon, 120)}`,
    `Not: ${duzMetin(b.mesaj, 1000) || "—"}`,
    `Başvuru zamanı: ${zaman}`,
    ...(sonHak ? ["", "Bu saat için bildirim sınırı doldu; sonraki başvurular yalnızca panelde."] : []),
    "",
    `Panel: ${PANEL_URL}`,
  ].join("\n");

  return { html, text };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method" });

  const webhookSecret = Deno.env.get("BASVURU_WEBHOOK_SECRET") ?? "";
  if (!webhookSecret) {
    console.error("basvuru-bildirim: yapılandırma eksik — BASVURU_WEBHOOK_SECRET tanımlı değil");
    return json(500, { error: "yapilandirma_eksik" });
  }

  const gelen = req.headers.get("x-webhook-secret") ?? "";
  if (!gelen || !(await secretEsit(gelen, webhookSecret))) {
    console.warn("basvuru-bildirim: yetkisiz istek reddedildi");
    return json(401, { error: "yetkisiz" });
  }

  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const alici = Deno.env.get("BILDIRIM_ALICI") ?? "";
  const gonderen = Deno.env.get("MAIL_GONDEREN") ?? "AdaptiX <onboarding@resend.dev>";
  if (!resendKey || !alici) {
    const eksik = [!resendKey && "RESEND_API_KEY", !alici && "BILDIRIM_ALICI"].filter(Boolean).join(", ");
    console.error(`basvuru-bildirim: yapılandırma eksik — ${eksik}`);
    return json(500, { error: "yapilandirma_eksik" });
  }

  let id = "";
  try {
    const body = await req.json();
    id = String(body?.id ?? "");
  } catch { /* aşağıda reddedilir */ }
  if (!UUID_RE.test(id)) return json(400, { error: "gecersiz_id" });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: karar, error: kErr } = await sb.rpc("basvuru_bildirim_talep", { p_id: id });
  if (kErr) {
    console.error(`basvuru-bildirim: karar RPC hatası (id=${id}): ${kErr.message}`);
    return json(500, { error: "karar_hatasi" });
  }
  if (karar?.karar !== "gonder") {
    console.log(`basvuru-bildirim: mail atlandı (id=${id}) karar=${karar?.karar}`);
    return json(200, { karar: karar?.karar });
  }

  const { html, text } = mailGovdesi(karar.basvuru as Basvuru, !!karar.son_hak);

  let durum: "gonderildi" | "hata" = "hata";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: gonderen, to: [alici], subject: KONU, html, text }),
    });
    if (r.ok) {
      durum = "gonderildi";
    } else {
      console.error(`basvuru-bildirim: Resend ${r.status} (id=${id}): ${(await r.text()).slice(0, 500)}`);
    }
  } catch (e) {
    console.error(`basvuru-bildirim: Resend isteği başarısız (id=${id}): ${(e as Error).message}`);
  }

  const { error: uErr } = await sb.from("basvurular")
    .update({ bildirim_durum: durum, bildirim_at: new Date().toISOString() })
    .eq("id", id);
  if (uErr) console.error(`basvuru-bildirim: durum yazılamadı (id=${id}): ${uErr.message}`);

  if (durum === "hata") return json(502, { error: "mail_gonderilemedi" });
  console.log(`basvuru-bildirim: mail gönderildi (id=${id})`);
  return json(200, { karar: "gonderildi" });
});
