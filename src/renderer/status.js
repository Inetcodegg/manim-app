/* Plain script (no bundler) for the tiny status window — kept dependency-free
   on purpose since this is a diagnostic view, not part of the render path.
   Every DOM lookup is guarded because a missing element should never throw
   and take the whole polling loop down with it. */
(function () {
  function setCheck(name, ok) {
    var icon = document.getElementById("icon-" + name);
    var value = document.getElementById("value-" + name);
    if (icon) {
      icon.className = "check-icon " + (ok ? "ok" : "bad");
      icon.textContent = ok ? "✓" : "✕";
    }
    if (value) {
      value.textContent = ok ? "Working" : "Not working";
      value.className = "check-value " + (ok ? "ok" : "bad");
    }
  }

  function setPill(ready) {
    var pill = document.getElementById("pill");
    var text = document.getElementById("pill-text");
    if (!pill || !text) return;
    pill.className = "pill " + (ready ? "ok" : "bad");
    text.textContent = ready ? "Ready" : "Needs attention";
  }

  async function refresh() {
    try {
      var status = await window.agentStatus.get();
      var portEl = document.getElementById("port-info");
      if (portEl) portEl.textContent = "wss://127.0.0.1:" + status.port;

      setCheck("python", status.runtime.python);
      setCheck("latex", status.runtime.latex);
      setCheck("ffmpeg", status.runtime.ffmpeg);
      setPill(status.runtime.ready);

      var hint = document.getElementById("hint");
      if (hint) {
        if (!status.runtime.ready && status.runtime.detail && status.runtime.detail.length) {
          hint.style.display = "block";
          hint.textContent = status.runtime.detail.join(" ");
        } else {
          hint.style.display = "none";
        }
      }
    } catch (err) {
      // the status window failing to refresh should never crash it — just
      // leave the last-known values on screen and try again next tick
      console.error("status refresh failed", err);
    }

    try {
      var log = await window.agentStatus.tailLog();
      var logEl = document.getElementById("log");
      if (logEl) {
        var atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
        logEl.textContent = log || "No activity yet.";
        if (atBottom) logEl.scrollTop = logEl.scrollHeight;
      }
    } catch (err) {
      console.error("log tail failed", err);
    }
  }

  refresh();
  setInterval(refresh, 4000);
})();
