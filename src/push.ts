/**
 * Push-Nachrichten für die To-do-Erinnerungen.
 *
 * Die App meldet ein Gerät mit `subscribe` an. Jede Minute prüft `runDue` (Cron-Trigger),
 * ob eine Erinnerung fällig ist, und schickt sie an alle angemeldeten Geräte derselben
 * Passphrase. Yazio spielt dabei keine Rolle.
 *
 * KV-Schlüssel:
 *   vapid              Schlüsselpaar des Servers (wird beim ersten Bedarf erzeugt)
 *   push-index         Liste der Passphrase-Namensräume mit angemeldeten Geräten
 *   <ns>/push          angemeldete Geräte dieses Namensraums
 *   <ns>/fired         schon verschickte Erinnerungen (damit nichts doppelt kommt)
 *   <ns>/todos         die To-dos (vom Dashboard geschrieben)
 */

import { buildPushPayload, type PushSubscription } from "@block65/webcrypto-web-push";

import type { Env } from "./limits";

const DEFAULT_TZ = "Europe/Berlin";
const MAX_DEVICES = 10;
const MAX_AGE_MS = 12 * 3600 * 1000; // ältere, verpasste Erinnerungen werden nicht mehr gesendet
const FIRED_KEEP_MS = 30 * 24 * 3600 * 1000;
const DOTS = ["\u{1F7E2}", "\u{1F7E1}", "\u{1F534}"];

interface Vapid {
  publicKey: string;
  privateKey: string;
}
interface Device {
  endpoint: string;
  expirationTime: number | null;
  keys: { auth: string; p256dh: string };
  tz: string;
  origin: string;
}
type Json = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function getJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function vapidKeys(kv: KVNamespace): Promise<Vapid> {
  const existing = await getJson<Vapid>(kv, "vapid");
  if (existing?.publicKey && existing.privateKey) return existing;

  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const fromB64 = (v: string) =>
    Uint8Array.from(atob(v.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  const x = fromB64(jwk.x ?? "");
  const y = fromB64(jwk.y ?? "");
  const pub = new Uint8Array(65);
  pub[0] = 4;
  pub.set(x, 1);
  pub.set(y, 33);
  const keys: Vapid = { publicKey: b64url(pub), privateKey: jwk.d ?? "" };
  await kv.put("vapid", JSON.stringify(keys));
  return keys;
}

/** Lokale Zeit "YYYY-MM-DDTHH:MM" in einer Zeitzone als Epoche in Millisekunden. */
export function localToEpoch(local: string, tz: string): number {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(local);
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const offset = (utcMs: number): number => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(new Date(utcMs))
        .map((p) => [p.type, p.value]),
    );
    const asUtc = Date.UTC(
      +parts.year,
      +parts.month - 1,
      +parts.day,
      +parts.hour,
      +parts.minute,
      +parts.second,
    );
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  };
  try {
    const first = offset(guess);
    let t = guess - first;
    const second = offset(t);
    if (second !== first) t = guess - second;
    return t;
  } catch {
    return localToEpoch(local, DEFAULT_TZ);
  }
}

