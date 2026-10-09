// ─────────────────────────────────────────────────────────────────────────────
// ai-kapi — AI edge function'larının ortak kimlik kapısı.
//
// verify_jwt=true tek başına yetmiyor: sayfadaki publishable anahtar (sb_publishable_…)
// gateway'i geçebiliyor. Bu yüzden her AI fonksiyonu, auth-login'in JWT_LEGACY_SECRET
// ile imzaladığı JWT'yi BURADA kendisi doğrular (HS256 imza + iss + exp + rol) ve
// Gemini çağrısından ÖNCE, isteği okumadan reddeder.
//
// Kullanım:
//   const kapi = await kimlikKapisi(req, ["ogretmen", "adaptix"], corsHeaders);
//   if (!kapi.ok) return kapi.response;
//   // kapi.rol, kapi.claims (ogretmen_id / ogrenci_id …)
// ─────────────────────────────────────────────────────────────────────────────

const JWT_ISS = "adaptix-auth-login";
const enc = new TextEncoder();

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jsonParca(b64: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(b64urlDecode(b64)));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

let _anahtar: Promise<CryptoKey> | null = null;
function imzaAnahtari(secret: string): Promise<CryptoKey> {
  if (!_anahtar) {
    _anahtar = crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
  }
  return _anahtar;
}

// auth-login JWT'sini doğrular; geçerliyse payload'ı, değilse null döner.
export async function jwtDogrula(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  const header = jsonParca(h);
  if (!header || header.alg !== "HS256") return null; // "none" vb. reddedilir

  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await imzaAnahtari(secret), b64urlDecode(s), enc.encode(`${h}.${p}`));
  } catch {
    return null;
  }
  if (!ok) return null;

  const payload = jsonParca(p);
  if (!payload) return null;
  if (payload.iss !== JWT_ISS) return null;
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.rol !== "string") return null;
  return payload;
}

export type KapiSonuc =
  | { ok: true; rol: string; claims: Record<string, unknown> }
  | { ok: false; response: Response };

function redYaniti(corsHeaders: Record<string, string>, status: number, kod: string, error: string) {
  return {
    ok: false as const,
    response: new Response(JSON.stringify({ error, kod }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }),
  };
}

export async function kimlikKapisi(
  req: Request,
  izinliRoller: string[],
  corsHeaders: Record<string, string>,
): Promise<KapiSonuc> {
  const red = (status: number, kod: string, error: string): KapiSonuc =>
    redYaniti(corsHeaders, status, kod, error);

  const secret = Deno.env.get("JWT_LEGACY_SECRET") ?? "";
  if (!secret) {
    console.error("ai-kapi: JWT_LEGACY_SECRET tanımlı değil — tüm istekler reddediliyor");
    return red(500, "sunucu_yapilandirma", "Sunucu yapılandırma hatası");
  }

  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const claims = m ? await jwtDogrula(m[1].trim(), secret) : null;
  if (!claims) return red(401, "yetkisiz", "Oturum geçersiz veya süresi dolmuş. Lütfen tekrar giriş yapın.");

  const rol = claims.rol as string;
  if (!izinliRoller.includes(rol)) return red(403, "rol_yetkisiz", "Bu işlem için yetkiniz yok.");

  return { ok: true, rol, claims };
}

// ── Üyelik kapısı + kullanım ölçümü (Aşama 1B) ───────────────────────────────
// Kimlik kapısından SONRA, Gemini çağrısından ÖNCE çalışır:
//   ai_aktif=false / ai_bitis geçmiş → 403 ai_uyelik_yok
//   bu ayki (giris+cikis+dusunme) ≥ ai_aylik_kota_token → 403 ai_kota_doldu
// Öğrenci çağrısında öğretmen ogrenciler.ogretmen_id'den (veritabanı) çözülür;
// JWT'deki ogretmen_id yalnız yedek. 'adaptix' (yönetici) kapıdan muaf, ölçülür.
// Sorgu başarısızsa kapı KAPALI kalır (503 ai_kapi_hatasi) — maliyet kaçmasın.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Öğrenci başına günlük soru analizi üst sınırı (Türkiye saatiyle gün). Öğrencinin
// tek AI çağrısı soru-analiz olduğu için öğrenci rolünde kapı bunu uygular.
export const OGRENCI_GUNLUK_ANALIZ_LIMITI = 20;

function servisIstegi(yol: string, govde: unknown, ek: Record<string, string> = {}) {
  const anahtar = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return fetch(`${Deno.env.get("SUPABASE_URL") ?? ""}/rest/v1/${yol}`, {
    method: "POST",
    headers: {
      apikey: anahtar,
      Authorization: `Bearer ${anahtar}`,
      "Content-Type": "application/json",
      ...ek,
    },
    body: JSON.stringify(govde),
  });
}

