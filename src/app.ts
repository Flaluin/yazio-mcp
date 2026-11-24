/**
 * Endpoints for the Ernährungs-Dashboard (the web app in `public/app`).
 *
 * The MCP connector stays exactly as it was. These routes sit next to it:
 *
 *   POST /api/login          Yazio email + password in, Yazio session token out.
 *                            The password is used for this one request and forgotten.
 *   POST /api/call           One of the three read tools the dashboard needs, answered
 *                            in the same text the MCP tools return. Bearer = session token.
 *   GET|POST|PUT|DELETE /api/db/<collection>[/<id>]
 *                            Small shared store (ticks, to-dos, ideas) in Workers KV, so
 *                            every device sees the same data. Header `x-app-key` is the
 *                            user's passphrase; the data lives under its hash.
 *
 * Nothing about Yazio is stored. The passphrase is not stored either: only a hash
 * of it is used as the key prefix, so without the passphrase the data cannot be found.
 */

import { dateRange, resolveDate, todayAtOffset } from "./dates";
import { formatDaySummary, formatGoals, formatNutrientHistory, formatRangeSummary } from "./format";
import { allow, clientIp, RETRY_AFTER_HEADERS, tokenKey, type Env } from "./limits";
import { decodeSession, encodeSession, offsetMinutes, sha256Base64Url, type Session } from "./session";
import { getUser, login, YazioApiError, YazioShapeError } from "./yazio/api";
import { NUTRIENTS, YazioService } from "./yazio/service";

const MAX_RANGE_DAYS = 31;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_DOCS = 2000;
const COLLECTIONS = new Set(["checks", "todos", "ideas"]);
const ID = /^[A-Za-z0-9_-]{1,48}$/;
const MIN_PASSPHRASE = 10;

type Doc = Record<string, unknown>;
type Store = Record<string, Doc>;

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

function fail(status: number, error: string, message: string): Response {
  return json({ error, message }, status);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// --- Yazio -----------------------------------------------------------------

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return fail(405, "method", "POST only.");
  if (!(await allow(env.TOKEN_LIMIT, clientIp(request)))) {
    return json(
      { error: "rate_limited", message: "Zu viele Anmeldeversuche. Warte eine Minute." },
      429,
      RETRY_AFTER_HEADERS,
    );
  }

  const body = await readJson(request);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) return fail(400, "bad_request", "E-Mail und Passwort fehlen.");

  try {
    const token = await login(email, password);
    const user = await getUser(token.accessToken);
    const session: Session = {
      ...token,
      country: (user.food_database_country ?? user.country ?? "US").slice(0, 2).toUpperCase(),
      sex: user.sex === "female" ? "female" : "male",
      timezoneOffsetMinutes: offsetMinutes(user.timezone_offset),
    };
    return json({ token: encodeSession(session), expiresAt: session.expiresAt });
  } catch (error) {
    if (error instanceof YazioApiError && (error.status === 400 || error.status === 401)) {
      return fail(401, "bad_credentials", "Yazio hat E-Mail oder Passwort abgelehnt.");
    }
    return fail(503, "upstream", "Yazio antwortet gerade nicht. Versuch es gleich noch einmal.");
  }
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
}

async function handleCall(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return fail(405, "method", "POST only.");

  const token = bearer(request);
  const session = token ? decodeSession(token) : null;
  if (!token || !session) return fail(401, "session", "Die Yazio-Sitzung ist abgelaufen.");

  if (!(await allow(env.MCP_LIMIT, await tokenKey(token)))) {
    return json({ error: "rate_limited", message: "Zu viele Anfragen." }, 429, RETRY_AFTER_HEADERS);
  }

  const body = await readJson(request);
  const tool = typeof body?.tool === "string" ? body.tool : "";
  const input = (body?.input && typeof body.input === "object" ? body.input : {}) as Record<
    string,
    unknown
  >;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;

  const yazio = new YazioService(session);
  const today = todayAtOffset(session.timezoneOffsetMinutes ?? 0);

  try {
    switch (tool) {
      case "get_goals":
        return json({ text: formatGoals(await yazio.goals(resolveDate(str(input.date), today))) });

      case "get_daily_summary": {
        const start = str(input.start_date);
        if (start) {
          const dates = dateRange(
            resolveDate(start, today),
            resolveDate(str(input.end_date), today),
            MAX_RANGE_DAYS,
          );
          if (dates.length === 1) return json({ text: formatDaySummary(await yazio.daySummary(dates[0])) });
          return json({ text: formatRangeSummary(await yazio.rangeSummary(dates)) });
        }
        return json({
          text: formatDaySummary(await yazio.daySummary(resolveDate(str(input.date), today))),
        });
      }

      case "get_nutrient_history": {
        const nutrient = str(input.nutrient);
        if (!nutrient || !Object.hasOwn(NUTRIENTS, nutrient)) {
          return fail(400, "bad_request", "Unbekannter Nährstoff.");
        }
        const dates = dateRange(
          resolveDate(str(input.start_date), today),
          resolveDate(str(input.end_date), today),
          MAX_RANGE_DAYS,
        );
        return json({
          text: formatNutrientHistory(
            await yazio.nutrientHistory(nutrient as keyof typeof NUTRIENTS, dates),
          ),
        });
      }

      default:
        return fail(400, "bad_request", "Unbekannte Abfrage.");
    }
  } catch (error) {
    if (error instanceof YazioApiError && error.status === 401) {
      return fail(401, "session", "Die Yazio-Sitzung ist abgelaufen.");
    }
    if (error instanceof YazioApiError || error instanceof YazioShapeError) {
      return fail(502, "upstream", error.message);
    }
    return fail(400, "bad_request", error instanceof Error ? error.message : "Fehler.");
  }
}

