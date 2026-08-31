import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// auth-login — tüm giriş akışlarının (öğretmen / adaptix / öğrenci / veli)
// server-side doğrulaması. Parola karşılaştırması ve kullanicilar tablosuna
// erişim yalnızca burada, service_role ile yapılır; tarayıcı artık
// kullanicilar tablosunu görmez.
//
// NOT: aşağıdaki KRİPTO bloğu admin-ops fonksiyonuyla birebir aynıdır
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
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  if (isLegacyHash(stored)) {
    const h = await sha256Hex(password);
    return timingSafeEqual(enc.encode(h), enc.encode(stored.toLowerCase()));
  }
  const m = /^pbkdf2\$(\d+)\$([^$]+)\$([^$]+)$/.exec(stored);
  if (!m) return false;
  const iter = parseInt(m[1], 10);
  const salt = b64urlDecode(m[2]);
  const expected = b64urlDecode(m[3]);
  const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, km, expected.length * 8,
  );
  return timingSafeEqual(new Uint8Array(bits), expected);
}
async function sessionKey(): Promise<CryptoKey> {
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(srk + "::adaptix-session-v1"));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function issueToken(payload: Record<string, unknown>, ttlSeconds = 8 * 3600): Promise<string> {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const bodyB64 = b64urlEncode(enc.encode(JSON.stringify(body)));
  const key = await sessionKey();
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(bodyB64));
  return `${bodyB64}.${b64urlEncode(new Uint8Array(sig))}`;
}
// ═════════════ /KRİPTO ═════════════

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Basit, en iyi-çaba hız sınırı (isolate-local; kalıcı değil ama caydırıcı)
const denemeler = new Map<string, { n: number; ilk: number }>();
const PENCERE_MS = 5 * 60 * 1000;
const MAKS = 8;
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const k = denemeler.get(ip);
  if (!k || now - k.ilk > PENCERE_MS) {
    denemeler.set(ip, { n: 1, ilk: now });
    return false;
  }
  k.n++;
  return k.n > MAKS;
}
function rateClear(ip: string) {
  denemeler.delete(ip);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST bekleniyor" }, 405);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "bilinmiyor";

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Geçersiz istek" }, 400);
  }
  const rol = String(body?.rol || "");

  try {
    // ── Öğretmen / Adaptix (parola ile) ──────────────────────────────────
    if (rol === "ogretmen" || rol === "adaptix") {
      if (rateLimited(ip)) {
        return json({ error: "Çok fazla deneme. Birkaç dakika sonra tekrar deneyin." }, 429);
      }
      const sifre = String(body?.sifre ?? "");
      if (!sifre) return json({ error: "Şifre gerekli" }, 400);

      const { data: kullanicilar, error } = await sb
        .from("kullanicilar")
        .select("id, rol, deger, sifre_hash");
      if (error) return json({ error: "Sunucu hatası" }, 500);

      let eslesen: { id: string; rol: string; deger: string | null; sifre_hash: string } | null = null;
      for (const k of kullanicilar ?? []) {
        if (await verifyPassword(sifre, k.sifre_hash || "")) {
          eslesen = k as typeof eslesen;
          break;
        }
      }
      if (!eslesen) return json({ error: "Şifre hatalı" }, 401);
      rateClear(ip);

      // Lazy migration: eski saltsız SHA-256 → PBKDF2
      if (isLegacyHash(eslesen.sifre_hash || "")) {
        try {
          const yeni = await hashPassword(sifre);
          await sb.from("kullanicilar").update({ sifre_hash: yeni }).eq("id", eslesen.id);
        } catch {
          /* migration başarısızsa giriş yine de geçerli */
        }
      }

      if (eslesen.rol === "adaptix") {
        const token = await issueToken({ rol: "adaptix", sub: eslesen.id });
        return json({ rol: "adaptix", user: { ad: "AdaptiX", rol: "adaptix" }, token });
      }

      // öğretmen — deger alanı ogretmen_id taşır
      let ogretmen: Record<string, unknown> | null = null;
      if (eslesen.deger) {
        const r = await sb.from("ogretmenler").select("*").eq("ogretmen_id", eslesen.deger).maybeSingle();
        ogretmen = r.data;
      } else {
        const r = await sb.from("ogretmenler").select("*").eq("durum", "aktif").limit(1).maybeSingle();
        ogretmen = r.data;
      }
      if (!ogretmen) return json({ error: "Öğretmen kaydı bulunamadı" }, 404);
      return json({ rol: "ogretmen", ogretmen });
    }

    // ── Öğrenci (TC kimlik no ile) ───────────────────────────────────────
    if (rol === "ogrenci") {
      const tc = String(body?.tc ?? "").trim();
      if (!tc) return json({ error: "TC kimlik numarası gerekli" }, 400);
      const { data: hepsi, error } = await sb.from("ogrenciler").select("*");
      if (error) return json({ error: "Sunucu hatası" }, 500);
      const ogr = (hepsi ?? []).find((o: Record<string, unknown>) => String(o.tc_no ?? "").trim() === tc);
      if (!ogr) return json({ error: "TC kimlik numarası bulunamadı" }, 404);
      return json({ rol: "ogrenci", ogrenci: ogr });
    }

    // ── Veli (telefon ile) ──────────────────────────────────────────────
    if (rol === "veli") {
      const tel = String(body?.telefon ?? "").trim();
      if (!tel) return json({ error: "Telefon gerekli" }, 400);
      const { data: veli, error } = await sb
        .from("veliler")
        .select("*, ogrenciler(*)")
        .eq("telefon", tel)
        .limit(1)
        .maybeSingle();
      if (error) return json({ error: "Sunucu hatası" }, 500);
      if (!veli || !veli.ogrenciler) {
        return json({ error: "Bu telefon numarasıyla kayıtlı veli bulunamadı" }, 404);
      }
      return json({ rol: "veli", ogrenci: veli.ogrenciler });
    }

    return json({ error: "Geçersiz rol" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || "Beklenmeyen hata" }, 500);
  }
});
