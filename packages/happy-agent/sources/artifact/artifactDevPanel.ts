/**
 * The development server's control panel at `/__happy/`: one dependency-free page over the same
 * JSON controls a script or an agent uses, so nothing it does is out of reach without a browser.
 */
export const ARTIFACT_DEV_PANEL = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifact dev server</title>
<style>
    :root { color-scheme: light dark; font: 14px/1.45 system-ui, sans-serif; }
    body { margin: 0 auto; max-width: 1100px; padding: 20px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    h2 { font-size: 15px; margin: 0 0 10px; }
    section { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 10px; padding: 14px; margin: 14px 0; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0; }
    .muted { opacity: .65; }
    button, input, select, textarea { font: inherit; }
    button { padding: 4px 10px; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; cursor: pointer; }
    button.on { background: #d33; color: #fff; border-color: #d33; }
    input[type=number] { width: 80px; }
    table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
    td, th { text-align: left; padding: 3px 6px; border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); vertical-align: top; }
    code, pre, textarea { font-family: ui-monospace, monospace; font-size: 12px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-all; max-height: 320px; overflow: auto; }
    textarea { width: 100%; min-height: 70px; box-sizing: border-box; }
    .user { display: inline-flex; gap: 6px; align-items: center; padding: 2px 8px 2px 2px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); }
    .user img { width: 22px; height: 22px; border-radius: 50%; }
    .error { color: #d33; } .warn { color: #c80; }
</style>
</head>
<body>
<h1>Artifact dev server</h1>
<div class="muted" id="where"></div>

<section>
    <h2>People</h2>
    <div class="row" id="users"></div>
    <div class="row">
        <input id="newUser" placeholder="Name, such as Alice">
        <button id="addUser">Add and open as them</button>
    </div>
    <div class="muted">Open the app as anyone with <code>/?as=Name</code>; each tab can be a different person.</div>
</section>

<section>
    <h2>Network</h2>
    <div class="row">
        <button id="offline">Offline</button>
        <label>Latency <input type="number" id="latency" min="0" max="60000" step="50"> ms</label>
        <button id="setLatency">Set</button>
        <button id="cut">Cut change streams</button>
    </div>
    <div class="row">
        <label>Fail the next <input type="number" id="failCount" min="1" value="1"> requests with 503</label>
        <button id="fail">Fail</button>
        <span class="muted" id="failing"></span>
    </div>
    <div class="row">
        <label>Apply the next <input type="number" id="dropCount" min="1" value="1"> requests, then lose the response</label>
        <button id="drop">Drop</button>
        <span class="muted" id="dropping"></span>
    </div>
</section>

<section>
    <h2>Data</h2>
    <div class="row">
        <label>As <select id="writeAs"></select></label>
        <input id="writeKey" placeholder="key">
        <input id="writeValue" placeholder='JSON value, such as {"done": true}' size="36">
        <button id="write">Write</button>
        <button id="delete">Delete</button>
    </div>
    <div class="row">
        <button id="download">Download dump</button>
        <label>Load dump <input type="file" id="load" accept="application/json"></label>
        <button id="reset">Reset all data</button>
    </div>
    <pre id="data"></pre>
</section>

<section>
    <h2>Debug log</h2>
    <div class="row"><button id="clearLogs">Clear</button></div>
    <table><thead><tr><th>Time</th><th>Level</th><th>Source</th><th>Who</th><th>Message</th></tr></thead><tbody id="logs"></tbody></table>
</section>

<section>
    <h2>Requests</h2>
    <div class="row"><button id="clearRequests">Clear</button></div>
    <table><thead><tr><th>Time</th><th>Who</th><th>Request</th><th>Status</th><th>ms</th><th>Fault</th></tr></thead><tbody id="requests"></tbody></table>
</section>

<script>
(function () {
    "use strict";
    var state = null;
    function $(id) { return document.getElementById(id); }
    function call(method, path, body) {
        return fetch("/__happy" + path, {
            method: method,
            headers: body === undefined ? {} : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        }).then(function (response) {
            return response.json().then(function (json) {
                if (!response.ok) throw new Error(json.error || ("HTTP " + response.status));
                return json;
            });
        });
    }
    function cell(text, className) {
        var td = document.createElement("td");
        td.textContent = text;
        if (className) td.className = className;
        return td;
    }
    function time(at) { return new Date(at).toLocaleTimeString(); }
    function fail(error) { alert(error.message); }

    function render() {
        $("where").textContent = "Serving " + state.folder + " as artifact " + state.artifactId +
            " · data in " + state.scratch + " · " + state.streams + " open change streams";
        var users = $("users");
        users.textContent = "";
        var select = $("writeAs");
        var chosen = select.value;
        select.textContent = "";
        state.users.forEach(function (user) {
            var link = document.createElement("a");
            link.className = "user";
            link.href = "/?as=" + encodeURIComponent(user.name);
            link.target = "_blank";
            var img = document.createElement("img");
            img.src = user.photoUrl;
            img.alt = "";
            link.appendChild(img);
            link.appendChild(document.createTextNode(user.name));
            users.appendChild(link);
            var option = document.createElement("option");
            option.value = user.name;
            option.textContent = user.name;
            select.appendChild(option);
        });
        if (chosen) select.value = chosen;
        $("offline").className = state.faults.offline ? "on" : "";
        $("offline").textContent = state.faults.offline ? "Offline — go online" : "Go offline";
        if (document.activeElement !== $("latency")) $("latency").value = state.faults.latencyMs;
        $("failing").textContent = state.faults.failNext ? state.faults.failNext + " left" : "";
        $("dropping").textContent = state.faults.dropNext ? state.faults.dropNext + " left" : "";
    }

    function refresh() {
        return Promise.all([
            call("GET", "/state"), call("GET", "/data"), call("GET", "/logs?limit=100"), call("GET", "/requests"),
        ]).then(function (results) {
            state = results[0];
            render();
            var dump = results[1];
            var live = {};
            dump.entries.forEach(function (entry) { if (!entry.deleted) live[entry.key] = entry.value; });
            $("data").textContent = JSON.stringify(live, null, 2);
            var logs = $("logs");
            logs.textContent = "";
            results[2].entries.forEach(function (entry) {
                var row = document.createElement("tr");
                row.appendChild(cell(time(entry.at)));
                row.appendChild(cell(entry.level, entry.level));
                row.appendChild(cell(entry.source));
                row.appendChild(cell(entry.user || entry.userId));
                row.appendChild(cell(entry.message + (entry.data === null ? "" : "\n" + JSON.stringify(entry.data))));
                logs.appendChild(row);
            });
            var requests = $("requests");
            requests.textContent = "";
            results[3].requests.slice(0, 100).forEach(function (request) {
                var row = document.createElement("tr");
                row.appendChild(cell(time(request.at)));
                row.appendChild(cell(request.user));
                row.appendChild(cell(request.method + " " + request.path));
                row.appendChild(cell(request.status === null ? "" : String(request.status)));
                row.appendChild(cell(request.ms === null ? "open" : String(request.ms)));
                row.appendChild(cell(request.fault || "", request.fault ? "warn" : ""));
                requests.appendChild(row);
            });
        }).catch(function () { /* the next refresh tries again */ });
    }

    $("addUser").onclick = function () {
        var name = $("newUser").value.trim();
        if (!name) return;
        call("POST", "/users", { name: name }).then(function () {
            $("newUser").value = "";
            window.open("/?as=" + encodeURIComponent(name), "_blank");
            refresh();
        }, fail);
    };
    $("offline").onclick = function () { call("POST", "/faults", { offline: !state.faults.offline }).then(refresh, fail); };
    $("setLatency").onclick = function () { call("POST", "/faults", { latencyMs: Number($("latency").value) || 0 }).then(refresh, fail); };
    $("cut").onclick = function () { call("POST", "/streams/cut").then(refresh, fail); };
    $("fail").onclick = function () { call("POST", "/faults", { failNext: Number($("failCount").value) || 1 }).then(refresh, fail); };
    $("drop").onclick = function () { call("POST", "/faults", { dropNext: Number($("dropCount").value) || 1 }).then(refresh, fail); };
    $("write").onclick = function () {
        var value;
        try { value = JSON.parse($("writeValue").value); } catch (error) { return alert("The value must be JSON."); }
        call("POST", "/data/write", { as: $("writeAs").value, key: $("writeKey").value, value: value }).then(refresh, fail);
    };
    $("delete").onclick = function () {
        call("POST", "/data/write", { as: $("writeAs").value, key: $("writeKey").value, delete: true }).then(refresh, fail);
    };
    $("download").onclick = function () {
        call("GET", "/data").then(function (dump) {
            var link = document.createElement("a");
            link.href = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" }));
            link.download = dump.artifactId + "-data.json";
            link.click();
        }, fail);
    };
    $("load").onchange = function (event) {
        var file = event.target.files[0];
        if (!file) return;
        file.text().then(function (text) { return call("PUT", "/data", JSON.parse(text)); }).then(refresh, fail);
    };
    $("reset").onclick = function () {
        if (confirm("Forget every entry?")) call("POST", "/data/reset").then(refresh, fail);
    };
    $("clearLogs").onclick = function () { call("DELETE", "/logs").then(refresh, fail); };
    $("clearRequests").onclick = function () { call("DELETE", "/requests").then(refresh, fail); };
    refresh();
    setInterval(refresh, 2000);
})();
</script>
</body>
</html>
`;