async function send(
  device: Device,
  vapid: Vapid,
  data: Json,
): Promise<"ok" | "gone" | "error"> {
  try {
    const subscription: PushSubscription = {
      endpoint: device.endpoint,
      expirationTime: device.expirationTime,
      keys: device.keys,
    };
    const payload = await buildPushPayload(
      { data: data as never, options: { ttl: 3600, urgency: "high" } },
      subscription,
      { subject: device.origin || "mailto:push@example.com", ...vapid },
    );
    const res = await fetch(device.endpoint, payload);
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}

async function deliver(kv: KVNamespace, ns: string, devices: Device[], vapid: Vapid, data: Json) {
  const results = await Promise.all(devices.map((d) => send(d, vapid, data)));
  const alive = devices.filter((_, i) => results[i] !== "gone");
  if (alive.length !== devices.length) await kv.put(`${ns}/push`, JSON.stringify(alive));
  return results;
}

/** Cron: fällige Erinnerungen verschicken. */
export async function runDue(env: Env, now = Date.now()): Promise<void> {
  const kv = env.APP_KV;
  if (!kv) return;
  const index = (await getJson<string[]>(kv, "push-index")) ?? [];
  if (!index.length) return;
  const vapid = await vapidKeys(kv);

  for (const ns of index) {
    const devices = (await getJson<Device[]>(kv, `${ns}/push`)) ?? [];
    if (!devices.length) continue;
    const todos = (await getJson<Record<string, Json>>(kv, `${ns}/todos`)) ?? {};
    const fired = (await getJson<Record<string, number>>(kv, `${ns}/fired`)) ?? {};
    const tz = devices[0].tz || DEFAULT_TZ;
    const messages: Json[] = [];
    let changed = false;

    for (const [id, todo] of Object.entries(todos)) {
      if (todo.done || !Array.isArray(todo.rem)) continue;
      (todo.rem as Json[]).forEach((r, i) => {
        if (!r || typeof r.at !== "string") return;
        const key = `${id}#${i}#${r.at}`;
        if (fired[key]) return;
        const due = localToEpoch(r.at, tz);
        if (Number.isNaN(due) || due > now) return;
        fired[key] = now;
        changed = true;
        if (now - due < MAX_AGE_MS) {
          const text = typeof r.m === "string" && r.m ? r.m : String(todo.note ?? "");
          messages.push({
            title: `${DOTS[i] ?? ""} ${String(todo.text ?? "Erinnerung")}`.trim(),
            body: text,
            tag: key,
            url: "/app/",
          });
        }
      });
    }

    for (const k of Object.keys(fired)) if (now - fired[k] > FIRED_KEEP_MS) delete fired[k];
    // Zuerst merken, dann senden: lieber eine Nachricht verlieren als sie doppelt schicken.
    if (changed) await kv.put(`${ns}/fired`, JSON.stringify(fired));
    for (const message of messages) await deliver(kv, ns, devices, vapid, message);
  }
}

/** `/api/push/*`, die Passphrase ist schon geprüft (`ns`). */
export async function handlePush(
  request: Request,
  env: Env,
  ns: string,
  rest: string[],
  body: Json | null,
): Promise<Response> {
  const kv = env.APP_KV;
  if (!kv) return json({ error: "no_storage", message: "Der Speicher (KV) ist nicht eingerichtet." }, 503);
  const action = rest[0];

  if (action === "key" && request.method === "GET") {
    return json({ publicKey: (await vapidKeys(kv)).publicKey });
  }

  const devices = (await getJson<Device[]>(kv, `${ns}/push`)) ?? [];

  if (action === "subscribe" && request.method === "POST") {
    const sub = body?.subscription as Partial<Device> | undefined;
    if (!sub?.endpoint || !sub.keys?.auth || !sub.keys.p256dh || !sub.endpoint.startsWith("https://")) {
      return json({ error: "bad_request", message: "Ungültige Anmeldung." }, 400);
    }
    const device: Device = {
      endpoint: sub.endpoint,
      expirationTime: sub.expirationTime ?? null,
      keys: { auth: sub.keys.auth, p256dh: sub.keys.p256dh },
      tz: typeof body?.tz === "string" ? body.tz : DEFAULT_TZ,
      origin: new URL(request.url).origin,
    };
    const next = [device, ...devices.filter((d) => d.endpoint !== device.endpoint)].slice(0, MAX_DEVICES);
    await kv.put(`${ns}/push`, JSON.stringify(next));
    const index = (await getJson<string[]>(kv, "push-index")) ?? [];
    if (!index.includes(ns)) await kv.put("push-index", JSON.stringify([...index, ns]));
    return json({ ok: true });
  }

  if (action === "unsubscribe" && request.method === "POST") {
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    await kv.put(`${ns}/push`, JSON.stringify(devices.filter((d) => d.endpoint !== endpoint)));
    return json({ ok: true });
  }

  if (action === "test" && request.method === "POST") {
    if (!devices.length) return json({ error: "no_device", message: "Kein Gerät angemeldet." }, 400);
    const results = await deliver(kv, ns, devices, await vapidKeys(kv), {
      title: "\u{1F7E2} Test",
      body: "So sieht eine Erinnerung aus.",
      tag: `test-${Date.now()}`,
      url: "/app/",
    });
    return json({ ok: results.some((r) => r === "ok"), results });
  }

  return json({ error: "not_found", message: "Unbekannt." }, 404);
}
