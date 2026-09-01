import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// admin-ops — AdaptiX Platform Yönetim panelinin TÜM yazma işlemleri.
// Her istek, auth-login'in ürettiği HMAC imzalı kısa ömürlü token ile
// (x-admin-token header) doğrulanır; token yoksa/geçersizse/süresi dolmuşsa
// hiçbir işlem yapılmaz. Yazma işlemleri service_role ile RLS'i bypass eder.
//
// NOT: aşağıdaki KRİPTO bloğu auth-login fonksiyonuyla birebir aynıdır
// (kopyala-paylaş). Birinde değişiklik yaparsan diğerini de güncelle.
// ─────────────────────────────────────────────────────────────────────────────

// ═════════════ KRİPTO (paylaşılan kopya) ═════════════
const PBKDF2_ITER = 210_000;
const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return toHex(new Uint8Array(buf));
}
function isLegacyHash(stored: string): boolean {
  return /^[0-9a-f]{64}$/i.test(stored || "");
}
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, km, 256,
  );
  return `pbkdf2$${PBKDF2_ITER}$${b64urlEncode(salt)}$${b64urlEncode(new Uint8Array(bits))}`;
}
async function sessionKey(): Promise<CryptoKey> {
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(srk + "::adaptix-session-v1"));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function verifyToken(token: string): Promise<Record<string, unknown> | null> {
  const parts = (token || "").split(".");
  if (parts.length !== 2) return null;
  const [bodyB64, sigB64] = parts;
  const key = await sessionKey();
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sigB64), enc.encode(bodyB64));
  } catch {
    return null;
  }
  if (!ok) return null;
  let bodyObj: Record<string, unknown>;
  try {
    bodyObj = JSON.parse(new TextDecoder().decode(b64urlDecode(bodyB64)));
  } catch {
    return null;
  }
  if (typeof bodyObj.exp !== "number" || bodyObj.exp < Math.floor(Date.now() / 1000)) return null;
  return bodyObj;
}
void sha256Hex; void isLegacyHash; // paylaşılan kripto bloğunda tanımlı, bu fonksiyonda kullanılmıyor
// ═════════════ /KRİPTO ═════════════

