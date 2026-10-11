import { createHash } from "node:crypto";

/**
 * The browser SDK an artifact page loads with `<script src="/api/v1/client.js"></script>`.
 *
 * It is served by the daemon, so it upgrades with the agent and never needs a client release.
 * It is plain, dependency-free ES2017 for every browser engine a client embeds, and it installs
 * one global, `window.happy`. Changes arrive over a streamed `fetch` of `/api/v1/kv/events`
 * rather than `EventSource`, so the SDK sees status codes and can resume with `since`.
 *
 * It also reports what goes wrong on the page to `/api/v1/debug/log`: uncaught errors, unhandled
 * rejections, `console.error` and `console.warn`, and its own sync trouble, in small rate-limited
 * batches that are dropped rather than retried, so reporting never adds load to a failing page.
 */
export const ARTIFACT_DATA_CLIENT_SCRIPT = String.raw`/* Happy artifact data SDK, served by Happy Agent. */
(function (global) {
    "use strict";
    if (global.happy && global.happy.kv) return;

    var BASE = "/api/v1";
    var HEARTBEAT_TIMEOUT_MS = 45000;
    var MIN_RETRY_MS = 500;
    var MAX_RETRY_MS = 30000;
    var LOG_DELAY_MS = 2000;
    var LOG_BATCH = 20;
    var LOG_QUEUE = 100;
    var LOG_PER_MINUTE = 60;
    var LOG_MESSAGE_LENGTH = 4096;
    var LOG_DATA_LENGTH = 8000;

    // ---- small helpers ----------------------------------------------------------------------

    function randomId() {
        var bytes = new Uint8Array(16);
        if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(bytes);
        else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
        var out = "w";
        for (var j = 0; j < 16; j++) out += (bytes[j] + 256).toString(16).slice(1);
        return out;
    }

    function backoff(attempt) {
        var base = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * Math.pow(2, attempt));
        return Math.round(base / 2 + Math.random() * (base / 2));
    }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /** The moment a UUIDv7 version was minted, as a Date. */
    function timeOf(version) {
        if (typeof version !== "string" || version.length < 13) return null;
        return new Date(parseInt(version.replace(/-/g, "").slice(0, 12), 16));
    }

    function startsWith(key, prefix) {
        return key.slice(0, prefix.length) === prefix;
    }

    function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function emitter() {
        var listeners = [];
        return {
            on: function (fn) {
                listeners.push(fn);
                return function () {
                    var index = listeners.indexOf(fn);
                    if (index >= 0) listeners.splice(index, 1);
                };
            },
            emit: function (value) {
                listeners.slice().forEach(function (fn) {
                    try { fn(value); } catch (error) { setTimeout(function () { throw error; }); }
                });
            },
        };
    }

    function HappyError(status, body) {
        var error = new Error((body && body.error) || "Request failed with status " + status + ".");
        error.name = "HappyError";
        error.status = status;
        error.code = (body && body.code) || (status === 0 ? "network" : "internal");
        if (body && "entry" in body) error.current = body.entry;
        return error;
    }

    function retryable(error) {
        return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
    }

    function baseHeaders(accept) {
        return { accept: accept };
    }

    function request(method, path, body, headers) {
        var init = { method: method, headers: baseHeaders("application/json"), cache: "no-store" };
        for (var name in headers || {}) init.headers[name] = headers[name];
        if (body !== undefined) {
            init.headers["content-type"] = "application/json";
            init.body = JSON.stringify(body);
        }
        return global.fetch(BASE + path, init).then(
            function (response) {
                return response.text().then(function (text) {
                    var parsed = null;
                    try { parsed = text === "" ? null : JSON.parse(text); } catch (error) { parsed = null; }
                    if (response.status === 404 && (parsed === null || parsed.code === "not_found")) {
                        // The artifact is gone, or this daemon has no data API.
                        unavailable = true;
                        updateStatus();
                    }
                    if (!response.ok) throw HappyError(response.status, parsed);
                    return parsed;
                });
            },
            function () { throw HappyError(0, { error: "The network is unavailable.", code: "network" }); }
        );
    }

    function query(params) {
        var parts = [];
        for (var name in params) {
            if (params[name] !== undefined && params[name] !== null) {
                parts.push(encodeURIComponent(name) + "=" + encodeURIComponent(String(params[name])));
            }
        }
        return parts.length === 0 ? "" : "?" + parts.join("&");
    }

    // ---- state ------------------------------------------------------------------------------

    /** Confirmed entries, tombstones included, for every key a page is interested in. */
    var server = new Map();
    /** Writes not yet confirmed, oldest first; each overlays the confirmed value of its key. */
    var queue = [];
    var trackedKeys = new Map();
    var trackedPrefixes = [];
    var changes = emitter();
    var statusChanges = emitter();
    var status = "connecting";
    var cursor = null;
    var streamReady = false;
    var everReady = false;
    var unavailable = false;
    var loading = 0;
    var flushWaiters = [];
    var me = null;
    var mePromise = null;
    var users = new Map();
    var readyResolve;
    var ready = new Promise(function (resolve) { readyResolve = resolve; });

    function interested(key) {
        if (trackedKeys.has(key) || server.has(key)) return true;
        for (var i = 0; i < trackedPrefixes.length; i++) {
            if (startsWith(key, trackedPrefixes[i].prefix)) return true;
        }
        return false;
    }

    function updateStatus() {
        var next = unavailable
            ? "unavailable"
            : !streamReady
                ? (everReady ? "offline" : "connecting")
                : (queue.length > 0 || loading > 0 ? "syncing" : "online");
        if (next !== status) {
            status = next;
            if (status === "unavailable") {
                report("error", "sync", "Artifact data is unavailable: the artifact is gone, or this daemon has no data API.");
            }
            statusChanges.emit(status);
        }
        if (queue.length === 0) {
            var waiters = flushWaiters;
            flushWaiters = [];
            waiters.forEach(function (resolve) { resolve(); });
        }
    }

    /** What a page should show for one key: its newest pending write, or its confirmed entry. */
    function view(key) {
        for (var i = queue.length - 1; i >= 0; i--) {
            var write = queue[i];
            if (write.key === key) {
                var base = server.get(key);
                return {
                    key: key,
                    exists: write.op === "set",
                    value: write.op === "set" ? clone(write.value) : undefined,
                    version: base ? base.version : null,
                    updatedBy: me ? me.id : null,
                    updatedAt: write.at,
                    pending: true,
                };
            }
        }
        var entry = server.get(key);
        if (!entry || entry.deleted) {
            return { key: key, exists: false, value: undefined, version: entry ? entry.version : null,
                updatedBy: entry ? entry.updatedBy : null, updatedAt: entry ? entry.updatedAt : null, pending: false };
        }
        return { key: key, exists: true, value: clone(entry.value), version: entry.version,
            updatedBy: entry.updatedBy, updatedAt: entry.updatedAt, pending: false };
    }

    function notify(key) {
        var watchers = trackedKeys.get(key);
        if (watchers) watchers.forEach(function (tracker) { tracker._refresh(); });
        trackedPrefixes.forEach(function (tracker) {
            if (startsWith(key, tracker.prefix)) tracker._refresh();
        });
    }

    /**
     * Keep the newer of the confirmed entry and an incoming one; versions order every change.
     * Keys nobody tracks are only reported, except a key this page wrote itself.
     */
    function merge(entry, written) {
        if (!entry || typeof entry.key !== "string") return;
        var current = server.get(entry.key);
        if (current && current.version >= entry.version) return;
        if (written || interested(entry.key)) server.set(entry.key, entry);
        notify(entry.key);
        changes.emit(clone(entry));
    }

    function tombstone(entry) {
        return { key: entry.key, value: null, deleted: true, version: entry.version,
            updatedBy: entry.updatedBy, updatedAt: entry.updatedAt, writeId: null };
    }

    /** A confirmed live key a read no newer than it did not find was deleted out of earshot. */
    function forget(key, readCursor) {
        var current = server.get(key);
        if (current && !current.deleted && (readCursor === null || current.version <= readCursor)) {
            server.set(key, tombstone(current));
            notify(key);
        }
    }

    // ---- reads ------------------------------------------------------------------------------

    function loadKey(key) {
        loading++;
        updateStatus();
        return request("GET", "/kv/entry" + query({ key: key }))
            .then(function (body) {
                if (body.entry) merge(body.entry, false);
                else forget(key, body.cursor);
            })
            .then(function () { loading--; updateStatus(); }, function (error) {
                loading--; updateStatus(); throw error;
            });
    }

    function listAll(prefix) {
        var entries = [];
        var firstCursor;
        function page(after) {
            return request("GET", "/kv" + query({ prefix: prefix, pageCursor: after, limit: 1000 })).then(function (body) {
                if (firstCursor === undefined) firstCursor = body.cursor;
                entries = entries.concat(body.entries);
                return body.nextPageCursor ? page(body.nextPageCursor) : { entries: entries, cursor: firstCursor };
            });
        }
        return page(undefined);
    }

    function loadPrefix(prefix) {
        loading++;
        updateStatus();
        return listAll(prefix).then(function (result) {
            var seen = new Set();
            result.entries.forEach(function (entry) { seen.add(entry.key); merge(entry, false); });
            // A confirmed key missing from the listing, and no newer than it, was deleted while
            // this page could not hear it.
            Array.from(server.keys()).forEach(function (key) {
                if (startsWith(key, prefix) && !seen.has(key)) forget(key, result.cursor);
            });
            loading--;
            updateStatus();
        }, function (error) { loading--; updateStatus(); throw error; });
    }

    /** Read every tracker again, or after a resumed connection only those never read. */
    function refreshTracked(all) {
        var work = [];
        trackedKeys.forEach(function (watchers, key) {
            var waiting = Array.from(watchers).filter(function (tracker) { return all || !tracker.loaded; });
            if (waiting.length === 0) return;
            work.push(loadKey(key).then(function () {
                waiting.forEach(function (tracker) { tracker._loaded(); });
            }));
        });
        trackedPrefixes.forEach(function (tracker) {
            if (all || !tracker.loaded) work.push(loadPrefix(tracker.prefix).then(tracker._loaded));
        });
        return Promise.all(work).catch(function () { /* the next connection reads again */ });
    }

    // ---- the change stream ------------------------------------------------------------------

    var streamAbort = null;
    var streamAttempt = 0;
    var reconnectTimer = null;

    function connect() {
        if (unavailable || streamAbort) return;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        var controller = new AbortController();
        streamAbort = controller;
        var watchdog = null;
        function alive() {
            if (watchdog) clearTimeout(watchdog);
            watchdog = setTimeout(function () { controller.abort(); }, HEARTBEAT_TIMEOUT_MS);
        }
        var resuming = cursor !== null;
        alive();
        var failure = null;
        global.fetch(BASE + "/kv/events" + query({ since: cursor }), {
            headers: baseHeaders("text/event-stream"),
            cache: "no-store",
            signal: controller.signal,
        }).then(function (response) {
            if (response.status === 404) {
                unavailable = true;
                throw HappyError(404, null);
            }
            if (!response.ok || !response.body) throw HappyError(response.status, null);
            var reader = response.body.getReader();
            var decoder = new TextDecoder();
            var buffer = "";
            var event = { type: "message", data: "", id: null };
            function dispatch() {
                var type = event.type;
                var data = event.data;
                var id = event.id;
                event = { type: "message", data: "", id: null };
                if (data === "") return;
                var payload;
                try { payload = JSON.parse(data); } catch (error) { return; }
                if (type === "ready") {
                    cursor = payload.cursor;
                    streamReady = true;
                    streamAttempt = 0;
                    var first = !everReady;
                    everReady = true;
                    updateStatus();
                    refreshTracked(!resuming);
                    if (first) readyResolve();
                    pump();
                } else if (type === "change") {
                    merge(payload, false);
                    if (id) cursor = id;
                } else if (type === "reset") {
                    report("warn", "sync", "The change stream could not resume, so the page reads its data again.", payload);
                    cursor = null;
                    controller.abort();
                }
            }
            function read() {
                return reader.read().then(function (chunk) {
                    if (chunk.done) return;
                    alive();
                    buffer += decoder.decode(chunk.value, { stream: true });
                    var lines = buffer.split(/\r\n|\r|\n/);
                    buffer = lines.pop();
                    lines.forEach(function (line) {
                        if (line === "") return dispatch();
                        if (line.charAt(0) === ":") return;
                        var colon = line.indexOf(":");
                        var field = colon < 0 ? line : line.slice(0, colon);
                        var value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
                        if (field === "event") event.type = value;
                        else if (field === "data") event.data = event.data === "" ? value : event.data + "\n" + value;
                        else if (field === "id") event.id = value;
                    });
                    return read();
                });
            }
            return read();
        }).catch(function (error) { failure = error; /* every ending reconnects below */ }).then(function () {
            if (watchdog) clearTimeout(watchdog);
            var wasReady = streamReady;
            streamAbort = null;
            streamReady = false;
            updateStatus();
            if (unavailable) return;
            if (wasReady) {
                report("warn", "sync", "The change stream ended; reconnecting.", failure ? { error: String(failure.message || failure) } : undefined);
            } else if (streamAttempt > 0) {
                report("info", "sync", "Reconnecting the change stream failed.", {
                    attempt: streamAttempt,
                    status: failure && failure.status !== undefined ? failure.status : null,
                });
            }
            var delay = backoff(streamAttempt++);
            reconnectTimer = setTimeout(connect, delay);
        });
    }

    // ---- writes -----------------------------------------------------------------------------

    var pumping = false;

    function pump() {
        if (pumping || queue.length === 0 || unavailable) return;
        pumping = true;
        var write = queue[0];
        var headers = {};
        if (write.ifVersion) headers["if-match"] = '"' + write.ifVersion + '"';
        if (write.ifAbsent) headers["if-none-match"] = "*";
        var path = "/kv/entry" + query({ key: write.key });
        var sent = write.op === "set"
            ? request("PUT", path, { value: write.value, writeId: write.id }, headers)
            : request("DELETE", path, { writeId: write.id }, headers);
        sent.then(function (body) {
            queue.shift();
            write.attempt = 0;
            merge(body.entry, true);
            notify(write.key);
            write.resolve(clone(body.entry));
            pumping = false;
            updateStatus();
            pump();
        }, function (error) {
            if (retryable(error) && !unavailable) {
                pumping = false;
                updateStatus();
                var delay = backoff(write.attempt++);
                // Offline: wait for the stream to come back, which pumps again.
                sleep(delay).then(function () { if (streamReady || error.status !== 0) pump(); });
                return;
            }
            queue.shift();
            if (error.current) merge(error.current, true);
            notify(write.key);
            if (error.code === "conflict") {
                report("warn", "sync", "A write to " + JSON.stringify(write.key) + " conflicted with a newer value.", {
                    key: write.key, op: write.op, ifVersion: write.ifVersion || null, current: error.current ? error.current.version : null,
                });
            } else {
                report("error", "sync", "A write to " + JSON.stringify(write.key) + " was refused: " + error.message, {
                    key: write.key, op: write.op, status: error.status, code: error.code,
                });
            }
            write.reject(error);
            pumping = false;
            updateStatus();
            pump();
        });
    }

    function enqueue(op, key, value, options) {
        if (typeof key !== "string" || key === "") throw new TypeError("A key must be a non-empty string.");
        options = options || {};
        var json;
        if (op === "set") {
            json = JSON.stringify(value);
            if (json === undefined) throw new TypeError("A value must be JSON.");
        }
        return new Promise(function (resolve, reject) {
            queue.push({
                id: randomId(), op: op, key: key, value: op === "set" ? JSON.parse(json) : undefined,
                ifVersion: options.ifVersion, ifAbsent: options.ifAbsent === true, at: Date.now(),
                attempt: 0, resolve: resolve, reject: reject,
            });
            notify(key);
            updateStatus();
            pump();
        });
    }

    // ---- trackers ---------------------------------------------------------------------------

    function KeyTracker(key) {
        var self = this;
        var subscribers = emitter();
        var loaded = false;
        self.key = key;
        self._refresh = function () {
            var current = view(key);
            self.exists = current.exists;
            self.value = current.value;
            self.version = current.version;
            self.updatedBy = current.updatedBy;
            self.updatedAt = current.updatedAt;
            self.pending = current.pending;
            self.loaded = loaded;
            self.synced = loaded && !current.pending && streamReady;
            subscribers.emit(self);
        };
        self._loaded = function () { loaded = true; self._refresh(); };
        self.subscribe = function (fn) {
            var off = subscribers.on(fn);
            try { fn(self); } catch (error) { setTimeout(function () { throw error; }); }
            return off;
        };
        self.set = function (value, options) { return enqueue("set", key, value, options); };
        self.delete = function (options) { return enqueue("delete", key, undefined, options); };
        var offStatus = statusChanges.on(function () { self._refresh(); });
        self.stop = function () {
            offStatus();
            var watchers = trackedKeys.get(key);
            if (watchers) { watchers.delete(self); if (watchers.size === 0) trackedKeys.delete(key); }
        };
        var watchers = trackedKeys.get(key);
        if (!watchers) { watchers = new Set(); trackedKeys.set(key, watchers); }
        watchers.add(self);
        self._refresh();
        if (everReady) loadKey(key).then(self._loaded, function () {});
    }

    function PrefixTracker(prefix) {
        var self = this;
        var subscribers = emitter();
        var loaded = false;
        self.prefix = prefix;
        self._refresh = function () {
            var keys = new Set();
            server.forEach(function (_entry, key) { if (startsWith(key, prefix)) keys.add(key); });
            queue.forEach(function (write) { if (startsWith(write.key, prefix)) keys.add(write.key); });
            var entries = [];
            keys.forEach(function (key) {
                var current = view(key);
                if (current.exists) entries.push(current);
            });
            entries.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
            self.entries = entries;
            self.loaded = loaded;
            self.pending = entries.some(function (entry) { return entry.pending; }) ||
                queue.some(function (write) { return startsWith(write.key, prefix); });
            self.synced = loaded && !self.pending && streamReady;
            subscribers.emit(self);
        };
        self._loaded = function () { loaded = true; self._refresh(); };
        self.get = function (key) {
            for (var i = 0; i < self.entries.length; i++) if (self.entries[i].key === key) return self.entries[i];
            return undefined;
        };
        self.subscribe = function (fn) {
            var off = subscribers.on(fn);
            try { fn(self); } catch (error) { setTimeout(function () { throw error; }); }
            return off;
        };
        var offStatus = statusChanges.on(function () { self._refresh(); });
        self.stop = function () {
            offStatus();
            var index = trackedPrefixes.indexOf(self);
            if (index >= 0) trackedPrefixes.splice(index, 1);
        };
        trackedPrefixes.push(self);
        self._refresh();
        if (everReady) loadPrefix(prefix).then(self._loaded, function () {});
    }

    // ---- debug reporting --------------------------------------------------------------------

    var logQueue = [];
    var logTimer = null;
    var logEnabled = true;
    var logMinute = 0;
    var logCount = 0;

    /** A message and data for anything thrown, rejected, or logged. */
    function describe(value) {
        if (value instanceof Error) {
            return { message: (value.name || "Error") + ": " + value.message, data: value.stack ? { stack: String(value.stack) } : undefined };
        }
        if (typeof value === "string") return { message: value, data: undefined };
        try {
            var json = JSON.stringify(value);
            if (json !== undefined) return { message: json, data: undefined };
        } catch (error) { /* described below */ }
        return { message: String(value), data: undefined };
    }

    function report(level, source, message, data) {
        if (!logEnabled) return;
        var now = Date.now();
        var minute = Math.floor(now / 60000);
        if (minute !== logMinute) { logMinute = minute; logCount = 0; }
        if (logCount >= LOG_PER_MINUTE || logQueue.length >= LOG_QUEUE) return;
        logCount++;
        var entry = { level: level, source: source, message: String(message).slice(0, LOG_MESSAGE_LENGTH), at: now };
        if (data !== undefined) {
            try {
                var json = JSON.stringify(data);
                if (json !== undefined) entry.data = json.length <= LOG_DATA_LENGTH ? JSON.parse(json) : { truncated: json.slice(0, 1024) };
            } catch (error) { /* data that is not JSON is left out */ }
        }
        logQueue.push(entry);
        if (logQueue.length >= LOG_BATCH) sendLogs();
        else if (!logTimer) logTimer = setTimeout(sendLogs, LOG_DELAY_MS);
    }

    /** Send what is queued once; a batch that cannot be sent is dropped, never retried. */
    function sendLogs() {
        if (logTimer) { clearTimeout(logTimer); logTimer = null; }
        var batch = logQueue.splice(0, 50);
        if (batch.length === 0) return;
        if (global.navigator && global.navigator.onLine === false) return;
        var url = null;
        try { url = String(global.location.href).slice(0, 1024); } catch (error) { url = null; }
        var headers = baseHeaders("application/json");
        headers["content-type"] = "application/json";
        try {
            global.fetch(BASE + "/debug/log", {
                method: "POST",
                headers: headers,
                cache: "no-store",
                keepalive: true,
                body: JSON.stringify({ entries: batch, url: url }),
            }).catch(function () { /* dropped */ });
        } catch (error) { /* dropped */ }
        if (logQueue.length > 0) logTimer = setTimeout(sendLogs, LOG_DELAY_MS);
    }

    function installReporting() {
        if (!global.addEventListener) return;
        global.addEventListener("error", function (event) {
            var described = event.error !== undefined && event.error !== null
                ? describe(event.error)
                : { message: event.message || "Script error.", data: undefined };
            var data = described.data || {};
            if (event.filename) {
                data.filename = event.filename;
                data.line = event.lineno;
                data.column = event.colno;
            }
            report("error", "uncaught", described.message, data);
        });
        global.addEventListener("unhandledrejection", function (event) {
            var described = describe(event.reason);
            report("error", "rejection", described.message, described.data);
        });
        var console = global.console;
        if (!console) return;
        ["error", "warn"].forEach(function (level) {
            var original = console[level];
            if (typeof original !== "function") return;
            console[level] = function () {
                var args = Array.prototype.slice.call(arguments);
                original.apply(console, args);
                var stack;
                var message = args.map(function (arg) {
                    var described = describe(arg);
                    if (described.data && described.data.stack && !stack) stack = described.data.stack;
                    return described.message;
                }).join(" ");
                report(level, "console", message, stack ? { stack: stack } : undefined);
            };
        });
    }

    // ---- public surface ---------------------------------------------------------------------

    function loadMe() {
        if (!mePromise) {
            mePromise = request("GET", "/me").then(function (body) {
                me = body.user;
                users.set(me.id, me);
                return me;
            }, function (error) { mePromise = null; throw error; });
        }
        return mePromise;
    }

    var happy = {
        /** Resolves once the caller is known and the change stream first connects. */
        ready: Promise.all([ready, loadMe()]).then(function () { return undefined; }),
        get status() { return status; },
        get pending() { return queue.length; },
        get user() { return me; },
        onStatus: function (fn) { return statusChanges.on(fn); },
        /** Resolves when every write made so far has been confirmed or refused. */
        flush: function () {
            if (queue.length === 0) return Promise.resolve();
            return new Promise(function (resolve) { flushWaiters.push(resolve); });
        },
        timeOf: timeOf,
        me: loadMe,
        users: {
            /** People by ID, cached; unknown IDs are left out. */
            load: function (ids) {
                var missing = ids.filter(function (id) { return !users.has(id); });
                var unique = Array.from(new Set(missing));
                var batches = [];
                for (var i = 0; i < unique.length; i += 100) batches.push(unique.slice(i, i + 100));
                return Promise.all(batches.map(function (batch) {
                    return request("GET", "/users" + query({ ids: batch.join(",") })).then(function (body) {
                        body.users.forEach(function (user) { users.set(user.id, user); });
                    });
                })).then(function () {
                    return ids.map(function (id) { return users.get(id); }).filter(Boolean);
                });
            },
            get: function (id) {
                return happy.users.load([id]).then(function (found) { return found[0] || null; });
            },
            cached: function (id) { return users.get(id) || null; },
        },
        kv: {
            /** The key's value as this page sees it, pending writes included; 'undefined' when absent. */
            get: function (key) {
                if (trackedKeys.has(key) || server.has(key)) return Promise.resolve(view(key).value);
                return happy.kv.entry(key).then(function (entry) { return entry ? entry.value : undefined; });
            },
            /** The confirmed entry from the daemon, or 'null' when the key holds no value. */
            entry: function (key) {
                return request("GET", "/kv/entry" + query({ key: key })).then(function (body) {
                    if (body.entry) merge(body.entry, false);
                    else forget(key, body.cursor);
                    return clone(body.entry);
                });
            },
            /** Every confirmed entry under a prefix, in key order. */
            list: function (prefix) {
                return listAll(prefix || "").then(function (result) {
                    result.entries.forEach(function (entry) { merge(entry, false); });
                    return clone(result.entries);
                });
            },
            set: function (key, value, options) { return enqueue("set", key, value, options); },
            delete: function (key, options) { return enqueue("delete", key, undefined, options); },
            /** Read, change, and write one key with compare-and-set, retrying on conflict. */
            update: function (key, change, attempts) {
                attempts = attempts === undefined ? 8 : attempts;
                return happy.kv.entry(key).then(function (entry) {
                    var next = change(entry ? clone(entry.value) : undefined);
                    var options = entry ? { ifVersion: entry.version } : { ifAbsent: true };
                    var write = next === undefined
                        ? (entry ? enqueue("delete", key, undefined, options) : Promise.resolve(null))
                        : enqueue("set", key, next, options);
                    return write.catch(function (error) {
                        if (error.code === "conflict" && attempts > 1) return happy.kv.update(key, change, attempts - 1);
                        throw error;
                    });
                });
            },
            track: function (key) { return new KeyTracker(key); },
            trackPrefix: function (prefix) { return new PrefixTracker(prefix || ""); },
            /** Every confirmed change this page hears, from anyone, as an entry. */
            onChange: function (fn) { return changes.on(fn); },
        },
        debug: {
            /** Report something to the artifact's debug log; level is "info", "warn", or "error". */
            log: function (message, data, level) {
                var described = typeof message === "string" ? { message: message, data: undefined } : describe(message);
                report(level === "error" || level === "warn" ? level : "info", "app", described.message,
                    data === undefined ? described.data : data);
            },
            /** Stop reporting anything from this page, and drop what is queued. */
            disable: function () {
                logEnabled = false;
                logQueue = [];
                if (logTimer) { clearTimeout(logTimer); logTimer = null; }
            },
            /** Send what is queued now rather than after the usual short delay. */
            flush: function () { sendLogs(); },
        },
    };

    global.happy = happy;
    installReporting();
    if (global.addEventListener) {
        global.addEventListener("online", function () {
            if (streamAbort === null) connect();
            pump();
        });
    }
    connect();
})(typeof window !== "undefined" ? window : globalThis);
`;

/** The SDK's ETag, which changes whenever the script does. */
export const ARTIFACT_DATA_CLIENT_ETAG = `"${createHash("sha256").update(ARTIFACT_DATA_CLIENT_SCRIPT).digest("hex").slice(0, 32)}"`;