// --- shared store ------------------------------------------------------------

async function namespaceOf(request: Request): Promise<string | null> {
  const key = request.headers.get("x-app-key") ?? "";
  if (key.length < MIN_PASSPHRASE) return null;
  return sha256Base64Url(`ernaehrung:v1:${key}`);
}

async function readStore(kv: KVNamespace, ns: string, collection: string): Promise<Store> {
  const raw = await kv.get(`${ns}/${collection}`);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Store;
  } catch {
    return {};
  }
}

async function handleDb(request: Request, env: Env, rest: string[]): Promise<Response> {
  const kv = env.APP_KV;
  if (!kv) return fail(503, "no_storage", "Der Speicher (KV) ist nicht eingerichtet.");

  const ns = await namespaceOf(request);
  if (!ns) {
    return fail(401, "passphrase", `Die Passphrase braucht mindestens ${MIN_PASSPHRASE} Zeichen.`);
  }
  if (!(await allow(env.MCP_LIMIT, `db:${ns}`))) {
    return json({ error: "rate_limited", message: "Zu viele Anfragen." }, 429, RETRY_AFTER_HEADERS);
  }

  const [collection, id] = rest;
  if (!collection || !COLLECTIONS.has(collection)) return fail(404, "not_found", "Unbekannt.");

  if (request.method === "GET" && !id) {
    return json({ docs: await readStore(kv, ns, collection) });
  }

  if (request.method === "POST" && !id) {
    const body = await readJson(request);
    if (!body) return fail(400, "bad_request", "Ungültige Daten.");
    const store = await readStore(kv, ns, collection);
    if (Object.keys(store).length >= MAX_DOCS) return fail(409, "full", "Zu viele Einträge.");
    const newId = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
    store[newId] = body;
    await kv.put(`${ns}/${collection}`, JSON.stringify(store));
    return json({ id: newId });
  }

  if (!id || !ID.test(id)) return fail(400, "bad_request", "Ungültige ID.");

  if (request.method === "PUT") {
    const body = await readJson(request);
    if (!body) return fail(400, "bad_request", "Ungültige Daten.");
    const mode = new URL(request.url).searchParams.get("m") === "update" ? "update" : "set";
    const store = await readStore(kv, ns, collection);
    if (mode === "update" && !store[id]) return fail(404, "not_found", "Eintrag fehlt.");
    if (!store[id] && Object.keys(store).length >= MAX_DOCS) {
      return fail(409, "full", "Zu viele Einträge.");
    }
    store[id] = mode === "update" ? { ...store[id], ...body } : body;
    await kv.put(`${ns}/${collection}`, JSON.stringify(store));
    return json({ ok: true });
  }

  if (request.method === "DELETE") {
    const store = await readStore(kv, ns, collection);
    if (id in store) {
      delete store[id];
      await kv.put(`${ns}/${collection}`, JSON.stringify(store));
    }
    return json({ ok: true });
  }

  return fail(405, "method", "Nicht erlaubt.");
}

// --- entry -------------------------------------------------------------------

/** Handle `/api/*`. Resolves to `undefined` for any other path. */
export async function handleAppRequest(request: Request, env: Env): Promise<Response | undefined> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/")) return undefined;

  const parts = pathname.slice(5).split("/").filter(Boolean);
  switch (parts[0]) {
    case "login":
      return handleLogin(request, env);
    case "call":
      return handleCall(request, env);
    case "db":
      return handleDb(request, env, parts.slice(1));
    case "health":
      return json({ status: "ok" });
    default:
      return fail(404, "not_found", "Unbekannt.");
  }
}
