// Edge Magazine Admin - light progressive enhancement only. The panel is fully
// server-rendered and works without this file; it just adds sidebar-collapse
// persistence, client-side post filtering, and a submit busy-state. No external
// deps, no dialogs (delete is guarded server-side by the confirm checkbox).
(function () {
  "use strict";

  // ── Sidebar collapse (desktop). State lives in localStorage; an inline head
  //    script applies the class before paint to avoid a flash. ────────────────
  var COLLAPSE_KEY = "em_admin_side_collapsed";
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-collapse]");
    if (!t) return;
    e.preventDefault();
    var on = document.documentElement.classList.toggle("side-collapsed");
    try { localStorage.setItem(COLLAPSE_KEY, on ? "1" : "0"); } catch (_) {}
  });

  // ── Posts live search: filter table rows by the [data-search] text. ────────
  var search = document.getElementById("posts-search");
  if (search) {
    var rows = Array.prototype.slice.call(
      document.querySelectorAll("[data-post-row]")
    );
    var empty = document.getElementById("posts-empty");
    var apply = function () {
      var q = search.value.trim().toLowerCase();
      var shown = 0;
      rows.forEach(function (r) {
        var hit = !q || (r.getAttribute("data-search") || "").indexOf(q) !== -1;
        r.style.display = hit ? "" : "none";
        if (hit) shown++;
      });
      if (empty) empty.style.display = shown ? "none" : "";
    };
    search.addEventListener("input", apply);
    apply();
  }

  // ── Busy state on heavy submits (batch run): disable + relabel. ────────────
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form.hasAttribute || !form.hasAttribute("data-busy")) return;
    var btn = form.querySelector('button[type="submit"], button:not([type])');
    if (btn) {
      btn.disabled = true;
      var busy = form.getAttribute("data-busy");
      if (busy) btn.textContent = busy;
    }
  });
})();
