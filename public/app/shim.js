/* Stellt der Seite dieselben Funktionen bereit wie in Claude (mcp, db), aber über die eigene
   Worker-Adresse. Die Seite selbst merkt keinen Unterschied. */
(function () {
  "use strict";
  var CFG = "ep_cfg", TOK = "ep_tok", SNAP = "ep_snap_";
  var cfg = null, tok = null;
  try { cfg = JSON.parse(localStorage.getItem(CFG) || "null"); } catch (e) {}
  try { tok = JSON.parse(localStorage.getItem(TOK) || "null"); } catch (e) {}

  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function err(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  function jfetch(path, opt) {
    return fetch(path, opt).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = JSON.parse(t); } catch (e) {}
        if (!r.ok) { throw err((j && j.error) || "upstream_error", (j && j.message) || ("HTTP " + r.status)); }
        return j || {};
      });
    });
  }

  /* ---------- Einrichtung ---------- */
  var setupWaiters = [], setupOpen = false;
  function ready() {
    if (cfg && cfg.key && cfg.email && cfg.password) return Promise.resolve(cfg);
    return new Promise(function (res) { setupWaiters.push(res); showSetup(""); });
  }
  function done() { var w = setupWaiters; setupWaiters = []; w.forEach(function (f) { f(cfg); }); }

  function showSetup(message) {
    if (setupOpen) { var m = document.getElementById("ep-setup-msg"); if (m) m.textContent = message || ""; return; }
    setupOpen = true;
    var box = document.createElement("div");
    box.id = "ep-setup";
    box.style.cssText = "position:fixed;inset:0;z-index:99;background:var(--bg,#fff);color:var(--text,#111);overflow:auto;padding:20px;font:16px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif";
    var inner = '<div style="max-width:420px;margin:8vh auto 0"><h1 style="font-size:20px;margin:0 0 8px">Zugang einrichten</h1>' +
      '<p style="color:var(--muted,#667);margin:0 0 14px;font-size:14px">Die Passphrase muss auf allen Geräten gleich sein, damit du überall dieselben Haken und Listen siehst. Das Yazio-Passwort bleibt nur auf diesem Gerät.</p>' +
      '<form id="ep-form" autocomplete="on">' +
      field("ep-key", "Passphrase (mindestens 10 Zeichen)", "password", "off", cfg && cfg.key) +
      field("ep-mail", "Yazio-E-Mail", "email", "username", cfg && cfg.email) +
      field("ep-pw", "Yazio-Passwort", "password", "current-password", "") +
      '<div id="ep-setup-msg" style="color:#d4553f;min-height:20px;margin:6px 0;font-size:14px"></div>' +
      '<button type="submit" id="ep-go" style="font:inherit;padding:10px 16px;border-radius:10px;border:1px solid #888;background:transparent;color:inherit">Speichern und anmelden</button></form></div>';
    box.innerHTML = inner;
    document.body.appendChild(box);
    document.getElementById("ep-setup-msg").textContent = message || "";
    document.getElementById("ep-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var key = document.getElementById("ep-key").value, email = document.getElementById("ep-mail").value.trim(), pw = document.getElementById("ep-pw").value;
      var msg = document.getElementById("ep-setup-msg"), go = document.getElementById("ep-go");
      if (key.length < 10) { msg.textContent = "Die Passphrase braucht mindestens 10 Zeichen."; return; }
      if (!email || !pw) { msg.textContent = "E-Mail und Passwort fehlen."; return; }
      go.disabled = true; msg.textContent = "Prüfe Anmeldung …";
      jfetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email, password: pw }) })
        .then(function (r) {
          cfg = { key: key, email: email, password: pw };
          tok = { token: r.token, expiresAt: r.expiresAt };
          save(CFG, cfg); save(TOK, tok);
          box.remove(); setupOpen = false; done();
        })
        .catch(function (er) { go.disabled = false; msg.textContent = er.message || "Anmeldung fehlgeschlagen."; });
    });
  }
  function field(id, label, type, ac, val) {
    return '<label style="display:block;font-size:13px;color:var(--muted,#667);margin-top:10px" for="' + id + '">' + label + '</label>' +
      '<input id="' + id + '" type="' + type + '" autocomplete="' + ac + '" value="' + String(val || "").replace(/"/g, "&quot;") + '" style="width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #888;border-radius:10px;background:transparent;color:inherit">';
  }
  window.epSetup = function () { cfg = cfg || {}; showSetup(""); };

  /* ---------- Yazio ---------- */
  var loginP = null;
  function login() {
    if (loginP) return loginP;
    loginP = doLogin();
    var clear = function () { loginP = null; };
    loginP.then(clear, clear);
    return loginP;
  }
  function doLogin() {
    return jfetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: cfg.email, password: cfg.password }) })
      .then(function (r) { tok = { token: r.token, expiresAt: r.expiresAt }; save(TOK, tok); return tok; })
      .catch(function (e) {
        if (e.code === "bad_credentials") { cfg.password = ""; save(CFG, cfg); showSetup("Yazio hat die Anmeldedaten abgelehnt. Bitte neu eingeben."); }
        throw e;
      });
  }
  function ensureTok() {
    if (tok && tok.token && tok.expiresAt - Date.now() > 120000) return Promise.resolve(tok);
    return login();
  }
  function post(tool, input, retry) {
    return ensureTok().then(function (t) {
      return jfetch("/api/call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t.token }, body: JSON.stringify({ tool: tool, input: input || {} }) });
    }).catch(function (e) {
      if (e.code === "session" && !retry) { tok = null; return login().then(function () { return post(tool, input, true); }); }
      if (e.code === "session") e.code = "needs_reauth";
      if (e.code === "bad_credentials") e.code = "needs_reauth";
      throw e;
    });
  }
  var mcp = {
    callTool: function (server, tool, input) {
      return post(tool, input).then(function (r) { return { payload: r.text, content: [{ type: "text", text: r.text }] }; });
    }
  };

  /* ---------- Gemeinsamer Speicher ---------- */
  var recent = {}; // lokale Schreibvorgänge, die ein veraltetes Abfrageergebnis nicht überschreiben darf
  var HOLD = 90000;
  function hdr() { return { "x-app-key": cfg.key, "content-type": "application/json" }; }
  function note(coll, id, kind, data) { recent[coll + "/" + id] = { kind: kind, data: data, until: Date.now() + HOLD }; }
  function overlay(coll, docs) {
    var now = Date.now();
    Object.keys(recent).forEach(function (k) {
      var r = recent[k]; if (r.until < now) { delete recent[k]; return; }
      var p = k.split("/"); if (p[0] !== coll) return;
      if (r.kind === "set") docs[p[1]] = r.data;
      else if (r.kind === "update") { if (docs[p[1]]) docs[p[1]] = Object.assign({}, docs[p[1]], r.data); }
      else if (r.kind === "delete") delete docs[p[1]];
    });
    return docs;
  }
  function makeSnap(docs) {
    return { docs: Object.keys(docs).map(function (id) { var d = docs[id]; return { id: id, data: function () { return d; } }; }) };
  }
  var pollers = [];
  function pollAll() { pollers.forEach(function (f) { f(); }); }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) pollAll(); });
  window.addEventListener("online", pollAll);
  setInterval(function () { if (!document.hidden) pollAll(); }, 20000);

  var db = {
    collection: function (coll) {
      return {
        onSnapshot: function (cb, errcb) {
          var last = "";
          try { var c = JSON.parse(localStorage.getItem(SNAP + coll) || "null"); if (c) { last = JSON.stringify(c); setTimeout(function () { cb(makeSnap(c)); }, 0); } } catch (e) {}
          function poll() {
            jfetch("/api/db/" + coll, { headers: hdr() }).then(function (r) {
              var docs = overlay(coll, r.docs || {});
              var s = JSON.stringify(docs);
              if (s !== last) { last = s; save(SNAP + coll, docs); cb(makeSnap(docs)); }
              else if (!pollers.first) { /* unverändert */ }
            }).catch(function (e) {
              if (errcb && (e.code === "passphrase" || e.code === "no_storage")) errcb(e);
            });
          }
          pollers.push(poll); poll();
        },
        add: function (data) {
          return jfetch("/api/db/" + coll, { method: "POST", headers: hdr(), body: JSON.stringify(data) }).then(function (r) { note(coll, r.id, "set", data); setTimeout(pollAll, 300); return r; });
        }
      };
    },
    doc: function (path) {
      var p = path.split("/"), coll = p[0], id = p[1], url = "/api/db/" + coll + "/" + encodeURIComponent(id);
      return {
        set: function (data) { note(coll, id, "set", data); return jfetch(url + "?m=set", { method: "PUT", headers: hdr(), body: JSON.stringify(data) }); },
        update: function (patch) { note(coll, id, "update", patch); return jfetch(url + "?m=update", { method: "PUT", headers: hdr(), body: JSON.stringify(patch) }); },
        delete: function () { note(coll, id, "delete"); return jfetch(url, { method: "DELETE", headers: hdr() }); }
      };
    }
  };

  window.claude = {
    use: function (name) {
      if (name === "mcp") return ready().then(function () { return mcp; });
      if (name === "db") return ready().then(function () { return db; });
      return Promise.resolve(null);
    }
  };

  document.addEventListener("DOMContentLoaded", function () {
    var b = document.createElement("button");
    b.type = "button"; b.textContent = "Zugang ändern";
    b.style.cssText = "display:block;margin:6px auto 24px;font:inherit;font-size:13px;color:var(--muted,#667);background:none;border:0;text-decoration:underline;cursor:pointer";
    b.addEventListener("click", function () { window.epSetup(); });
    document.body.appendChild(b);
  });
  if ("serviceWorker" in navigator) { window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); }); }
})();
