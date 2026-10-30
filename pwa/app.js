/* Tamiz de Procesamiento Numérico (TPN) — PWA para tableta.
   Prototipo de investigación para validación con USAER y psicólogos.
   No diagnostica: identifica niñas y niños que requieren evaluación especializada. */
(function () {
  "use strict";

  const APP_VERSION = "0.9.0";
  const BANCO = window.BANCO_ITEMS;
  const P = window.Puntuacion;
  const $app = document.getElementById("app");

  const GRADOS = { "5P": "5.º de primaria", "6P": "6.º de primaria", "1S": "1.º de secundaria", "2S": "2.º de secundaria", "3S": "3.º de secundaria" };

  // ------------------------------------------------------------------ almacenamiento
  const DB = (() => {
    let dbp = null;
    function abrir() {
      if (dbp) return dbp;
      dbp = new Promise((ok, mal) => {
        const r = indexedDB.open("tamiz-tpn", 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          db.createObjectStore("sesiones", { keyPath: "id" });
          const e = db.createObjectStore("ensayos", { keyPath: "uid" });
          e.createIndex("sesion", "sesion_id");
        };
        r.onsuccess = () => ok(r.result);
        r.onerror = () => mal(r.error);
      });
      return dbp;
    }
    async function tx(store, modo, fn) {
      const db = await abrir();
      return new Promise((ok, mal) => {
        const t = db.transaction(store, modo);
        const s = t.objectStore(store);
        const res = fn(s);
        t.oncomplete = () => ok(res && res.result !== undefined ? res.result : res);
        t.onerror = () => mal(t.error);
      });
    }
    return {
      guardarSesion: (s) => tx("sesiones", "readwrite", (st) => st.put(s)),
      guardarEnsayos: (arr) => tx("ensayos", "readwrite", (st) => { arr.forEach((e) => st.put(e)); }),
      sesiones: () => tx("sesiones", "readonly", (st) => st.getAll()),
      sesion: (id) => tx("sesiones", "readonly", (st) => st.get(id)),
      ensayosDe: (id) => tx("ensayos", "readonly", (st) => st.index("sesion").getAll(id)),
      todosEnsayos: () => tx("ensayos", "readonly", (st) => st.getAll()),
      borrarSesion: async (id) => {
        const ens = await DB.ensayosDe(id);
        await tx("ensayos", "readwrite", (st) => { ens.forEach((e) => st.delete(e.uid)); });
        await tx("sesiones", "readwrite", (st) => st.delete(id));
      },
      borrarTodo: async () => {
        await tx("ensayos", "readwrite", (st) => st.clear());
        await tx("sesiones", "readwrite", (st) => st.clear());
      }
    };
  })();

  const Config = {
    get(k, d) { try { const v = localStorage.getItem("tpn_" + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("tpn_" + k, JSON.stringify(v)); } catch (e) { alert("No se pudo guardar la configuración."); } }
  };

  // ------------------------------------------------------------------ utilidades
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const dosFrames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))));
  const hoyISO = () => new Date().toISOString().slice(0, 10);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const fmt = (v, d = 2) => (typeof v === "number" && isFinite(v) ? (Number.isInteger(v) || Math.abs(v) >= 100 ? Math.round(v).toLocaleString("es-MX") : v.toFixed(d)) : "—");
  function edadMeses(nac, fecha) {
    if (!nac || !fecha) return null;
    const a = new Date(nac + "T12:00:00"), b = new Date(fecha + "T12:00:00");
    let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    if (b.getDate() < a.getDate()) m -= 1;
    return m;
  }
  async function hashPIN(pin) {
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tpn:" + pin));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    let h = 5381; for (const c of "tpn:" + pin) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return "d" + h;
  }
  function descargar(nombre, contenido, tipo) {
    const blob = new Blob([contenido], { type: tipo });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function aCSV(filas) {
    if (!filas.length) return "";
    const cols = [...filas.reduce((s, f) => { Object.keys(f).forEach((k) => s.add(k)); return s; }, new Set())];
    const celda = (v) => {
      if (v === null || v === undefined) return "";
      if (typeof v === "object") v = JSON.stringify(v);
      v = String(v);
      return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    return "﻿" + cols.join(",") + "\n" + filas.map((f) => cols.map((c) => celda(f[c])).join(",")).join("\n");
  }

  // Voz para las consignas (reduce la carga de lectura)
  const Voz = {
    voz: null,
    iniciar() {
      if (!("speechSynthesis" in window)) return;
      const elegir = () => {
        const vs = speechSynthesis.getVoices();
        this.voz = vs.find((v) => v.lang === "es-MX") || vs.find((v) => v.lang === "es-US") || vs.find((v) => v.lang && v.lang.startsWith("es")) || null;
      };
      elegir(); speechSynthesis.onvoiceschanged = elegir;
    },
    decir(t) {
      if (!("speechSynthesis" in window) || !Config.get("voz", true)) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(t);
      u.lang = this.voz ? this.voz.lang : "es-MX"; if (this.voz) u.voice = this.voz; u.rate = 0.92;
      speechSynthesis.speak(u);
    },
    callar() { if ("speechSynthesis" in window) speechSynthesis.cancel(); }
  };

  // ------------------------------------------------------------------ definición de tareas
  const TAREAS = [
    { clave: "tr_simple", titulo: "Rapidez",
      instr: "Vas a ver un círculo naranja. Cuando aparezca, toca la pantalla lo más rápido que puedas. Espera a que aparezca: no toques antes.", minPractica: 0 },
    { clave: "enumeracion", titulo: "Puntos y números",
      instr: "Vas a ver puntos de un lado y un número del otro. Si la cantidad de puntos es igual al número, toca SÍ. Si no es igual, toca NO. Responde rápido, pero sin equivocarte.", minPractica: 0.5 },
    { clave: "comparacion_simbolica", titulo: "¿Cuál vale más?",
      instr: "Vas a ver dos números. Toca el número que vale MÁS. No importa si está escrito grande o chico: importa cuánto vale.", minPractica: 0.5 },
    { clave: "comparacion_no_simbolica", titulo: "¿Dónde hay más?",
      instr: "Vas a ver dos grupos de puntos por muy poco tiempo. No te dará tiempo de contarlos. Toca el lado donde creas que hay MÁS puntos.", minPractica: 0.5 },
    { clave: "linea_numerica", titulo: "La línea de números",
      instr: "Vas a ver una línea con un número en cada punta. Toca en la línea el lugar donde crees que va el número de arriba. Puedes moverlo. Cuando estés seguro, toca LISTO.", minPractica: 0 },
    { clave: "verificacion_aritmetica", titulo: "¿Está bien o mal?",
      instr: "Vas a ver operaciones con su resultado. Si el resultado es correcto, toca la palomita. Si está mal, toca el tache. Responde rápido, pero sin equivocarte.", minPractica: 0.5 },
    { clave: "fluidez", titulo: "Operaciones rápidas",
      instr: "Resuelve todas las operaciones que puedas en dos minutos. Escribe la respuesta con los números y toca ENVIAR. Si una no la sabes, toca PASAR y sigue con la próxima.", minPractica: 0 }
  ];
  const DURACION_FLUIDEZ_MS = 120000;

  // ------------------------------------------------------------------ control de la aplicación
  const Ctrl = { cancelar: null, menuAbierto: false, sesion: null, ensayosTarea: [] };

  function escenario(contenido) {
    $app.innerHTML = `<div class="escenario" id="esc">${contenido}<div class="esquina-aplicador" id="esquina" aria-label="Menú del aplicador (mantener presionado)"></div></div>`;
    activarEsquina();
    return document.getElementById("esc");
  }
  function zona(html) { // cambia sólo el contenido central, conservando la esquina
    const esc$ = document.getElementById("esc");
    const esquina = document.getElementById("esquina");
    esc$.innerHTML = html; esc$.appendChild(esquina);
    return esc$;
  }
  function activarEsquina() {
    const e = document.getElementById("esquina"); if (!e) return;
    let t = null;
    e.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); t = setTimeout(abrirMenuAplicador, 1500); });
    ["pointerup", "pointerleave", "pointercancel"].forEach((n) => e.addEventListener(n, () => clearTimeout(t)));
  }
  function abrirMenuAplicador() {
    if (Ctrl.menuAbierto) return;
    Ctrl.menuAbierto = true;
    if (Ctrl.cancelar) Ctrl.cancelar("menu");
    const m = document.createElement("div");
    m.className = "modal-fondo";
    m.innerHTML = `<div class="modal"><h2>Menú del aplicador</h2>
      <p class="tenue">El ensayo en curso se repetirá al reanudar.</p>
      <div class="acciones" style="flex-direction:column">
        <button data-a="reanudar">Reanudar</button>
        <button class="secundario" data-a="omitir">Omitir esta tarea</button>
        <button class="peligro" data-a="terminar">Terminar la sesión</button></div></div>`;
    document.body.appendChild(m);
    return new Promise((ok) => {
      m.addEventListener("click", (ev) => {
        const a = ev.target.dataset.a; if (!a) return;
        if (a === "terminar" && !confirm("¿Terminar la sesión? Se guardará como incompleta.")) return;
        m.remove(); Ctrl.menuAbierto = false;
        Ctrl.accion = a === "reanudar" ? null : a;
        ok(a);
      });
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && Ctrl.sesion && Ctrl.sesion.en_curso) {
      Ctrl.sesion.interrupciones = (Ctrl.sesion.interrupciones || 0) + 1;
      if (Ctrl.cancelar) Ctrl.cancelar("interrupcion");
    }
  });

  /* Espera una respuesta táctil. opciones: [{el, valor}]. Devuelve {valor, rt, timeout} o {cancelado}. */
  function esperarRespuesta(opciones, t0, timeoutMs) {
    return new Promise((ok) => {
      let hecho = false, to = null;
      const limpiar = () => { hecho = true; clearTimeout(to); opciones.forEach((o) => o.el.removeEventListener("pointerdown", o.h)); Ctrl.cancelar = null; };
      if (Ctrl.menuAbierto || Ctrl.accion) { ok({ cancelado: "menu" }); return; }
      opciones.forEach((o) => {
        o.h = (ev) => {
          if (hecho) return; ev.preventDefault();
          if (o.valido && !o.valido()) return;
          const ts = ev.timeStamp && ev.timeStamp > t0 - 5 && ev.timeStamp < performance.now() + 5 ? ev.timeStamp : performance.now();
          limpiar(); ok({ valor: o.valor, rt: Math.round(ts - t0) });
        };
        o.el.addEventListener("pointerdown", o.h);
      });
      if (timeoutMs) to = setTimeout(() => { if (!hecho) { limpiar(); ok({ valor: null, rt: null, timeout: true }); } }, timeoutMs);
      Ctrl.cancelar = (motivo) => { if (!hecho) { limpiar(); ok({ cancelado: motivo }); } };
    });
  }
  async function trasCancelacion() {
    // espera a que el aplicador cierre el menú (o a que la app vuelva a primer plano)
    while (Ctrl.menuAbierto || document.hidden) await esperar(200);
    return Ctrl.accion; // null = reanudar
  }
  async function retro(bien) {
    const d = document.createElement("div");
    d.className = "retro " + (bien ? "bien" : "mal"); d.textContent = bien ? "✓" : "✗";
    document.getElementById("esc").appendChild(d);
    await esperar(650); d.remove();
  }
  async function fijacion(ms = 500) { zona(`<div class="zona-estimulo"><span class="fijacion">+</span></div>`); await esperar(ms); }

  function svgPuntos(puntos, extra = "") {
    return `<svg viewBox="0 0 1 1" preserveAspectRatio="xMidYMid meet" ${extra}>${puntos.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="var(--punto)"/>`).join("")}</svg>`;
  }

  // ------------------------------------------------------------------ presentadores por tarea
  // Cada presentador devuelve un objeto de ensayo o {reintentar:true} / {accion}.
  const Presentar = {
    async tr_simple(it) {
      zona(`<div class="zona-estimulo" id="z"><span class="tenue" style="font-size:1.3rem">Toca cuando aparezca el círculo</span></div>`);
      const z = document.getElementById("z");
      let anticipada = false;
      const ant = () => { anticipada = true; };
      z.addEventListener("pointerdown", ant);
      // durante el intervalo: detectar toques anticipados o cancelaciones
      const fin = performance.now() + it.isi;
      let cancel = null;
      Ctrl.cancelar = (m) => { cancel = m; };
      while (performance.now() < fin && !cancel) await esperar(20);
      Ctrl.cancelar = null;
      z.removeEventListener("pointerdown", ant);
      if (cancel) return { reintentar: true };
      zona(`<div class="zona-estimulo" id="z"><div class="circulo-trs"></div></div>`);
      const t0 = await dosFrames();
      const r = await esperarRespuesta([{ el: document.getElementById("z"), valor: "toque" }], t0, 3000);
      if (r.cancelado) return { reintentar: true };
      return { rt_ms: r.rt, timeout: !!r.timeout, anticipada, acierto: !r.timeout && !anticipada, isi: it.isi };
    },

    async enumeracion(it, practica) {
      await fijacion();
      zona(`<div class="zona-estimulo">
          <div class="panel cuadro">${svgPuntos(it.puntos)}</div>
          <div class="panel cuadro"><span class="digito">${it.digito}</span></div></div>
        <div class="zona-respuesta"><button class="btn-resp si" id="bs">SÍ</button><button class="btn-resp no" id="bn">NO</button></div>`);
      const t0 = await dosFrames();
      const r = await esperarRespuesta([{ el: document.getElementById("bs"), valor: "si" }, { el: document.getElementById("bn"), valor: "no" }], t0, 8000);
      if (r.cancelado) return { reintentar: true };
      const acierto = r.valor === it.correcta;
      if (practica) await retro(acierto);
      return { respuesta: r.valor, rt_ms: r.rt, timeout: !!r.timeout, acierto, n: it.n, digito: it.digito, rango: it.rango || "" };
    },

    async comparacion_simbolica(it, practica) {
      await fijacion();
      const grande = it.tipo === "2d" ? "min(16vw,26vh)" : "min(20vw,32vh)";
      const chico = it.tipo === "2d" ? "min(16vw,26vh)" : "min(10vw,16vh)";
      const medio = it.tipo === "2d" ? "min(16vw,26vh)" : "min(15vw,24vh)";
      const mayorIzq = it.izq > it.der;
      let fi = medio, fd = medio;
      if (it.condicion === "congruente") { fi = mayorIzq ? grande : chico; fd = mayorIzq ? chico : grande; }
      if (it.condicion === "incongruente") { fi = mayorIzq ? chico : grande; fd = mayorIzq ? grande : chico; }
      zona(`<div class="zona-estimulo">
          <div class="panel cuadro tocable" id="pi"><span class="numero" style="font-size:${fi}">${it.izq}</span></div>
          <div class="panel cuadro tocable" id="pd"><span class="numero" style="font-size:${fd}">${it.der}</span></div></div>`);
      const t0 = await dosFrames();
      const r = await esperarRespuesta([{ el: document.getElementById("pi"), valor: "izq" }, { el: document.getElementById("pd"), valor: "der" }], t0, 6000);
      if (r.cancelado) return { reintentar: true };
      const acierto = r.valor === it.correcta;
      if (practica) await retro(acierto);
      return { respuesta: r.valor, rt_ms: r.rt, timeout: !!r.timeout, acierto, izq: it.izq, der: it.der, condicion: it.condicion, tipo: it.tipo, distancia: it.distancia ?? Math.abs(it.izq - it.der) };
    },

    async comparacion_no_simbolica(it, practica) {
      await fijacion();
      zona(`<div class="zona-estimulo">
          <div class="panel cuadro tocable" id="pi">${svgPuntos(it.puntos_izq)}</div>
          <div class="panel cuadro tocable" id="pd">${svgPuntos(it.puntos_der)}</div></div>`);
      const t0 = await dosFrames();
      const pi = document.getElementById("pi"), pd = document.getElementById("pd");
      const exposicion = Config.get("exposicion_sna", 1000);
      const ocultar = setTimeout(() => { pi.innerHTML = `<div class="mascara"></div>`; pd.innerHTML = `<div class="mascara"></div>`; }, exposicion);
      const r = await esperarRespuesta([{ el: pi, valor: "izq" }, { el: pd, valor: "der" }], t0, 6000);
      clearTimeout(ocultar);
      if (r.cancelado) return { reintentar: true };
      const acierto = r.valor === it.correcta;
      if (practica) await retro(acierto);
      return { respuesta: r.valor, rt_ms: r.rt, timeout: !!r.timeout, acierto, n_izq: it.n_izq, n_der: it.n_der, razon: it.razon, control_area: it.control_area, exposicion_ms: exposicion };
    },

    async linea_numerica(it, practica) {
      const fin = it.escala === 1 ? "1" : String(it.escala);
      zona(`<div class="zona-estimulo"><div class="ln-cont">
          <div class="ln-objetivo">${esc(it.etiqueta)}</div>
          <div class="ln-linea" id="ln"><div class="eje"></div><div class="tope" style="left:0"></div><div class="tope" style="right:0"></div>
            <span class="rot" style="left:0">0</span><span class="rot" style="left:100%">${fin}</span>
            <div class="marca-ln" id="mk"></div><div class="marca-ln" id="ok" style="background:var(--ok)"></div></div>
          <button class="ln-listo" id="listo" disabled>LISTO</button></div></div>`);
      const ln = document.getElementById("ln"), mk = document.getElementById("mk"), listo = document.getElementById("listo");
      const t0 = await dosFrames();
      let frac = null, movimientos = 0, arrastrando = false;
      const poner = (ev) => {
        const r = ln.getBoundingClientRect();
        frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        mk.style.left = (frac * 100) + "%"; mk.style.display = "block"; listo.disabled = false;
      };
      ln.addEventListener("pointerdown", (ev) => { arrastrando = true; movimientos++; poner(ev); try { ln.setPointerCapture(ev.pointerId); } catch (e) { /* sin captura */ } });
      ln.addEventListener("pointermove", (ev) => { if (arrastrando) poner(ev); });
      ln.addEventListener("pointerup", () => { arrastrando = false; });
      const r = await esperarRespuesta([{ el: listo, valor: "listo", valido: () => frac !== null }], t0, 0);
      if (r.cancelado) return { reintentar: true };
      const estimacion = Math.round(frac * it.escala * (it.escala === 1 ? 1000 : 1)) / (it.escala === 1 ? 1000 : 1);
      if (practica) {
        const ok = document.getElementById("ok"); ok.style.left = (it.objetivo / it.escala * 100) + "%"; ok.style.display = "block";
        await esperar(1300);
      }
      return { estimacion, objetivo: it.objetivo, escala: it.escala, bloque: it.bloque, etiqueta: it.etiqueta, rt_ms: r.rt,
        error_abs_pct: Math.round(Math.abs(estimacion - it.objetivo) / it.escala * 10000) / 100, toques: movimientos, acierto: null };
    },

    async verificacion_aritmetica(it, practica) {
      await fijacion();
      const s = it.op === "+" ? "+" : "×";
      zona(`<div class="zona-estimulo"><div class="panel" style="padding:4vh 6vw"><span class="operacion">${it.a} ${s} ${it.b} = ${it.mostrado}</span></div></div>
        <div class="zona-respuesta"><button class="btn-resp si" id="bs" aria-label="Correcto">✓</button><button class="btn-resp no" id="bn" aria-label="Incorrecto">✗</button></div>`);
      const t0 = await dosFrames();
      const r = await esperarRespuesta([{ el: document.getElementById("bs"), valor: "si" }, { el: document.getElementById("bn"), valor: "no" }], t0, 10000);
      if (r.cancelado) return { reintentar: true };
      const acierto = r.valor === it.correcta;
      if (practica) await retro(acierto);
      return { respuesta: r.valor, rt_ms: r.rt, timeout: !!r.timeout, acierto, op: it.op, a: it.a, b: it.b, mostrado: it.mostrado, bloque: it.bloque, tipo_distractor: it.tipo_distractor };
    }
  };

  // Fluidez: bloque cronometrado con teclado en pantalla
  async function correrFluidez(items, practica, registrar) {
    const limite = practica ? null : performance.now() + DURACION_FLUIDEZ_MS;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (Ctrl.accion) return Ctrl.accion;
      if (limite && performance.now() >= limite) break;
      const s = { "+": "+", "-": "−", "x": "×", "÷": "÷" }[it.op];
      zona(`${limite ? `<div class="reloj" id="reloj"></div>` : ""}
        <div class="zona-estimulo"><div class="flu-cont">
          <div class="panel" style="padding:4vh 4vw"><span class="operacion">${it.a} ${s} ${it.b} = <span class="flu-resp" id="resp">&nbsp;</span></span></div>
          <div class="teclado" id="tec">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join("")}
            <button class="borrar" data-k="borrar" aria-label="Borrar">⌫</button><button data-k="0">0</button>
            <button class="enviar" data-k="enviar">ENVIAR</button></div></div></div>
        <div class="zona-respuesta"><button class="secundario" data-k="pasar" id="pasar" style="font-size:1.3rem;min-width:200px">PASAR →</button></div>`);
      const t0 = await dosFrames();
      let txt = "", res = null;
      const $resp = document.getElementById("resp"), $reloj = document.getElementById("reloj");
      const reloj = limite ? setInterval(() => { const q = Math.max(0, Math.ceil((limite - performance.now()) / 1000)); if ($reloj) $reloj.textContent = `Tiempo: ${Math.floor(q / 60)}:${String(q % 60).padStart(2, "0")}`; }, 250) : null;
      res = await new Promise((ok) => {
        let hecho = false, to = null;
        const terminar = (v) => { if (hecho) return; hecho = true; clearTimeout(to); Ctrl.cancelar = null; document.getElementById("esc").removeEventListener("pointerdown", h); ok(v); };
        const h = (ev) => {
          const k = ev.target.closest("[data-k]"); if (!k) return; ev.preventDefault();
          const key = k.dataset.k;
          if (/^\d$/.test(key) && txt.length < 3) txt += key;
          else if (key === "borrar") txt = txt.slice(0, -1);
          else if (key === "enviar" && txt) return terminar({ tipo: "enviar", rt: Math.round(performance.now() - t0) });
          else if (key === "pasar") return terminar({ tipo: "pasar", rt: Math.round(performance.now() - t0) });
          $resp.innerHTML = txt || "&nbsp;";
        };
        document.getElementById("esc").addEventListener("pointerdown", h);
        if (limite) to = setTimeout(() => terminar({ tipo: "tiempo" }), Math.max(0, limite - performance.now()));
        Ctrl.cancelar = (m) => terminar({ tipo: "cancelado", motivo: m });
      });
      clearInterval(reloj);
      if (res.tipo === "cancelado") {
        const accion = await trasCancelacion();
        if (accion) return accion;
        i--; continue; // repetir el mismo ítem; el tiempo del bloque se detiene sólo de forma aproximada
      }
      const valor = txt ? parseInt(txt, 10) : null;
      const e = { item_id: it.id, practica, op: it.op, a: it.a, b: it.b, correcta_valor: it.correcta, respuesta: valor,
        rt_ms: res.rt ?? null, saltado: res.tipo === "pasar", sin_respuesta: res.tipo === "tiempo",
        acierto: res.tipo === "enviar" ? valor === it.correcta : false };
      registrar(e);
      if (practica && res.tipo !== "tiempo") await retro(e.acierto);
      if (res.tipo === "tiempo") break;
    }
    return null;
  }

  // ------------------------------------------------------------------ flujo de la sesión
  async function pantallaNino(titulo, texto, boton, conVoz = true) {
    zona(`<div class="instr"><h2>${esc(titulo)}</h2><p>${esc(texto)}</p>
      <div class="botones">${conVoz && "speechSynthesis" in window ? `<button class="secundario" id="voz">🔊 Escuchar</button>` : ""}
      <button id="seguir">${esc(boton)}</button></div></div>`);
    const v = document.getElementById("voz");
    if (v) v.addEventListener("click", () => Voz.decir(texto));
    if (conVoz) Voz.decir(texto);
    await new Promise((ok) => document.getElementById("seguir").addEventListener("click", ok, { once: true }));
    Voz.callar();
  }

  async function correrBloque(tarea, items, practica) {
    const registros = [];
    const registrar = (e) => {
      const base = { uid: uid(), sesion_id: Ctrl.sesion.id, folio: Ctrl.sesion.folio, grado: Ctrl.sesion.grado,
        tarea: tarea.clave, practica, orden: Ctrl.ordenGlobal++, marca_tiempo: new Date().toISOString() };
      registros.push(Object.assign(base, { item_id: e.item_id }, e));
    };
    if (tarea.clave === "fluidez") {
      const accion = await correrFluidez(items, practica, registrar);
      return { registros, accion };
    }
    let bloqueActual = null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (Ctrl.accion) return { registros, accion: Ctrl.accion };
      if (tarea.clave === "linea_numerica" && !practica && it.bloque !== bloqueActual) {
        bloqueActual = it.bloque;
        const txt = it.bloque === "0-100" ? "Ahora la línea va de 0 a 100." : it.bloque === "0-1000" ? "Ahora la línea va de 0 a 1000. ¡Fíjate bien en el número de la punta!" : "Ahora la línea va de 0 a 1 y vas a ubicar fracciones.";
        await pantallaNino("La línea de números", txt, "¡Listo!");
      }
      const r = await Presentar[tarea.clave](it, practica);
      if (r.reintentar) {
        const accion = await trasCancelacion();
        if (accion) return { registros, accion };
        i--; continue;
      }
      registrar(Object.assign({ item_id: it.id }, r));
    }
    return { registros, accion: null };
  }

  async function correrSesion(sesion) {
    Ctrl.sesion = sesion; Ctrl.ordenGlobal = 0; Ctrl.accion = null;
    sesion.en_curso = true; sesion.inicio = new Date().toISOString();
    sesion.interrupciones = 0; sesion.practicas_repetidas = []; sesion.tareas_omitidas = []; sesion.tareas_completas = [];
    await DB.guardarSesion(sesion);
    try { await document.documentElement.requestFullscreen?.(); } catch (e) { /* opcional */ }
    let wake = null; try { wake = await navigator.wakeLock?.request("screen"); } catch (e) { /* opcional */ }

    escenario("");
    await pantallaNino("¡Hola!", "Vamos a hacer unos juegos con números. Algunos son rápidos. No es un examen y no lleva calificación. Haz tu mejor esfuerzo.", "Empezar");

    for (const tarea of TAREAS) {
      Ctrl.accion = null;
      const items = BANCO.tareas[tarea.clave];
      const prac = items.filter((i) => i.practica), test = items.filter((i) => !i.practica);
      await pantallaNino(tarea.titulo, tarea.instr, "Practicar");
      let res = await correrBloque(tarea, prac, true);
      if (!res.accion && tarea.minPractica > 0) {
        const acc = res.registros.filter((e) => e.acierto).length / Math.max(1, res.registros.length);
        if (acc < tarea.minPractica) {
          sesion.practicas_repetidas.push(tarea.clave);
          await DB.guardarEnsayos(res.registros);
          await pantallaNino(tarea.titulo, "Vamos a practicar otra vez. " + tarea.instr, "Practicar");
          res = await correrBloque(tarea, prac, true);
        }
      }
      await DB.guardarEnsayos(res.registros);
      if (res.accion === "terminar") { sesion.abortada = true; break; }
      if (res.accion === "omitir") { sesion.tareas_omitidas.push(tarea.clave); continue; }
      await pantallaNino(tarea.titulo, "¡Muy bien! Ahora va en serio: ya no te diré si está bien o mal.", "Comenzar");
      res = await correrBloque(tarea, test, false);
      await DB.guardarEnsayos(res.registros);
      if (res.accion === "terminar") { sesion.abortada = true; break; }
      if (res.accion === "omitir") { sesion.tareas_omitidas.push(tarea.clave); continue; }
      sesion.tareas_completas.push(tarea.clave);
      await DB.guardarSesion(sesion);
      if (tarea !== TAREAS[TAREAS.length - 1]) await pantallaNino("¡Muy bien!", "Descansa un momento. Cuando estés listo, seguimos.", "Seguir", false);
    }
    sesion.en_curso = false; sesion.fin = new Date().toISOString();
    sesion.duracion_min = Math.round((new Date(sesion.fin) - new Date(sesion.inicio)) / 6000) / 10;
    await DB.guardarSesion(sesion);
    try { wake && wake.release(); } catch (e) { /* nada */ }
    zona(`<div class="instr"><h2>¡Terminaste!</h2><p>Muchas gracias por tu esfuerzo. Entrega la tableta a quien te la dio.</p>
      <div class="botones"><button id="seguir" class="secundario">Soy el aplicador</button></div></div>`);
    Voz.decir("¡Terminaste! Muchas gracias por tu esfuerzo. Entrega la tableta a quien te la dio.");
    await new Promise((ok) => document.getElementById("seguir").addEventListener("click", ok, { once: true }));
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch (e) { /* nada */ }
    Ctrl.sesion = null;
    await pedirPIN(() => pantallaObservaciones(sesion));
  }

  // ------------------------------------------------------------------ pantallas del aplicador
  function marco(contenido, volver = true) {
    $app.innerHTML = `<div class="pantalla">
      <div class="barra"><div class="marca"><img src="icons/icon-192.png" alt=""><div><strong>Tamiz de Procesamiento Numérico</strong><br><small>v${APP_VERSION} · banco ${BANCO.version}</small></div></div>
      <div class="espacio"></div>${volver ? `<button class="fantasma no-imprimir" id="inicio">Inicio</button>` : ""}</div>
      <div class="aviso-prototipo"><strong>Prototipo en validación.</strong> Este tamiz no diagnostica discalculia. Sus resultados sólo indican si conviene una evaluación especializada y no deben usarse para decisiones sobre el alumno hasta concluir la validación local.</div>
      ${contenido}</div>`;
    const b = document.getElementById("inicio"); if (b) b.addEventListener("click", pantallaInicio);
    window.scrollTo(0, 0);
  }

  async function pedirPIN(siguiente) {
    const h = Config.get("pin_hash", null);
    if (!h) return siguiente();
    marco(`<div class="tarjeta" style="max-width:420px;margin:auto"><h2>PIN del aplicador</h2>
      <input type="password" inputmode="numeric" id="pin" autocomplete="off" placeholder="PIN">
      <p class="ayuda" id="err"></p><div class="acciones"><button id="ok">Entrar</button></div></div>`, false);
    const go = async () => {
      if (await hashPIN(document.getElementById("pin").value) === h) siguiente();
      else document.getElementById("err").textContent = "PIN incorrecto.";
    };
    document.getElementById("ok").addEventListener("click", go);
    document.getElementById("pin").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    document.getElementById("pin").focus();
  }

  function pantallaInicio() {
    const normas = Config.get("normas", null);
    marco(`<div class="menu-principal">
        <button id="nueva">Nueva aplicación<small>Registrar al alumno y comenzar el tamiz (≈ 25 min)</small></button>
        <button class="secundario" id="res">Resultados<small>Consultar reportes y exportar datos</small></button>
        <button class="secundario" id="conf">Configuración<small>Normas, PIN, tableta, respaldo</small></button>
        <button class="fantasma" id="acerca">Acerca del tamiz<small>Qué mide y cómo se interpreta</small></button></div>
      <div class="tarjeta" style="margin-top:16px"><h3>Estado</h3>
        <p>Normas locales: ${normas ? `<span class="etiqueta ${normas.estado === "definitiva" ? "e-ok" : "e-aviso"}">${esc(normas.estado || "cargadas")}</span> ${esc(normas.fuente || "")}` : `<span class="etiqueta e-neutro">sin normas</span> — los resultados serán descriptivos.`}</p>
        <p>Tableta: <strong>${esc(Config.get("tableta_id", "sin identificar"))}</strong> · PIN: ${Config.get("pin_hash", null) ? "activo" : "<span class='etiqueta e-aviso'>no configurado</span>"}</p></div>`, false);
    document.getElementById("nueva").addEventListener("click", () => pedirPIN(pantallaRegistro));
    document.getElementById("res").addEventListener("click", () => pedirPIN(pantallaResultados));
    document.getElementById("conf").addEventListener("click", () => pedirPIN(pantallaConfig));
    document.getElementById("acerca").addEventListener("click", pantallaAcerca);
  }

  function pantallaRegistro() {
    const ap = Config.get("ultimo_aplicador", "");
    const sel = (id, opts) => `<select id="${id}" required><option value="">Selecciona…</option>${Object.entries(opts).map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join("")}</select>`;
    marco(`<form id="f" class="tarjeta" autocomplete="off"><h2>Registro de la aplicación</h2>
      <p class="tenue">No se registra el nombre del alumno. Usa un folio y guarda la relación folio–nombre por separado, bajo resguardo de USAER.</p>
      <div class="rejilla">
        <div class="campo"><label for="aplicador">Clave del aplicador *</label><input id="aplicador" required value="${esc(ap)}"></div>
        <div class="campo"><label for="folio">Folio del alumno *</label><input id="folio" required placeholder="p. ej. MXL-USAER12-0034"></div>
        <div class="campo"><label for="cct">CCT de la escuela *</label><input id="cct" required placeholder="02DPR…"></div>
        <div class="campo"><label for="tipo_escuela">Sostenimiento *</label>${sel("tipo_escuela", { publica: "Pública", privada: "Privada" })}</div>
        <div class="campo"><label for="turno">Turno *</label>${sel("turno", { matutino: "Matutino", vespertino: "Vespertino", tiempo_completo: "Tiempo completo" })}</div>
        <div class="campo"><label for="grado">Grado *</label>${sel("grado", GRADOS)}</div>
        <div class="campo"><label for="nacimiento">Fecha de nacimiento *</label><input type="date" id="nacimiento" required></div>
        <div class="campo"><label for="sexo">Sexo *</label>${sel("sexo", { F: "Mujer", M: "Hombre", X: "Prefiere no decir" })}</div>
        <div class="campo"><label for="mano">Mano con que escribe</label>${sel("mano", { derecha: "Derecha", izquierda: "Izquierda", ambas: "Ambas" })}</div>
        <div class="campo"><label for="lengua">Lengua materna *</label>${sel("lengua", { espanol: "Español", ingles: "Inglés", indigena: "Lengua indígena", otra: "Otra" })}</div>
        <div class="campo"><label for="esc_extranjero">Años de escuela fuera de México *</label><input type="number" id="esc_extranjero" min="0" max="9" value="0" required><div class="ayuda">Importante en la frontera: alumnos de retorno.</div></div>
        <div class="campo"><label for="repeticion">¿Ha repetido algún grado? *</label>${sel("repeticion", { no: "No", si: "Sí", nose: "No se sabe" })}</div>
        <div class="campo"><label for="vision">Visión *</label>${sel("vision", { normal: "Normal", corregida: "Corregida (lentes) y los trae", no_corregida: "Dificultad no corregida" })}</div>
        <div class="campo"><label for="dx_previo">Diagnóstico previo conocido</label>${sel("dx_previo", { ninguno: "Ninguno", tdah: "TDAH", dislexia: "Dislexia", discalculia: "Discalculia", di: "Discapacidad intelectual", tea: "TEA", otro: "Otro" })}</div>
        <div class="campo"><label for="motivo">Motivo de la aplicación *</label>${sel("motivo", { universal: "Tamizaje universal (todo el grupo)", referido: "Referido por docente", validacion: "Estudio de validación" })}</div>
      </div>
      <label class="check"><input type="checkbox" id="c1" required> Cuento con el consentimiento informado firmado por madre, padre o tutor.</label>
      <label class="check"><input type="checkbox" id="c2" required> Expliqué la actividad al alumno y aceptó participar (asentimiento).</label>
      <label class="check"><input type="checkbox" id="c3" required> El alumno está en un espacio tranquilo, descansado y sin hambre evidente.</label>
      <div class="campo"><label for="obs_previas">Observaciones previas</label><textarea id="obs_previas"></textarea></div>
      <p id="aviso-edad" class="ayuda"></p>
      <div class="acciones"><button type="button" class="fantasma" id="cancelar">Cancelar</button><button type="submit">Entregar la tableta al alumno →</button></div></form>`);
    const f = document.getElementById("f");
    const nac = document.getElementById("nacimiento");
    nac.addEventListener("change", () => {
      const m = edadMeses(nac.value, hoyISO());
      document.getElementById("aviso-edad").textContent = m === null ? "" : `Edad: ${Math.floor(m / 12)} años ${m % 12} meses.` + (m < 120 || m >= 180 ? " ⚠ Fuera del rango 10–14 años para el que se diseña el tamiz." : "");
    });
    document.getElementById("cancelar").addEventListener("click", pantallaInicio);
    f.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const v = (id) => document.getElementById(id).value.trim();
      const meses = edadMeses(v("nacimiento"), hoyISO());
      if (meses !== null && (meses < 120 || meses >= 180) && !confirm("La edad está fuera del rango 10–14 años. ¿Continuar de todos modos?")) return;
      Config.set("ultimo_aplicador", v("aplicador"));
      const sesion = {
        id: uid(), folio: v("folio"), aplicador: v("aplicador"), cct: v("cct").toUpperCase(), tipo_escuela: v("tipo_escuela"), turno: v("turno"),
        grado: v("grado"), fecha: hoyISO(), nacimiento: v("nacimiento"), edad_meses: meses, sexo: v("sexo"), mano: v("mano"),
        lengua: v("lengua"), esc_extranjero: Number(v("esc_extranjero")), repeticion: v("repeticion"), vision: v("vision"),
        dx_previo: v("dx_previo"), motivo: v("motivo"), obs_previas: v("obs_previas"),
        consentimiento: true, asentimiento: true,
        tableta_id: Config.get("tableta_id", ""), dispositivo: { ua: navigator.userAgent, ancho: screen.width, alto: screen.height, dpr: devicePixelRatio },
        app_version: APP_VERSION, banco_version: BANCO.version, exposicion_sna_ms: Config.get("exposicion_sna", 1000)
      };
      correrSesion(sesion).catch((e) => { console.error(e); alert("Error durante la aplicación: " + e.message); pantallaInicio(); });
    });
  }

  function pantallaObservaciones(sesion) {
    const sel = (id, opts) => `<select id="${id}">${opts.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    marco(`<form id="f" class="tarjeta"><h2>Observaciones del aplicador</h2><p>Folio <strong>${esc(sesion.folio)}</strong> · duración ${fmt(sesion.duracion_min, 1)} min</p>
      <div class="rejilla">
        <div class="campo"><label>Esfuerzo y motivación</label>${sel("o_esfuerzo", ["Adecuado", "Variable", "Bajo"])}</div>
        <div class="campo"><label>Atención</label>${sel("o_atencion", ["Adecuada", "Variable", "Muy distraído"])}</div>
        <div class="campo"><label>Comprensión de consignas</label>${sel("o_comprension", ["Comprendió todas", "Necesitó apoyo en alguna", "No comprendió varias"])}</div>
        <div class="campo"><label>Ansiedad visible ante los números</label>${sel("o_ansiedad", ["No", "Leve", "Marcada"])}</div>
        <div class="campo"><label>Estrategias observadas</label>${sel("o_estrategia", ["Ninguna en particular", "Contó con los dedos", "Contó en voz alta", "Otra"])}</div>
        <div class="campo"><label>¿Resultado válido?</label>${sel("o_valido", ["Sí", "Dudoso", "No (no interpretar)"])}</div></div>
      <div class="campo"><label for="o_notas">Notas</label><textarea id="o_notas"></textarea></div>
      <div class="acciones"><button type="submit">Guardar y ver reporte</button></div></form>`, false);
    document.getElementById("f").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const v = (id) => document.getElementById(id).value;
      sesion.observaciones = { esfuerzo: v("o_esfuerzo"), atencion: v("o_atencion"), comprension: v("o_comprension"), ansiedad: v("o_ansiedad"), estrategia: v("o_estrategia"), valido: v("o_valido"), notas: v("o_notas") };
      await actualizarPuntuacion(sesion);
      pantallaReporte(sesion.id);
    });
  }

  async function actualizarPuntuacion(sesion) {
    const ens = await DB.ensayosDe(sesion.id);
    const I = P.calcularIndices(ens);
    const normas = Config.get("normas", null);
    const Z = P.puntuarZ(I, normas, sesion.grado);
    sesion.indices = I; sesion.z = Z; sesion.perfil = P.perfil(Z, normas);
    sesion.banderas = P.banderasCalidad(ens, sesion, I);
    sesion.normas_usadas = normas ? { fuente: normas.fuente, estado: normas.estado, fecha: normas.fecha } : null;
    await DB.guardarSesion(sesion);
    return sesion;
  }

  async function pantallaResultados() {
    const ss = (await DB.sesiones()).sort((a, b) => (b.inicio || "").localeCompare(a.inicio || ""));
    const filas = ss.map((s) => `<tr><td><strong>${esc(s.folio)}</strong><br><small>${esc(s.cct)}</small></td><td>${esc(s.fecha)}</td><td>${esc(GRADOS[s.grado] || s.grado)}</td>
      <td>${s.perfil ? `<span class="etiqueta ${({ alto: "e-alerta", medio: "e-aviso", bajo: "e-ok" })[s.perfil.nivel] || "e-neutro"}">${esc(s.perfil.titulo)}</span>` : "—"}
        ${s.abortada ? ` <span class="etiqueta e-aviso">incompleta</span>` : ""}${s.en_curso ? ` <span class="etiqueta e-aviso">interrumpida</span>` : ""}</td>
      <td><button class="secundario" data-id="${esc(s.id)}">Ver</button></td></tr>`).join("");
    marco(`<div class="tarjeta"><div class="barra"><h2 style="margin:0">Resultados (${ss.length})</h2><div class="espacio"></div>
        <button class="secundario" id="recalc">Recalcular con normas actuales</button></div>
      ${ss.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Folio</th><th>Fecha</th><th>Grado</th><th>Perfil</th><th></th></tr></thead><tbody>${filas}</tbody></table></div>` : `<p class="tenue">Aún no hay aplicaciones.</p>`}</div>
      <div class="tarjeta"><h3>Exportar para análisis</h3><p class="tenue">Los archivos contienen datos personales seudonimizados. Transfiérelos sólo por medios institucionales.</p>
        <div class="acciones" style="justify-content:flex-start">
          <button id="x-res">Resumen por alumno (CSV)</button><button id="x-ens">Ensayo por ensayo (CSV)</button><button class="secundario" id="x-json">Respaldo completo (JSON)</button></div></div>`);
    document.querySelectorAll("[data-id]").forEach((b) => b.addEventListener("click", () => pantallaReporte(b.dataset.id)));
    document.getElementById("recalc").addEventListener("click", async () => { for (const s of ss) await actualizarPuntuacion(s); pantallaResultados(); });
    const sello = Config.get("tableta_id", "tableta") + "_" + hoyISO();
    document.getElementById("x-res").addEventListener("click", async () => {
      const filas = (await DB.sesiones()).map((s) => {
        const f = Object.assign({}, s); delete f.indices; delete f.z; delete f.perfil; delete f.banderas; delete f.observaciones; delete f.dispositivo; delete f.normas_usadas;
        f.practicas_repetidas = (s.practicas_repetidas || []).join("|"); f.tareas_omitidas = (s.tareas_omitidas || []).join("|"); f.tareas_completas = (s.tareas_completas || []).join("|");
        Object.entries(s.observaciones || {}).forEach(([k, v]) => { f["obs_" + k] = v; });
        Object.entries(s.indices || {}).forEach(([k, v]) => { f[k] = v; });
        Object.entries(s.z || {}).forEach(([k, v]) => { f["z_" + k] = v; });
        if (s.perfil) { f.perfil_nivel = s.perfil.nivel; f.z_capacidad = s.perfil.z_capacidad; f.z_logro = s.perfil.z_logro; }
        f.n_banderas = (s.banderas || []).length; f.banderas = (s.banderas || []).join(" | ");
        f.disp_ua = s.dispositivo && s.dispositivo.ua; f.disp_pantalla = s.dispositivo && `${s.dispositivo.ancho}x${s.dispositivo.alto}@${s.dispositivo.dpr}`;
        return f;
      });
      descargar(`tpn_resumen_${sello}.csv`, aCSV(filas), "text/csv;charset=utf-8");
    });
    document.getElementById("x-ens").addEventListener("click", async () => descargar(`tpn_ensayos_${sello}.csv`, aCSV(await DB.todosEnsayos()), "text/csv;charset=utf-8"));
    document.getElementById("x-json").addEventListener("click", async () => descargar(`tpn_respaldo_${sello}.json`,
      JSON.stringify({ app_version: APP_VERSION, banco_version: BANCO.version, exportado: new Date().toISOString(), sesiones: await DB.sesiones(), ensayos: await DB.todosEnsayos() }), "application/json"));
  }

  async function pantallaReporte(id) {
    let s = await DB.sesion(id);
    if (!s) return pantallaResultados();
    if (!s.indices) s = await actualizarPuntuacion(s);
    const p = s.perfil || {};
    const filaZ = (z) => {
      if (typeof z !== "number") return `<span class="tenue">—</span>`;
      const pos = Math.max(0, Math.min(100, 50 + z / 3 * 50));
      return `<div style="display:flex;gap:8px;align-items:center"><div class="barra-z"><span class="zona" style="width:${50 + (p.cortes ? p.cortes.indice : -1.5) / 3 * 50}%"></span><i style="left:${pos}%"></i></div><span>${z.toFixed(2)}</span></div>`;
    };
    const dominio = (d, t) => `<h3>${t}</h3><table><thead><tr><th>Índice</th><th style="text-align:right">Valor</th><th>z (− = peor)</th></tr></thead><tbody>
      ${P.INDICES.filter((i) => i.dominio === d).map((i) => {
        const v = s.indices[i.clave];
        const val = i.pct && typeof v === "number" ? Math.round(v * 100) + " %" : fmt(v);
        return `<tr><td>${esc(i.nombre)}${i.compuesto ? " <small class='tenue'>(compuesto)</small>" : ""}</td><td class="num">${val}</td><td>${filaZ(s.z && s.z[i.clave])}</td></tr>`;
      }).join("")}</tbody></table>`;
    marco(`<div class="tarjeta perfil ${esc(p.nivel || "")}"><h2>${esc(p.titulo || "Sin puntuar")}</h2><p>${esc(p.texto || "")}</p>
        <p><strong>Compuesto de capacidad numérica:</strong> ${typeof p.z_capacidad === "number" ? "z = " + p.z_capacidad.toFixed(2) : "—"} ·
           <strong>Compuesto de logro aritmético:</strong> ${typeof p.z_logro === "number" ? "z = " + p.z_logro.toFixed(2) : "—"}</p>
        ${p.indices_debiles && p.indices_debiles.length ? `<p><strong>Índices bajos:</strong> ${p.indices_debiles.map(esc).join("; ")}.</p>` : ""}
        <p class="tenue">Normas: ${s.normas_usadas ? esc(`${s.normas_usadas.fuente || ""} (${s.normas_usadas.estado || ""})`) : "ninguna"}. Este reporte es un tamiz y no constituye diagnóstico.</p></div>
      <div class="tarjeta"><h3>Datos de la aplicación</h3><div class="rejilla">
        <div><small>Folio</small><br><strong>${esc(s.folio)}</strong></div><div><small>Grado</small><br>${esc(GRADOS[s.grado] || s.grado)}</div>
        <div><small>Edad</small><br>${s.edad_meses != null ? Math.floor(s.edad_meses / 12) + " a " + (s.edad_meses % 12) + " m" : "—"}</div>
        <div><small>Fecha</small><br>${esc(s.fecha)}</div><div><small>Escuela</small><br>${esc(s.cct)} · ${esc(s.turno)}</div>
        <div><small>Aplicador</small><br>${esc(s.aplicador)}</div><div><small>Lengua materna</small><br>${esc(s.lengua)}</div>
        <div><small>Años de escuela fuera de México</small><br>${esc(s.esc_extranjero)}</div><div><small>Duración</small><br>${fmt(s.duracion_min, 1)} min</div></div></div>
      ${(s.banderas || []).length ? `<div class="tarjeta" style="border-left:6px solid var(--acento)"><h3>Calidad de la aplicación — revisar antes de interpretar</h3><ul>${s.banderas.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>` : ""}
      <div class="tarjeta">${dominio("control", "Control")}</div>
      <div class="tarjeta">${dominio("capacidad", "Capacidad numérica básica")}</div>
      <div class="tarjeta">${dominio("logro", "Logro aritmético")}</div>
      ${s.observaciones ? `<div class="tarjeta"><h3>Observaciones del aplicador</h3><p>Esfuerzo: ${esc(s.observaciones.esfuerzo)} · Atención: ${esc(s.observaciones.atencion)} · Comprensión: ${esc(s.observaciones.comprension)} · Ansiedad: ${esc(s.observaciones.ansiedad)} · Estrategia: ${esc(s.observaciones.estrategia)} · Válido: ${esc(s.observaciones.valido)}</p>${s.observaciones.notas ? `<p>${esc(s.observaciones.notas)}</p>` : ""}</div>` : ""}
      <div class="acciones no-imprimir"><button class="peligro" id="borrar">Eliminar esta aplicación</button><button class="secundario" id="lista">Volver a resultados</button><button id="imprimir">Imprimir / PDF</button></div>`);
    document.getElementById("imprimir").addEventListener("click", () => window.print());
    document.getElementById("lista").addEventListener("click", pantallaResultados);
    document.getElementById("borrar").addEventListener("click", async () => {
      if (confirm("¿Eliminar definitivamente esta aplicación y sus ensayos?")) { await DB.borrarSesion(s.id); pantallaResultados(); }
    });
  }

  function pantallaConfig() {
    const normas = Config.get("normas", null);
    marco(`<div class="tarjeta"><h2>Configuración</h2><div class="rejilla">
        <div class="campo"><label for="tab">Identificador de esta tableta</label><input id="tab" value="${esc(Config.get("tableta_id", ""))}" placeholder="p. ej. USAER12-TAB03"><div class="ayuda">Se guarda en cada sesión: el modelo de tableta influye en los tiempos de respuesta.</div></div>
        <div class="campo"><label for="pin">Nuevo PIN del aplicador</label><input id="pin" type="password" inputmode="numeric" placeholder="Dejar vacío para no cambiar"></div>
        <div class="campo"><label for="exp">Exposición en «¿Dónde hay más?» (ms)</label><input id="exp" type="number" min="300" max="3000" step="100" value="${Config.get("exposicion_sna", 1000)}"><div class="ayuda">No cambiar después de iniciar la normalización.</div></div>
        <div class="campo"><label class="check" style="margin-top:28px"><input type="checkbox" id="voz" ${Config.get("voz", true) ? "checked" : ""}> Leer las consignas en voz alta</label></div></div>
      <div class="acciones"><button id="guardar">Guardar</button></div></div>
      <div class="tarjeta"><h3>Normas locales</h3>
        <p>${normas ? `Cargadas: <strong>${esc(normas.fuente || "sin nombre")}</strong> · estado <span class="etiqueta e-aviso">${esc(normas.estado || "")}</span> · ${esc(normas.fecha || "")} · grados: ${Object.keys(normas.grupos || {}).join(", ")}` : "No hay normas cargadas."}</p>
        <p class="tenue">Archivo JSON generado con <code>analisis/construir_normas.py</code> a partir de la muestra normativa. Debe corresponder al banco ${BANCO.version}.</p>
        <input type="file" id="f-normas" accept="application/json,.json">
        <div class="acciones">${normas ? `<button class="fantasma" id="quitar-normas">Quitar normas</button>` : ""}</div></div>
      <div class="tarjeta"><h3>Consolidar datos de otras tabletas</h3><p class="tenue">Importa un respaldo JSON exportado desde otra tableta.</p>
        <input type="file" id="f-resp" accept="application/json,.json"></div>
      <div class="tarjeta"><h3>Zona de riesgo</h3><p>Elimina todas las aplicaciones de esta tableta. Exporta un respaldo antes.</p>
        <div class="acciones" style="justify-content:flex-start"><button class="peligro" id="borrar-todo">Eliminar todos los datos</button></div></div>`);
    document.getElementById("guardar").addEventListener("click", async () => {
      Config.set("tableta_id", document.getElementById("tab").value.trim());
      Config.set("exposicion_sna", Math.max(300, Math.min(3000, Number(document.getElementById("exp").value) || 1000)));
      Config.set("voz", document.getElementById("voz").checked);
      const pin = document.getElementById("pin").value;
      if (pin) { if (pin.length < 4) return alert("El PIN debe tener al menos 4 dígitos."); Config.set("pin_hash", await hashPIN(pin)); }
      alert("Configuración guardada."); pantallaInicio();
    });
    document.getElementById("f-normas").addEventListener("change", async (ev) => {
      try {
        const n = JSON.parse(await ev.target.files[0].text());
        if (!n.grupos) throw new Error("El archivo no tiene la sección «grupos».");
        if (n.version_banco && n.version_banco !== BANCO.version && !confirm(`Las normas son del banco ${n.version_banco} y la app usa ${BANCO.version}. ¿Cargar de todos modos?`)) return;
        Config.set("normas", n); alert("Normas cargadas. Usa «Recalcular» en Resultados para actualizar reportes previos."); pantallaConfig();
      } catch (e) { alert("No se pudo leer el archivo de normas: " + e.message); }
    });
    const q = document.getElementById("quitar-normas");
    if (q) q.addEventListener("click", () => { if (confirm("¿Quitar las normas cargadas?")) { localStorage.removeItem("tpn_normas"); pantallaConfig(); } });
    document.getElementById("f-resp").addEventListener("change", async (ev) => {
      try {
        const r = JSON.parse(await ev.target.files[0].text());
        if (!Array.isArray(r.sesiones) || !Array.isArray(r.ensayos)) throw new Error("Formato no reconocido.");
        for (const s of r.sesiones) await DB.guardarSesion(s);
        await DB.guardarEnsayos(r.ensayos);
        alert(`Importadas ${r.sesiones.length} aplicaciones.`);
      } catch (e) { alert("No se pudo importar: " + e.message); }
    });
    document.getElementById("borrar-todo").addEventListener("click", async () => {
      if (prompt("Escribe ELIMINAR para borrar todos los datos de esta tableta.") === "ELIMINAR") { await DB.borrarTodo(); alert("Datos eliminados."); pantallaInicio(); }
    });
  }

  function pantallaAcerca() {
    const n = (k) => BANCO.tareas[k].filter((i) => !i.practica).length;
    marco(`<div class="tarjeta"><h2>Qué mide el tamiz</h2>
      <p>Siete tareas breves, organizadas en dos dominios, siguiendo el modelo de déficit nuclear de número (Butterworth) y la evidencia sobre estimación en la línea numérica:</p>
      <table><thead><tr><th>Tarea</th><th>Dominio</th><th>Ítems</th></tr></thead><tbody>
        <tr><td>Rapidez (TR simple)</td><td>Control motor y atencional</td><td class="num">${n("tr_simple")}</td></tr>
        <tr><td>Puntos y números (enumeración)</td><td>Capacidad numérica</td><td class="num">${n("enumeracion")}</td></tr>
        <tr><td>¿Cuál vale más? (comparación simbólica y Stroop numérico)</td><td>Capacidad numérica</td><td class="num">${n("comparacion_simbolica")}</td></tr>
        <tr><td>¿Dónde hay más? (sistema numérico aproximado)</td><td>Capacidad numérica</td><td class="num">${n("comparacion_no_simbolica")}</td></tr>
        <tr><td>Línea de números 0–100, 0–1000 y fracciones</td><td>Capacidad / logro</td><td class="num">${n("linea_numerica")}</td></tr>
        <tr><td>¿Está bien o mal? (sumas y multiplicaciones)</td><td>Logro aritmético</td><td class="num">${n("verificacion_aritmetica")}</td></tr>
        <tr><td>Operaciones rápidas (2 min)</td><td>Logro aritmético</td><td class="num">${n("fluidez")}</td></tr></tbody></table>
      <h3 style="margin-top:18px">Cómo se interpreta</h3>
      <p>Bajo desempeño en ambos dominios es compatible con riesgo de discalculia y amerita evaluación especializada. Bajo logro con capacidad conservada sugiere otras causas (rezago escolar, atención, lectura, ansiedad). Sin normas locales, la app sólo muestra valores descriptivos.</p>
      <p class="tenue">El diagnóstico de trastorno específico del aprendizaje con dificultad en matemáticas requiere evaluación profesional completa, historia escolar y persistencia de las dificultades pese a intervención.</p></div>`);
  }

  // ------------------------------------------------------------------ arranque
  Voz.iniciar();
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!BANCO || !P) { $app.textContent = "Error: no se cargó el banco de ítems o el módulo de puntuación."; return; }
  pantallaInicio();
  window.TPN = { DB, Config, P, BANCO, APP_VERSION }; // para pruebas y depuración
})();