const ANA_OGRETMEN = "b373a4e6-01b1-4131-99d4-a2deae98b1ea";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Türkiye yerel tarihi (UTC+3) — YYYY-MM-DD
function yerelISO(d = new Date()): string {
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

const str = (v: unknown) => (v == null ? "" : String(v)).trim();

// Karışması kolay karakterler (0/O, 1/l/I) hariç, kripto-güvenli geçici şifre.
function randomPassword(len = 14): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += abc[buf[i] % abc.length];
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST bekleniyor" }, 405);

  const oturum = await verifyToken(req.headers.get("x-admin-token") || "");
  if (!oturum || oturum.rol !== "adaptix") {
    return json({ error: "Yetkisiz veya oturum süresi dolmuş" }, 401);
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Geçersiz istek" }, 400);
  }
  const action = str(body?.action);

  try {
    switch (action) {
      // ── Öğretmen ekle / düzenle ──────────────────────────────────────
      case "ogretmen_kaydet": {
        const editId = str(body?.editId);
        const ad_soyad = str(body?.ad_soyad);
        const email = str(body?.email);
        const telefon = str(body?.telefon);
        const brans = str(body?.brans);
        const sifre = String(body?.sifre ?? "");

        // Birim fiyat: boş => null (genel varsayılan). İndirim: yüzde (0-99) => oran.
        const bfRaw = str(body?.birim_fiyat);
        const birim_fiyat = bfRaw === "" ? null : Math.max(0, Math.round(Number(bfRaw) || 0));
        const indPct = Math.min(Math.max(Number(body?.indirim_yuzde) || 0, 0), 99);
        const indirim_orani = Math.round(indPct) / 100;

        if (!ad_soyad) return json({ error: "Ad soyad zorunludur." }, 400);
        if (!brans) return json({ error: "Branş zorunludur." }, 400);
        if (birim_fiyat !== null && !Number.isFinite(birim_fiyat)) {
          return json({ error: "Birim fiyat geçersiz." }, 400);
        }

        if (editId) {
          const { error } = await sb.from("ogretmenler")
            .update({
              ad_soyad, email: email || null, telefon: telefon || null, brans,
              birim_fiyat, indirim_orani,
            })
            .eq("ogretmen_id", editId);
          if (error) return json({ error: error.message }, 400);
          return json({ ok: true, mode: "update" });
        }

        if (sifre.length < 8) return json({ error: "Şifre en az 8 karakter olmalıdır." }, 400);
        const { data: ogr, error: oErr } = await sb.from("ogretmenler")
          .insert({
            ad_soyad, email: email || null, telefon: telefon || null, brans, durum: "aktif",
            birim_fiyat, indirim_orani,
          })
          .select().single();
        if (oErr) return json({ error: oErr.message }, 400);

        const hash = await hashPassword(sifre);
        const { error: kErr } = await sb.from("kullanicilar")
          .insert({ rol: "ogretmen", sifre_hash: hash, deger: ogr.ogretmen_id });
        if (kErr) {
          // yarım kalmasın: öğretmen kaydını geri al
          await sb.from("ogretmenler").delete().eq("ogretmen_id", ogr.ogretmen_id);
          return json({ error: "Giriş kaydı oluşturulamadı: " + kErr.message }, 400);
        }
        return json({ ok: true, mode: "insert", ogretmen_id: ogr.ogretmen_id });
      }

      // ── Öğretmen durum aktif/pasif ───────────────────────────────────
      case "ogretmen_durum": {
        const ogretmenId = str(body?.ogretmenId);
        const durum = str(body?.durum);
        if (!["aktif", "pasif"].includes(durum)) return json({ error: "Geçersiz durum" }, 400);
        const { error } = await sb.from("ogretmenler").update({ durum }).eq("ogretmen_id", ogretmenId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ── Öğretmen şifre değiştir ──────────────────────────────────────
      case "sifre_degistir": {
        const ogretmenId = str(body?.ogretmenId);
        const sifre = String(body?.sifre ?? "");
        if (!ogretmenId) return json({ error: "Öğretmen belirtilmedi" }, 400);
        if (sifre.length < 8) return json({ error: "Şifre en az 8 karakter olmalıdır." }, 400);
        const hash = await hashPassword(sifre);
        const { error } = await sb.from("kullanicilar").update({ sifre_hash: hash }).eq("deger", ogretmenId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ── Öğretmen sil (tek transaction RPC) ───────────────────────────
      case "ogretmen_sil": {
        const ogretmenId = str(body?.ogretmenId);
        if (!ogretmenId) return json({ error: "Öğretmen belirtilmedi" }, 400);
        if (ogretmenId === ANA_OGRETMEN) return json({ error: "Ana öğretmen silinemez." }, 400);
        const { error } = await sb.rpc("adaptix_ogretmen_sil", { p_ogretmen_id: ogretmenId });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ── Bu ay fatura oluştur (manuel tetikleme; cron da aynı RPC'yi çağırır) ──
      case "fatura_olustur": {
        const { data: r, error } = await sb.rpc("adaptix_fatura_uret");
        if (error) return json({ error: error.message }, 400);
        const eklenen = Number(r?.eklenen ?? 0);
        return json({
          ok: true,
          eklenen,
          mesaj: eklenen ? undefined : "Bu dönem için fatura zaten oluşturulmuş",
        });
      }

      // ── Fatura ödeme geri al ────────────────────────────────────────
      case "fatura_odeme_geri_al": {
        const faturaId = str(body?.faturaId);
        if (!faturaId) return json({ error: "Fatura belirtilmedi" }, 400);
        const { data: f, error: fErr } = await sb.from("faturalar")
          .select("durum, notlar").eq("fatura_id", faturaId).maybeSingle();
        if (fErr) return json({ error: fErr.message }, 400);
        if (!f) return json({ error: "Fatura bulunamadı" }, 404);
        if (f.durum !== "odendi") {
          return json({ error: "Yalnızca ödenmiş faturanın ödemesi geri alınabilir" }, 400);
        }
        const not = `${str(f.notlar) ? str(f.notlar) + "\n" : ""}[Ödeme geri alındı: ${yerelISO()}]`;
        const { error } = await sb.from("faturalar")
          .update({ durum: "bekleyen", odeme_tarihi: null, notlar: not })
          .eq("fatura_id", faturaId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, notlar: not });
      }

      // ── Fatura ödendi işaretle ───────────────────────────────────────
      case "fatura_odendi": {
        const faturaId = str(body?.faturaId);
        if (!faturaId) return json({ error: "Fatura belirtilmedi" }, 400);
        const odeme_tarihi = yerelISO();
        const { error } = await sb.from("faturalar")
          .update({ durum: "odendi", odeme_tarihi }).eq("fatura_id", faturaId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, odeme_tarihi });
      }

      // ── Fatura not ──────────────────────────────────────────────────
      case "fatura_not": {
        const faturaId = str(body?.faturaId);
        if (!faturaId) return json({ error: "Fatura belirtilmedi" }, 400);
        const { error } = await sb.from("faturalar")
          .update({ notlar: str(body?.notlar) }).eq("fatura_id", faturaId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ── Başvuru durum güncelle (görüldü / reddet) ───────────────────
      case "basvuru_durum": {
        const id = str(body?.id);
        const durum = str(body?.durum);
        if (!id) return json({ error: "Başvuru belirtilmedi" }, 400);
        if (!["bekliyor", "goruldu", "onaylandi", "reddedildi"].includes(durum)) {
          return json({ error: "Geçersiz durum" }, 400);
        }
        const { error } = await sb.from("basvurular").update({ durum }).eq("id", id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ── Başvuru → Öğretmen tek tık (öğretmen + giriş kaydı, tek transaction) ──
      case "basvuru_onayla": {
        const id = str(body?.id);
        if (!id) return json({ error: "Başvuru belirtilmedi" }, 400);

        const { data: b, error: bErr } = await sb.from("basvurular")
          .select("*").eq("id", id).maybeSingle();
        if (bErr) return json({ error: bErr.message }, 400);
        if (!b) return json({ error: "Başvuru bulunamadı" }, 404);
        if (b.provisioned) {
          return json({ ok: true, already: true, mesaj: "Bu başvuru zaten öğretmene dönüştürülmüş" });
        }
        if (!str(b.ad_soyad)) return json({ error: "Başvuruda ad soyad yok" }, 400);

        const gecici = randomPassword(14);
        const hash = await hashPassword(gecici);
        const { data: r, error } = await sb.rpc("adaptix_basvuru_onayla", {
          p_basvuru_id: id, p_sifre_hash: hash,
        });
        if (error) return json({ error: error.message }, 400);
        if (r?.already) return json({ ok: true, already: true });

        return json({
          ok: true,
          ogretmen_id: r?.ogretmen_id ?? null,
          gecici_sifre: gecici,
          ad_soyad: b.ad_soyad,
          telefon: b.telefon ?? "",
          brans: b.brans ?? "",
        });
      }

      default:
        return json({ error: "Bilinmeyen işlem: " + action }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || "Beklenmeyen hata" }, 500);
  }
});