export type UyelikSonuc =
  | { ok: true; ogretmenId: string | null; ogrenciId: string | null }
  | { ok: false; response: Response };

export async function uyelikKapisi(
  kapi: { rol: string; claims: Record<string, unknown> },
  corsHeaders: Record<string, string>,
): Promise<UyelikSonuc> {
  if (kapi.rol === "adaptix") return { ok: true, ogretmenId: null, ogrenciId: null };

  const ogrenciId = kapi.rol === "ogrenci" && kapi.claims.ogrenci_id != null
    ? String(kapi.claims.ogrenci_id)
    : null;
  const jwtOgretmen = String(kapi.claims.ogretmen_id ?? "");

  let d: Record<string, unknown>;
  try {
    const r = await servisIstegi("rpc/ai_kapi_durumu", {
      p_ogretmen_id: UUID_RE.test(jwtOgretmen) ? jwtOgretmen : null,
      p_ogrenci_id: ogrenciId,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    d = await r.json();
  } catch (e) {
    console.error("ai-kapi: üyelik sorgusu başarısız —", (e as Error).message);
    return redYaniti(corsHeaders, 503, "ai_kapi_hatasi",
      "AI hizmeti şu an doğrulanamıyor. Lütfen biraz sonra tekrar deneyin.");
  }

  if (!d?.bulundu || d.ai_aktif !== true || d.bitti === true) {
    return redYaniti(corsHeaders, 403, "ai_uyelik_yok", "Bu özellik için AI üyeliği gerekiyor.");
  }
  if (d.kota != null && Number(d.kullanilan) >= Number(d.kota)) {
    return redYaniti(corsHeaders, 403, "ai_kota_doldu", "Bu ayki AI kullanım hakkı doldu.");
  }
  // 'ogrenci_bugun' yoksa (20261006 migration'ı uygulanmamış) limit uygulanmaz
  if (ogrenciId && Number(d.ogrenci_bugun ?? 0) >= OGRENCI_GUNLUK_ANALIZ_LIMITI) {
    return redYaniti(corsHeaders, 429, "ai_gunluk_limit", "Bugünlük analiz hakkın doldu.");
  }
  return { ok: true, ogretmenId: String(d.ogretmen_id), ogrenciId };
}

const sayi = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);

// Bir HTTP isteği boyunca yapılan tüm Gemini çağrılarının usageMetadata'sını toplar,
// istek sonunda ai_kullanim'a TEK satır yazar. Yazma hatası kullanıcıya yansımaz.
export class AiOlcum {
  private giris = 0;
  private cikis = 0;
  private dusunme = 0;
  private onbellek = 0;
  private cagri = 0;
  private uyelik: { ogretmenId: string | null; ogrenciId: string | null };
  private model: string;
  fonksiyon: string;

  constructor(
    uyelik: { ogretmenId: string | null; ogrenciId: string | null },
    fonksiyon: string,
    model: string,
  ) {
    this.uyelik = uyelik;
    this.fonksiyon = fonksiyon;
    this.model = model;
  }

  // Gemini yanıt gövdesini (başarılı ya da değil) verin; usageMetadata yoksa yok sayılır.
  ekle(geminiYaniti: unknown) {
    const u = (geminiYaniti as { usageMetadata?: Record<string, unknown> })?.usageMetadata;
    if (!u) return;
    const onbellek = sayi(u.cachedContentTokenCount);
    // Araç kullanımı istemi (toolUsePromptTokenCount) promptTokenCount'a dahil değil ama
    // giriş gibi ücretlenir → girişe eklenir, kotaya sayılır.
    this.giris += Math.max(0, sayi(u.promptTokenCount) - onbellek) + sayi(u.toolUsePromptTokenCount);
    this.onbellek += onbellek;
    this.cikis += sayi(u.candidatesTokenCount);
    this.dusunme += sayi(u.thoughtsTokenCount);
    this.cagri++;
  }

  async kaydet() {
    if (!this.cagri) return;
    const satir = {
      ogretmen_id: this.uyelik.ogretmenId,
      ogrenci_id: this.uyelik.ogrenciId,
      fonksiyon: this.fonksiyon,
      model: this.model,
      giris_token: this.giris,
      cikis_token: this.cikis,
      dusunme_token: this.dusunme,
      onbellek_token: this.onbellek,
    };
    this.cagri = 0; // aynı ölçüm iki kez yazılmasın
    try {
      const r = await servisIstegi("ai_kullanim", satir, { Prefer: "return=minimal" });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    } catch (e) {
      console.error("ai-kapi: kullanım kaydı yazılamadı —", (e as Error).message, JSON.stringify(satir));
    }
  }
}
