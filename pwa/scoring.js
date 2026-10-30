/* Puntuación del Tamiz de Procesamiento Numérico (TPN).
   Funciones puras: reciben los ensayos de una sesión y devuelven índices,
   puntuaciones z (si hay normas) y banderas de calidad.
   Se puede ejecutar en Node para pruebas: module.exports al final. */
(function (raiz) {
  "use strict";

  // dir: +1 = valores altos son mejores; -1 = valores bajos son mejores.
  // log: transformar con logaritmo natural antes de normar (índices de tiempo, sesgados).
  // compuesto: dominio al que aporta en el puntaje compuesto (capacidad | logro | null).
  const INDICES = [
    { clave: "trs_med", nombre: "Tiempo de reacción simple (mediana, ms)", dir: -1, log: true, dominio: "control" },
    { clave: "trs_anticip", nombre: "Respuestas anticipadas (TR simple)", dir: -1, dominio: "control" },
    { clave: "enu_prec", nombre: "Enumeración: precisión", dir: 1, dominio: "capacidad", pct: true },
    { clave: "enu_tr_aj", nombre: "Enumeración: TR ajustado por TR simple (ms)", dir: -1, dominio: "capacidad" },
    { clave: "enu_ies", nombre: "Enumeración: eficiencia (IES, ms)", dir: -1, log: true, dominio: "capacidad", compuesto: "capacidad" },
    { clave: "enu_pend_sub", nombre: "Enumeración: pendiente 1–4 puntos (ms/punto)", dir: -1, dominio: "capacidad" },
    { clave: "enu_pend_cont", nombre: "Enumeración: pendiente 5–9 puntos (ms/punto)", dir: -1, dominio: "capacidad" },
    { clave: "cs_prec", nombre: "Comparación simbólica 1 dígito: precisión", dir: 1, dominio: "capacidad", pct: true },
    { clave: "cs_ies", nombre: "Comparación simbólica 1 dígito: eficiencia (IES, ms)", dir: -1, log: true, dominio: "capacidad", compuesto: "capacidad" },
    { clave: "cs_efecto_congr", nombre: "Efecto Stroop numérico (ms, incongr − congr)", dir: -1, dominio: "capacidad" },
    { clave: "cs_efecto_dist", nombre: "Efecto de distancia (ms, cercanos − lejanos)", dir: -1, dominio: "capacidad" },
    { clave: "cs2_prec", nombre: "Comparación de 2 dígitos: precisión", dir: 1, dominio: "capacidad", pct: true },
    { clave: "ans_prec", nombre: "Comparación de cantidades (SNA): precisión", dir: 1, dominio: "capacidad", pct: true, compuesto: "capacidad" },
    { clave: "ans_prec_incongr", nombre: "SNA: precisión con área incongruente", dir: 1, dominio: "capacidad", pct: true },
    { clave: "ans_w", nombre: "SNA: fracción de Weber estimada", dir: -1, dominio: "capacidad" },
    { clave: "ln100_pae", nombre: "Línea 0–100: error absoluto (%)", dir: -1, dominio: "capacidad", compuesto: "capacidad" },
    { clave: "ln1000_pae", nombre: "Línea 0–1000: error absoluto (%)", dir: -1, dominio: "capacidad", compuesto: "capacidad" },
    { clave: "ln1000_r2lin", nombre: "Línea 0–1000: ajuste lineal (R²)", dir: 1, dominio: "capacidad" },
    { clave: "lnfr_pae", nombre: "Línea de fracciones 0–1: error absoluto (%)", dir: -1, dominio: "logro", compuesto: "logro" },
    { clave: "va_suma_prec", nombre: "Verificación de sumas: precisión", dir: 1, dominio: "logro", pct: true },
    { clave: "va_suma_ies", nombre: "Verificación de sumas: eficiencia (IES, ms)", dir: -1, log: true, dominio: "logro", compuesto: "logro" },
    { clave: "va_mult_prec", nombre: "Verificación de multiplicaciones: precisión", dir: 1, dominio: "logro", pct: true },
    { clave: "va_mult_ies", nombre: "Verificación de multiplicaciones: eficiencia (IES, ms)", dir: -1, log: true, dominio: "logro", compuesto: "logro" },
    { clave: "flu_correctas", nombre: "Fluidez de cálculo: correctas en 2 min", dir: 1, dominio: "logro", compuesto: "logro" },
    { clave: "flu_errores", nombre: "Fluidez de cálculo: errores", dir: -1, dominio: "logro" }
  ];

  const CORTES_POR_DEFECTO = { capacidad: -1.5, logro: -1.0, indice: -1.5 };

  // ---------- utilidades estadísticas ----------
  const num = (v) => typeof v === "number" && isFinite(v);
  function mediana(a) {
    const v = a.filter(num).slice().sort((x, y) => x - y);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  function media(a) { const v = a.filter(num); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }
  function prop(a) { return a.length ? a.filter(Boolean).length / a.length : null; }
  function regresion(xs, ys) {
    const p = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => num(x) && num(y));
    if (p.length < 3) return null;
    const mx = media(p.map((q) => q[0])), my = media(p.map((q) => q[1]));
    let sxy = 0, sxx = 0, syy = 0;
    for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
    if (!sxx) return null;
    const b = sxy / sxx, a = my - b * mx;
    return { a, b, r2: syy ? (sxy * sxy) / (sxx * syy) : null };
  }
  function erf(x) { // Abramowitz-Stegun 7.1.26
    const s = Math.sign(x); x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  function pesoWeber(ensayos) { // máxima verosimilitud por búsqueda en rejilla
    const d = ensayos.filter((e) => !e.timeout && num(e.n_izq) && num(e.n_der));
    if (d.length < 12) return null;
    let mejor = null, mejorLL = -Infinity;
    for (let w = 0.05; w <= 1.5; w += 0.005) {
      let ll = 0;
      for (const e of d) {
        const z = Math.abs(e.n_izq - e.n_der) / (w * Math.sqrt(e.n_izq ** 2 + e.n_der ** 2));
        const pp = Math.min(0.999, Math.max(0.5, phi(z))); // modelo de Pica et al.; azar = 0.5
        ll += e.acierto ? Math.log(pp) : Math.log(1 - pp + 1e-9);
      }
      if (ll > mejorLL) { mejorLL = ll; mejor = w; }
    }
    return mejor;
  }
  const ies = (trs, prec) => (num(trs) && prec > 0 ? trs / prec : null);

  // ---------- cálculo de índices ----------
  function calcularIndices(ensayos) {
    const prueba = ensayos.filter((e) => !e.practica);
    const de = (t) => prueba.filter((e) => e.tarea === t);
    const I = {};

    // 1. TR simple
    const trs = de("tr_simple");
    const validos = trs.filter((e) => !e.anticipada && num(e.rt_ms) && e.rt_ms >= 150 && e.rt_ms <= 2000);
    I.trs_med = mediana(validos.map((e) => e.rt_ms));
    I.trs_anticip = trs.filter((e) => e.anticipada).length;
    const base = I.trs_med || 0;

    // 2. Enumeración
    const en = de("enumeracion");
    I.enu_prec = prop(en.map((e) => e.acierto));
    const enC = en.filter((e) => e.acierto && num(e.rt_ms));
    const enTr = mediana(enC.map((e) => e.rt_ms));
    I.enu_tr_aj = num(enTr) && I.trs_med ? enTr - base : null;
    I.enu_ies = ies(enTr, I.enu_prec);
    const pendiente = (lo, hi) => {
      const ns = [], ts = [];
      for (let n = lo; n <= hi; n++) {
        const m = mediana(enC.filter((e) => e.n === n).map((e) => e.rt_ms));
        if (num(m)) { ns.push(n); ts.push(m); }
      }
      const r = regresion(ns, ts); return r ? r.b : null;
    };
    I.enu_pend_sub = pendiente(1, 4);
    I.enu_pend_cont = pendiente(5, 9);

    // 3. Comparación simbólica
    const cs = de("comparacion_simbolica");
    const cs1 = cs.filter((e) => e.tipo === "1d"), cs2 = cs.filter((e) => e.tipo === "2d");
    I.cs_prec = prop(cs1.map((e) => e.acierto));
    const cs1C = cs1.filter((e) => e.acierto && num(e.rt_ms));
    I.cs_ies = ies(mediana(cs1C.map((e) => e.rt_ms)), I.cs_prec);
    const tr = (arr) => mediana(arr.map((e) => e.rt_ms));
    const tInc = tr(cs1C.filter((e) => e.condicion === "incongruente"));
    const tCon = tr(cs1C.filter((e) => e.condicion === "congruente"));
    I.cs_efecto_congr = num(tInc) && num(tCon) ? tInc - tCon : null;
    const tCer = tr(cs1C.filter((e) => e.distancia <= 2));
    const tLej = tr(cs1C.filter((e) => e.distancia >= 4));
    I.cs_efecto_dist = num(tCer) && num(tLej) ? tCer - tLej : null;
    I.cs2_prec = prop(cs2.map((e) => e.acierto));

    // 4. SNA
    const an = de("comparacion_no_simbolica");
    I.ans_prec = prop(an.map((e) => e.acierto));
    I.ans_prec_incongr = prop(an.filter((e) => e.control_area === "incongruente").map((e) => e.acierto));
    I.ans_w = pesoWeber(an);

    // 5. Línea numérica
    const ln = de("linea_numerica");
    const pae = (b) => {
      const v = ln.filter((e) => e.bloque === b && num(e.estimacion));
      return v.length ? media(v.map((e) => Math.abs(e.estimacion - e.objetivo) / e.escala * 100)) : null;
    };
    I.ln100_pae = pae("0-100");
    I.ln1000_pae = pae("0-1000");
    I.lnfr_pae = pae("fracciones");
    const l1k = ln.filter((e) => e.bloque === "0-1000" && num(e.estimacion));
    const rl = regresion(l1k.map((e) => e.objetivo), l1k.map((e) => e.estimacion));
    I.ln1000_r2lin = rl ? rl.r2 : null;

    // 6. Verificación aritmética
    const va = de("verificacion_aritmetica");
    for (const [b, k] of [["suma", "va_suma"], ["multiplicacion", "va_mult"]]) {
      const v = va.filter((e) => e.bloque === b);
      I[k + "_prec"] = prop(v.map((e) => e.acierto));
      I[k + "_ies"] = ies(mediana(v.filter((e) => e.acierto && num(e.rt_ms)).map((e) => e.rt_ms)), I[k + "_prec"]);
    }

    // 7. Fluidez
    const fl = de("fluidez").filter((e) => !e.sin_respuesta);
    I.flu_correctas = de("fluidez").length ? fl.filter((e) => e.acierto).length : null;
    I.flu_errores = de("fluidez").length ? fl.filter((e) => !e.acierto && !e.saltado).length : null;

    for (const k of Object.keys(I)) if (num(I[k])) I[k] = Math.round(I[k] * 10000) / 10000;
    return I;
  }

  // ---------- banderas de calidad de la aplicación ----------
  function banderasCalidad(ensayos, sesion, I) {
    const b = [];
    if (I.trs_med > 800) b.push("TR simple muy lento (> 800 ms): revisar atención, motricidad o manejo de la tableta.");
    if (I.trs_anticip >= 3) b.push("3 o más respuestas anticipadas en TR simple: posible impulsividad o juego.");
    const prueba = ensayos.filter((e) => !e.practica);
    const tareas = [...new Set(prueba.map((e) => e.tarea))];
    for (const t of tareas) {
      const v = prueba.filter((e) => e.tarea === t && e.tarea !== "fluidez" && e.tarea !== "linea_numerica");
      if (v.length && v.filter((e) => e.timeout).length / v.length > 0.3)
        b.push(`Más de 30 % de ensayos sin respuesta en «${t}».`);
    }
    if (I.va_suma_prec !== null && I.va_suma_prec <= 0.6)
      b.push("Precisión en verificación de sumas cercana al azar: confirmar comprensión de la consigna.");
    const enSub = prueba.filter((e) => e.tarea === "enumeracion" && e.n <= 4);
    const pSub = prop(enSub.map((e) => e.acierto));
    if (pSub !== null && pSub < 0.75) b.push("Errores frecuentes con 1 a 4 puntos (rango de subitización): dato clínicamente relevante o falta de atención.");
    if (sesion && sesion.interrupciones > 0) b.push(`La aplicación se interrumpió ${sesion.interrupciones} vez/veces (la app salió de primer plano).`);
    if (sesion && sesion.practicas_repetidas && sesion.practicas_repetidas.length)
      b.push("Se repitió la práctica en: " + sesion.practicas_repetidas.join(", ") + ".");
    if (sesion && sesion.tareas_omitidas && sesion.tareas_omitidas.length)
      b.push("Tareas omitidas por el aplicador: " + sesion.tareas_omitidas.join(", ") + ".");
    if (sesion && sesion.abortada) b.push("Sesión incompleta (abortada por el aplicador).");
    return b;
  }

  // ---------- comparación con normas ----------
  function transformar(def, x) {
    if (!num(x)) return null;
    if (def.log) return x > 0 ? Math.log(x) : null;
    return x;
  }
  function puntuarZ(I, normas, grado) {
    const out = {};
    const g = normas && normas.grupos && normas.grupos[grado];
    for (const def of INDICES) {
      const n = g && g[def.clave];
      const x = transformar(def, I[def.clave]);
      if (!n || !num(x) || !num(n.media) || !(n.de > 0)) { out[def.clave] = null; continue; }
      out[def.clave] = Math.round(def.dir * (x - n.media) / n.de * 100) / 100; // negativo = peor
    }
    return out;
  }
  function perfil(Z, normas) {
    const cortes = Object.assign({}, CORTES_POR_DEFECTO, (normas && normas.puntos_corte) || {});
    const comp = (d) => {
      const v = INDICES.filter((i) => i.compuesto === d).map((i) => Z[i.clave]).filter(num);
      return v.length >= 2 ? Math.round(media(v) * 100) / 100 : null;
    };
    const zc = comp("capacidad"), zl = comp("logro");
    let nivel = "sin_normas", titulo = "Resultados descriptivos (sin normas locales cargadas)", texto =
      "No hay normas para este grado. Los índices se muestran en bruto y no deben interpretarse como riesgo.";
    if (num(zc) && num(zl)) {
      const bc = zc <= cortes.capacidad, bl = zl <= cortes.logro;
      if (bc && bl) { nivel = "alto"; titulo = "Indicadores compatibles con riesgo de discalculia";
        texto = "Bajo desempeño en procesamiento numérico básico y en logro aritmético. Se recomienda referir a evaluación psicopedagógica o neuropsicológica completa (p. ej., ENI-2) y no emitir diagnóstico con este tamiz."; }
      else if (bl) { nivel = "medio"; titulo = "Bajo logro aritmético con procesamiento numérico básico conservado";
        texto = "El patrón sugiere causas distintas a un déficit nuclear de número: rezago escolar, oportunidades de aprendizaje, atención, lectura o ansiedad matemática. Revisar con USAER y docente."; }
      else if (bc) { nivel = "medio"; titulo = "Debilidad en procesamiento numérico básico con logro conservado";
        texto = "Vigilar y volver a tamizar en 3 a 6 meses; puede reflejar compensación con estrategias."; }
      else { nivel = "bajo"; titulo = "Sin indicadores de riesgo en este tamiz";
        texto = "El desempeño está dentro de lo esperado para el grado según las normas cargadas."; }
    }
    const debiles = INDICES.filter((i) => num(Z[i.clave]) && Z[i.clave] <= cortes.indice).map((i) => i.nombre);
    return { nivel, titulo, texto, z_capacidad: zc, z_logro: zl, cortes, indices_debiles: debiles,
      estado_normas: normas ? (normas.estado || "desconocido") : "sin_normas" };
  }

  const API = { INDICES, CORTES_POR_DEFECTO, calcularIndices, banderasCalidad, puntuarZ, perfil, mediana, media, regresion, pesoWeber };
  raiz.Puntuacion = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
