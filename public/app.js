(() => {
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789••••";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function scrambleText(el) {
    const finalText = (el.getAttribute("aria-label") || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!finalText) return Promise.resolve();

    if (reduceMotion) {
      el.textContent = finalText;
      return Promise.resolve();
    }

    const delay = Number(el.dataset.scrambleDelay || 0);
    const settleMs = Number(el.dataset.scrambleStep || 28);
    const cyclesBeforeSettle = 5;
    const chars = [...finalText];
    const startAt = performance.now() + delay;

    el.classList.add("is-scrambling");
    el.setAttribute("aria-busy", "true");

    return new Promise((resolve) => {
      let frame;

      const tick = (now) => {
        if (now < startAt) {
          frame = requestAnimationFrame(tick);
          return;
        }

        const elapsed = now - startAt;
        let allDone = true;
        let output = "";

        for (let i = 0; i < chars.length; i += 1) {
          const ch = chars[i];
          if (/\s/.test(ch) || "·—-.,;:'\"!".includes(ch)) {
            output += ch;
            continue;
          }

          const charStart = i * settleMs;
          if (elapsed >= charStart + cyclesBeforeSettle * settleMs) {
            output += ch;
          } else {
            allDone = false;
            const pool = /[a-zà-ú]/.test(ch)
              ? "abcdefghijklmnopqrstuvwxyz"
              : GLYPHS;
            output += pool[(Math.random() * pool.length) | 0];
          }
        }

        el.textContent = output;

        if (allDone) {
          el.textContent = finalText;
          el.classList.remove("is-scrambling");
          el.removeAttribute("aria-busy");
          resolve();
          return;
        }

        frame = requestAnimationFrame(tick);
      };

      frame = requestAnimationFrame(tick);
      el.addEventListener(
        "click",
        () => {
          cancelAnimationFrame(frame);
          el.textContent = finalText;
          el.classList.remove("is-scrambling");
          el.removeAttribute("aria-busy");
          resolve();
        },
        { once: true }
      );
    });
  }

  const scrambleNodes = [...document.querySelectorAll("[data-scramble]")];
  if (scrambleNodes.length) {
    scrambleNodes.forEach((el) => {
      scrambleText(el);
    });
  }

  const form = document.getElementById("lead-form");
  const status = document.getElementById("form-status");
  if (!form || !status) return;

  const setStatus = (message, kind) => {
    status.hidden = !message;
    status.textContent = message || "";
    status.classList.toggle("is-ok", kind === "ok");
    status.classList.toggle("is-err", kind === "err");
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("", null);

    const data = new FormData(form);
    const payload = {
      name: String(data.get("name") || "").trim(),
      email: String(data.get("email") || "").trim(),
      phone: String(data.get("phone") || "").trim(),
      interest: String(data.get("interest") || "").trim(),
      message: String(data.get("message") || "").trim(),
      company: String(data.get("company") || "").trim(),
    };

    if (payload.name.length < 2) {
      setStatus("Informe seu nome.", "err");
      form.name.focus();
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      setStatus("Informe um e-mail válido.", "err");
      form.email.focus();
      return;
    }

    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;

    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Falha no envio.");
      }
      form.reset();
      setStatus("Mensagem enviada. Retornamos em breve.", "ok");
    } catch (err) {
      setStatus(err.message || "Não foi possível enviar. Tente novamente.", "err");
    } finally {
      if (button) button.disabled = false;
    }
  });
})();
