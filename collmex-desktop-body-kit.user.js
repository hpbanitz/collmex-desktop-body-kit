// ==UserScript==
// @name         Collmex Desktop Body Kit
// @namespace    dws-hpbanitz
// @version      1.49
// @description  Collmex-Listen (Angebote, Auftraege, Lieferungen, Rechnungen, Kunden, Adressen, Produkte): Spalte Bearbeiter/Angelegt, bei Angeboten Letzte Ausgabe, Zebrastreifen, anpassbare Spaltenbreiten, Statusfarben bei Auftraegen und Rechnungen, Jobticket-Button auf Kundenauftraegen, Anlegen-Buttons in der Kundenansicht, Ausklappmenues an den Bereichsreitern, mehrzeilige Produkt-Vorschlagsliste.
// @match        https://www.collmex.de/*
// @match        https://collmex.de/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// Ab 1.31 ohne @noframes: laeuft auch, wenn Collmex in einem iframe angezeigt wird (z. B. Link Previewer Pro).
// Ab 1.49 umbenannt von "Collmex Angebotsliste - Letzte Ausgabe" in "Collmex Desktop Body Kit".

(function () {
  'use strict';
  const BLOCK = 100;     // Angebote pro Ladeschritt (auch beim Start)
  const PARALLEL = 4;    // gleichzeitige Abrufe

  // Farben je Ausgabeart (Spalte Letzte Ausgabe): [Hintergrund, Schrift]
  // Nicht aufgefuehrte Arten (Brief, Fax, Keine Ausgabe) bleiben ohne Farbe
  const FARBEN = {
    'E-Mail': ['#c8efd0', '#0a4d1e'],   // hellgruen / dunkelgruen
    'Druck':  ['#e3d4f5', '#4a148c'],   // hellviolett / dunkelviolett
  };
  const FARBE_NIE = ['#f8d0d0', '#990000']; // nie ausgegeben: hellrot / dunkelrot

  function markierung(text, farbe) {
    const s = document.createElement('span');
    s.textContent = text;
    if (farbe) s.style.cssText = `display:inline-block;padding:1px 6px;border-radius:3px;background:${farbe[0]};color:${farbe[1]}`;
    return s;
  }

  // Datenzeilen einer Collmex-Suchliste: erster Link "Anzeigen", zweiter Link = Belegnummer.
  // Einzige Stelle mit dieser Erkennung; doc = aktuelle Seite oder per fetch geladene Seite.
  function listenZeilen(doc = document) {
    return [...doc.querySelectorAll('tr')].filter(tr => {
      const a = tr.querySelectorAll('a');
      return a.length >= 2 && a[0].textContent.trim() === 'Anzeigen' && /^\S+$/.test(a[1].textContent.trim());
    });
  }

  const VERSION = '1.49';
  console.log(`[Collmex Desktop Body Kit] Version ${VERSION} geladen auf`, document.title, window.top === window ? '' : '(im iframe)');

  // Jede zweite Zeile dunkler hinterlegen (Angebote und Kundenauftraege)
  function zebra() {
    if (!/^(Angebot|Kundenauftrag|Lieferung|Rechnung|Kunde|Adresse|Produkt) suchen/.test(document.title)) return;
    const style = document.createElement('style');
    style.textContent = 'tr.dws-zebra > td { background-color: rgba(0,0,0,0.07); }';
    document.head.appendChild(style);
    listenZeilen().forEach((tr, i) => { if (i % 2) tr.classList.add('dws-zebra'); });
  }

  // Drehendes Lade-Symbol
  function spinner() {
    if (!document.getElementById('dws-spinner-css')) {
      const st = document.createElement('style');
      st.id = 'dws-spinner-css';
      st.textContent = '@keyframes dws-dreh{to{transform:rotate(360deg)}}' +
        '.dws-spinner{display:inline-block;width:11px;height:11px;border:2px solid #c8c8c8;border-top-color:#4a4a4a;' +
        'border-radius:50%;animation:dws-dreh .8s linear infinite;vertical-align:-2px}';
      document.head.appendChild(st);
    }
    const sp = document.createElement('span');
    sp.className = 'dws-spinner';
    return sp;
  }

  // Kundenauftraege: Status einfaerben. Vorkasse offen rot (Mouse-over: Tage seit Auftragsdatum),
  // Bestaetigt gruen, Erledigt grau, Abgerechnet eingerahmt, Teilabgerechnet/Abschlag gestreift + Rahmen, Geliefert blau.
  const STATUS_STIL = [
    { test: t => /Vorkasse offen/.test(t), stil: 'background:#f8d0d0;color:#990000', tage: 'Vorkasse offen seit' },
    { test: t => /^Bestätigt/.test(t),     stil: 'background:#c8efd0;color:#0a4d1e' },
    { test: t => /^Erledigt/.test(t),      stil: 'background:#dedede;color:#555' },
    { test: t => /^Abgerechnet/.test(t),   stil: 'border:1px solid #777', rechnung: true },
    { test: t => /^(Teilabgerechnet|Abschlag berechnet)/.test(t),
      stil: 'border:1px solid #777;background:repeating-linear-gradient(45deg,#ffffff 0 7px,#d4d4d4 7px 14px)', rechnung: true },
    { test: t => /^Geliefert/.test(t),     stil: 'background:#d3e3fd;color:#0b3d91' },
  ];
  // Rechnungen (analog Auftraegen): Offen rot wie Vorkasse offen, Gemahnt kraeftig rot, Erledigt grau.
  // Mouse-over bei Offen/Gemahnt: Tage seit Rechnungsdatum.
  const STATUS_STIL_RE = [
    { test: t => /^Offen/.test(t),    stil: 'background:#f8d0d0;color:#990000', tage: 'Offen seit' },
    { test: t => /^Gemahnt/.test(t),  stil: 'background:#c62828;color:#fff;font-weight:bold', tage: 'Gemahnt – offen seit' },
    { test: t => /^Erledigt/.test(t), stil: 'background:#dedede;color:#555' },
  ];
  const STATUS_LISTEN = {
    'Kundenauftrag': { regeln: STATUS_STIL,    datum: 'Auftragsdatum', datumWort: 'Auftragsdatum' },
    'Rechnung':      { regeln: STATUS_STIL_RE, datum: 'Datum',         datumWort: 'Rechnungsdatum' },
  };

  // Beim Darueberfahren ein kleines Fenster mit Link(s) zur Rechnung des Auftrags zeigen.
  // Die Rechnungsnummern stehen auf der Auftragsseite; abgerufen wird erst beim ersten Darueberfahren.
  const rechnungsCache = {};
  let popup = null, popupTimer = null;
  function popupSchliessen() { popupTimer = setTimeout(() => { if (popup) { popup.remove(); popup = null; } }, 300); }
  function rechnungsPopup(span, auftragNr) {
    const mandant = location.search.slice(1).split(',')[0];
    span.style.cursor = 'help';
    span.addEventListener('mouseenter', async () => {
      clearTimeout(popupTimer);
      if (popup) popup.remove();
      popup = document.createElement('div');
      popup.style.cssText = 'position:absolute;z-index:1000;background:#fff;border:1px solid #888;border-radius:4px;' +
        'padding:4px 8px;font:12px sans-serif;box-shadow:0 2px 6px rgba(0,0,0,0.25);white-space:nowrap';
      const r = span.getBoundingClientRect();
      popup.style.left = (window.scrollX + r.left) + 'px';
      popup.style.top = (window.scrollY + r.bottom + 2) + 'px';
      popup.replaceChildren(spinner(), ' Rechnung wird gesucht');
      popup.addEventListener('mouseenter', () => clearTimeout(popupTimer));
      popup.addEventListener('mouseleave', popupSchliessen);
      document.body.appendChild(popup);
      const meinPopup = popup;
      try {
        if (!rechnungsCache[auftragNr]) {
          const res = await fetch(`/c.cmx?${mandant},1,kach,${auftragNr}`, { credentials: 'include' });
          const html = new TextDecoder('windows-1252').decode(await res.arrayBuffer());
          const d = new DOMParser().parseFromString(html, 'text/html');
          const nrn = [...d.querySelectorAll('a')]
            .map(a => ((a.getAttribute('href') || '').match(/,ivch,(\d+)/) || [])[1])
            .filter(Boolean);
          rechnungsCache[auftragNr] = [...new Set(nrn)];
        }
        if (meinPopup !== popup) return;
        const nrn = rechnungsCache[auftragNr];
        popup.textContent = '';
        if (!nrn.length) { popup.textContent = 'Keine Rechnung gefunden'; return; }
        popup.append(nrn.length > 1 ? 'Rechnungen: ' : 'Rechnung: ');
        nrn.forEach((nr, i) => {
          if (i) popup.append(', ');
          const a = document.createElement('a');
          a.href = `/c.cmx?${mandant},1,ivch,${nr}`;
          a.textContent = nr;
          popup.append(a);
        });
      } catch (e) {
        if (meinPopup === popup) popup.textContent = 'Fehler beim Abruf';
      }
    });
    span.addEventListener('mouseleave', popupSchliessen);
  }

  function statusFarben() {
    const liste = (document.title.match(/^(Kundenauftrag|Rechnung) suchen/) || [])[1];
    const cfg = STATUS_LISTEN[liste];
    if (!cfg) return;
    const rows = listenZeilen();
    if (!rows.length) return;
    // Spaltenpositionen aus der Kopfzeile (colspan beruecksichtigt)
    const pos = {};
    let i = 0;
    for (const th of rows[0].previousElementSibling.cells) {
      pos[th.innerText.trim()] = i;
      i += th.colSpan || 1;
    }
    if (pos['Status'] === undefined) return;
    const heute = new Date(); heute.setHours(0, 0, 0, 0);

    rows.forEach(tr => {
      const zelle = idx => { let n = 0; for (const c of tr.cells) { if (n === idx) return c; n += c.colSpan || 1; } return null; };
      const td = zelle(pos['Status']);
      if (!td || td.dataset.dwsStatus) return;
      const text = td.innerText.replace(/\s+/g, ' ').trim();
      const regel = cfg.regeln.find(r => r.test(text));
      if (!regel) return;
      td.dataset.dwsStatus = '1';
      const span = document.createElement('span');
      span.style.cssText = 'display:inline-block;padding:1px 6px;border-radius:3px;' + regel.stil;
      span.append(...td.childNodes);
      td.appendChild(span);
      if (regel.rechnung) rechnungsPopup(span, tr.querySelectorAll('a')[1].textContent.trim());
      if (regel.tage && pos[cfg.datum] !== undefined) {
        const m = (zelle(pos[cfg.datum])?.innerText || '').match(/(\d\d)\.(\d\d)\.(\d{4})/);
        if (m) {
          const tage = Math.round((heute - new Date(+m[3], +m[2] - 1, +m[1])) / 86400000);
          span.title = `${regel.tage} ${tage} ${tage === 1 ? 'Tag' : 'Tagen'} (${cfg.datumWort} ${m[0]})`;
        }
      }
    });
  }

  // Umschalter "Nur erste Zeile": mehrzeilige Zellen auf eine Zeile kuerzen (voller Text per Mouse-over).
  // Zustand wird je Liste im Browser gemerkt.
  function kompaktSchalter() {
    const liste = (document.title.match(/^(Angebot|Kundenauftrag|Lieferung|Rechnung|Kunde|Adresse|Produkt) suchen/) || [])[1];
    if (!liste) return;
    const bar = document.getElementById('dws-bar');
    if (!bar || document.getElementById('dws-kompakt-btn')) return;
    const rows = listenZeilen();
    if (!rows.length) return;
    const table = rows[0].closest('table');
    const style = document.createElement('style');
    style.textContent = 'table.dws-kompakt .dws-erste{line-height:1.25em;max-height:1.25em;overflow:hidden}';
    document.head.appendChild(style);

    // Nur mehrzeilige Zellen (mit Zeilenumbruch) in einen Container packen, damit die Hoehe begrenzt
    // werden kann. Das passiert gleich beim Laden in kleinen Portionen, damit der Button sofort reagiert.
    const packe = tr => {
      for (const td of tr.cells) {
        if (td.querySelector(':scope > .dws-erste')) continue;
        if (!td.querySelector('br') && !/\n/.test(td.textContent.trim())) continue;
        const box = document.createElement('div');
        box.className = 'dws-erste';
        box.append(...td.childNodes);
        td.appendChild(box);
        td.addEventListener('mouseenter', () => {
          if (table.classList.contains('dws-kompakt') && box.scrollHeight > box.clientHeight + 1 && !td.title)
            td.title = box.innerText.trim();
        });
      }
    };
    let pos = 0;
    const portion = () => {
      const ende = Math.min(pos + 50, rows.length);
      for (; pos < ende; pos++) packe(rows[pos]);
      if (pos < rows.length) setTimeout(portion, 0);
    };
    setTimeout(portion, 0);

    const KEY = 'dws-kompakt:' + liste;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'dws-kompakt-btn';
    btn.style.marginLeft = '16px';
    const setze = an => {
      table.classList.toggle('dws-kompakt', an);
      btn.textContent = an ? 'Alle Zeilen zeigen' : 'Nur erste Zeile';
      try { localStorage.setItem(KEY, an ? '1' : '0'); } catch (e) {}
    };
    btn.addEventListener('click', () => setze(!table.classList.contains('dws-kompakt')));
    bar.appendChild(btn);
    let start = false;
    try { start = localStorage.getItem(KEY) === '1'; } catch (e) {}
    setze(start);
  }

  // Collmex schreibt in manche Mouse-over-Texte (title) HTML wie "<br>" hinein, das der Browser als Text zeigt.
  // Hier wird daraus ein echter Zeilenumbruch; uebrige HTML-Reste werden entfernt. Gilt auf allen Collmex-Seiten.
  function titelUmbrueche() {
    for (const el of document.querySelectorAll('[title*="<"]')) {
      const t = el.getAttribute('title');
      // DOMParser: inertes Dokument, enthaltenes HTML wird nicht ausgefuehrt
      const text = new DOMParser().parseFromString(t.replace(/<br\s*\/?>/gi, '\n'), 'text/html').body.textContent;
      el.setAttribute('title', text.replace(/\n{3,}/g, '\n\n').trim());
    }
  }

  // Spaltenbreiten per Ziehen am rechten Rand der Kopfzelle anpassen.
  // Breiten werden je Liste im Browser gespeichert. Doppelklick auf den Rand = Spalte zuruecksetzen.
  function spaltenbreiten() {
    const liste = (document.title.match(/^(Angebot|Kundenauftrag|Lieferung|Rechnung|Kunde|Adresse|Produkt) suchen/) || [])[1];
    if (!liste) return;
    const rows = listenZeilen();
    if (!rows.length) return;
    const hdr = rows[0].previousElementSibling;
    if (!hdr || hdr.dataset.dwsResize) return;
    hdr.dataset.dwsResize = '1';

    const KEY = 'dws-spaltenbreiten:' + liste;
    let gespeichert = {};
    try { gespeichert = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
    const speichern = () => { try { localStorage.setItem(KEY, JSON.stringify(gespeichert)); } catch (e) {} };

    const style = document.createElement('style');
    document.head.appendChild(style);
    const regeln = {}; // Spaltenindex -> Breite
    const schreibeCss = () => {
      style.textContent =
        '.dws-grip{position:absolute;top:0;right:-4px;width:8px;height:100%;cursor:col-resize;z-index:5}' +
        '.dws-grip::after{content:"";position:absolute;left:3px;top:20%;height:60%;border-left:2px dotted rgba(0,0,0,0.35)}' +
        '.dws-grip:hover{background:rgba(0,0,0,0.12)}.dws-grip:hover::after{border-left:2px solid rgba(0,0,0,0.6)}' +
        Object.entries(regeln).map(([i, w]) =>
          `.dws-c${i}{width:${w}px;min-width:${w}px;max-width:${w}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`
        ).join('');
    };

    // Spaltenindex fuer jede Zelle bestimmen (colspan beruecksichtigen) und Klasse setzen
    const markiere = tr => {
      let i = 0;
      for (const c of tr.cells) { c.classList.add('dws-c' + i); i += c.colSpan || 1; }
    };
    rows.forEach(markiere);

    // Vollen Text als Tooltip zeigen, wenn eine Zelle abgeschnitten ist
    rows[0].parentElement.addEventListener('mouseover', e => {
      const td = e.target.closest('td');
      if (td && td.scrollWidth > td.clientWidth && !td.title) td.title = td.innerText.trim();
    });

    // Sortieren per Klick auf die Spaltenueberschrift (nur die Zeilen der aktuellen Liste)
    let gezogen = false;            // verhindert Sortieren direkt nach dem Ziehen eines Randes
    let sortSpalte = null, sortAuf = true;
    const sortWert = tr => {
      const td = tr.querySelector('.dws-c' + sortSpalte);
      const t = (td?.innerText || '').trim();
      if (!t || t === '–' || t === '…' || t === 'nie ausgegeben') return null;
      const dm = t.match(/^(\d\d)\.(\d\d)\.(\d{4})(?:\D+(\d\d):(\d\d))?/);
      if (dm) return Number(dm[3] + dm[2] + dm[1] + (dm[4] || '00') + (dm[5] || '00'));
      if (/^-?[\d.]+(,\d+)?$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
      return t.toLowerCase();
    };
    const vergleich = (a, b) => {
      const x = sortWert(a), y = sortWert(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;            // leere Werte immer ans Ende
      if (y === null) return -1;
      const r = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x).localeCompare(String(y), 'de', { numeric: true });
      return sortAuf ? r : -r;
    };
    const pfeile = [];
    function sortierbar(th, idx) {
      th.style.cursor = 'pointer';
      const pf = document.createElement('span');
      pf.style.cssText = 'margin-left:4px;font-size:10px;color:#666';
      th.appendChild(pf);
      pfeile.push(pf);
      th.title = 'Klicken: sortieren';
      th.addEventListener('click', e => {
        if (gezogen || e.target.closest('.dws-grip')) return;
        sortAuf = (sortSpalte === idx) ? !sortAuf : true;
        sortSpalte = idx;
        pfeile.forEach(p => { p.textContent = ''; });
        pf.textContent = sortAuf ? '▲' : '▼';
        const sortiert = rows.slice().sort(vergleich);  // stabil: gleiche Werte behalten Reihenfolge
        let ref = hdr;
        sortiert.forEach((tr, n) => {
          ref.after(tr); ref = tr;
          tr.classList.toggle('dws-zebra', n % 2 === 1);
        });
      });
    }

    let i = 0;
    for (const th of hdr.cells) {
      const idx = i;
      i += th.colSpan || 1;
      const name = th.innerText.trim();
      th.classList.add('dws-c' + idx);
      if (!name) continue;
      sortierbar(th, idx);
      if (th.colSpan > 1) continue; // Betrag (2 Spalten) nicht in der Breite anpassbar
      if (gespeichert[name]) regeln[idx] = gespeichert[name];

      th.style.position = 'relative';
      const grip = document.createElement('div');
      grip.className = 'dws-grip';
      grip.title = 'Ziehen: Breite aendern – Doppelklick: zuruecksetzen';
      th.appendChild(grip);

      grip.addEventListener('mousedown', e => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = th.getBoundingClientRect().width;
        const move = ev => {
          regeln[idx] = Math.max(30, Math.round(startW + ev.clientX - startX));
          schreibeCss();
        };
        const up = () => {
          gezogen = true; setTimeout(() => { gezogen = false; }, 0);
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          if (regeln[idx]) { gespeichert[name] = regeln[idx]; speichern(); }
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      grip.addEventListener('dblclick', () => {
        delete regeln[idx]; delete gespeichert[name];
        schreibeCss(); speichern();
      });
    }
    schreibeCss();
  }

  // Listen, in denen Zusatzspalten geladen werden. code = Collmex-Seite mit dem Reiter Verkauf
  // ---- Verwendung von Produkten in Angeboten / Auftraegen zaehlen ----
  // Collmex' Suchfeld "Produkt" findet auch Teiltreffer (z. B. 10001 findet EFK-10001).
  // Deshalb: Produktkatalog (inkl. inaktive) laden; ist eine Nummer in einer anderen enthalten,
  // werden die gefundenen Belege einzeln auf exakte Uebereinstimmung geprueft.
  const htmlParse = async res => new DOMParser().parseFromString(new TextDecoder('windows-1252').decode(await res.arrayBuffer()), 'text/html');
  const vorlagen = {};
  function suchVorlage(mandant, code) {
    if (!vorlagen[code]) {
      vorlagen[code] = fetch(`/c.cmx?${mandant},1,${code}`, { credentials: 'include' }).then(htmlParse).then(d => {
        const f = d.querySelector('form');
        const fd = new URLSearchParams();
        for (const e of f.elements) {
          if (!e.name) continue;
          if (e.type === 'submit' && e.name !== 'suchen') continue;
          if (e.type === 'checkbox') continue;                 // alle Haken aus (z. B. "Nur offene", "Auch gelöschte")
          fd.append(e.name, e.value);
        }
        for (const k of [...fd.keys()]) if (/DatumVon|DatumBis|FristVon|FristBis/.test(k)) fd.set(k, '');  // alle Zeitraeume
        return { fd, form: f };
      });
    }
    return vorlagen[code];
  }
  async function suchTreffer(mandant, code, felder) {
    const { fd } = await suchVorlage(mandant, code);
    const body = new URLSearchParams(fd);
    for (const [k, v] of Object.entries(felder)) body.set(k, v);
    const res = await fetch(`/c.cmx?${mandant},1,${code}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString()
    });
    const d = await htmlParse(res);
    return listenZeilen(d).map(tr => tr.querySelectorAll('a')[1].textContent.trim());
  }
  let katalog = null;
  function produktKatalog(mandant) {
    if (!katalog) {
      katalog = suchVorlage(mandant, 'pr').then(({ form }) => {
        const sel = [...form.querySelectorAll('select')].find(x => /inakt/i.test(x.name));
        const felder = {};
        if (sel && sel.options[1]) felder[sel.name] = sel.options[1].value;   // "Auch inaktive"
        return suchTreffer(mandant, 'pr', felder);
      }).catch(() => []);
    }
    return katalog;
  }
  const belegProdukte = {};
  function produkteImBeleg(mandant, code, nr) {
    const key = code + nr;
    if (!belegProdukte[key]) {
      belegProdukte[key] = fetch(`/c.cmx?${mandant},1,${code},${nr}`, { credentials: 'include' }).then(htmlParse)
        .then(d => [...d.querySelectorAll('input')].filter(i => /^pos_\d+_produktNr$/.test(i.name)).map(i => i.value.trim()));
    }
    return belegProdukte[key];
  }
  // Liefert { anzahl, geprueft } fuer ein Produkt in Angeboten (qo) bzw. Auftraegen (ka)
  async function verwendung(mandant, liste, produktNr) {
    const treffer = await suchTreffer(mandant, liste, { group_produktNr: produktNr });
    const alle = await produktKatalog(mandant);
    const mehrdeutig = alle.some(q => q !== produktNr && q.includes(produktNr));
    if (!mehrdeutig || !treffer.length) return { anzahl: treffer.length, geprueft: false };
    const detail = liste === 'qo' ? 'qoch' : 'kach';
    let n = 0;
    for (const t of treffer) if ((await produkteImBeleg(mandant, detail, t)).includes(produktNr)) n++;
    return { anzahl: n, geprueft: true, roh: treffer.length };
  }

  // ---- Produkt-Vorschlagsliste (Eingabe im Feld Produkt in Belegen): Bezeichnung mehrzeilig ----
  // Collmex kuerzt die Texte schon auf dem Server (prsuggest, ca. 64 Zeichen + "...").
  // Der volle Text steht im Mouse-over der Produktliste (pr). Die Liste wird einmal geladen, je Mandant
  // im Browser gemerkt und nach 30 Minuten im Hintergrund erneuert. Nur lesend.
  // Auswahl/Tastatur bleiben Collmex' eigene Funktionen; es wird nur der Text in der Liste ersetzt.
  const VORSCHLAG_ZEILEN = 3;
  const PRTEXT_MAX_ALTER = 30 * 60000;
  let prTexteLaeuft = null, prTexteNeuVersucht = 0;
  function prTexteGemerkt(mandant) {
    try { return JSON.parse(localStorage.getItem('dws-prtexte:' + mandant) || 'null'); } catch (e) { return null; }
  }
  function prTexteHolen(mandant) {
    if (!prTexteLaeuft) {
      prTexteLaeuft = suchVorlage(mandant, 'pr').then(({ fd, form }) => {
        const body = new URLSearchParams(fd);
        // Nur Textfilter leeren (Auswahlfelder wie Standort brauchen ihren Wert, sonst liefert Collmex nichts)
        for (const k of ['group_produktNr', 'group_freiText', 'group_lieferantNr', 'group_hersteller']) if (body.has(k)) body.set(k, '');
        const sel = [...form.querySelectorAll('select')].find(x => /inakt/i.test(x.name));
        if (sel && sel.options[1]) body.set(sel.name, sel.options[1].value);   // "Auch inaktive"
        return fetch(`/c.cmx?${mandant},1,pr`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString()
        });
      }).then(htmlParse).then(d => {
        const texte = {};
        listenZeilen(d).forEach(tr => {
          const nr = tr.querySelectorAll('a')[1].textContent.trim();
          const td = tr.cells[2];
          if (!td) return;
          const roh = td.querySelector('[title]')?.getAttribute('title') || td.innerHTML;
          const text = new DOMParser().parseFromString(roh.replace(/<br\s*\/?>/gi, '\n'), 'text/html').body.textContent;
          texte[nr] = text.split('\n').map(z => z.trim()).filter(Boolean);
        });
        if (!Object.keys(texte).length) throw new Error('Produktliste leer');
        const daten = { ts: Date.now(), texte };
        try { localStorage.setItem('dws-prtexte:' + mandant, JSON.stringify(daten)); } catch (e) {}
        return daten;
      }).finally(() => { prTexteLaeuft = null; });
    }
    return prTexteLaeuft;
  }
  function produktVorschlag() {
    if (typeof window.SuggestFramework_Suggest !== 'function' || window.SuggestFramework_Suggest.dwsMehrzeilig) return;
    const ic = window.SuggestFramework_InputContainer;
    if (!ic || ![...ic].some(x => /produktNr/.test(x.name))) return;
    const mandant = location.search.slice(1).split(',')[0];
    let gem = prTexteGemerkt(mandant);
    const aktualisieren = () => prTexteHolen(mandant).then(d => { gem = d; return d; }).catch(() => gem);
    if (!gem || Date.now() - (gem.ts || 0) > PRTEXT_MAX_ALTER) aktualisieren();

    const st = document.createElement('style');
    st.textContent =
      'table.dws-vorschlag{width:auto!important;min-width:560px;border-collapse:collapse}' +
      'table.dws-vorschlag td{vertical-align:top;padding:3px 6px!important;border-bottom:1px solid #e2d6bf}' +
      'table.dws-vorschlag td:first-child{white-space:nowrap;font-weight:bold}' +
      '.dws-vz{max-width:720px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3em}' +
      '.dws-vz+.dws-vz{color:#666;font-size:.92em}' +
      '.suggest-highlighted .dws-vz+.dws-vz{color:inherit}' +
      // Liste scrollbar: Hoehe bis zum unteren Fensterrand (wird beim Anzeigen gesetzt)
      '.suggest-list.dws-scroll{width:max-content!important;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;' +
      'border:1px solid #e2c693;border-radius:4px;box-shadow:2px 2px 2px #666}' +
      '.suggest-list.dws-scroll table{border:0!important;border-radius:0!important;box-shadow:none!important}';
    document.head.appendChild(st);

    // Hoehe der Liste an den Platz unter dem Eingabefeld anpassen (mind. 200 px)
    const hoeheSetzen = instance => {
      const box = window.SuggestFramework_OutputContainer[instance];
      const input = window.SuggestFramework_InputContainer[instance];
      if (!box || !input || !/produktNr/.test(input.name)) return;
      box.classList.add('dws-scroll');
      box.style.maxHeight = Math.max(200, window.innerHeight - input.getBoundingClientRect().bottom - 12) + 'px';
    };
    // Mit Pfeiltasten gewaehlte Zeile im sichtbaren Bereich halten (nur die Liste scrollt, nicht die Seite)
    const sichtbarHalten = instance => {
      const box = window.SuggestFramework_OutputContainer[instance];
      if (!box || !box.classList.contains('dws-scroll')) return;
      const i = window.SuggestFramework_SuggestionsIndex[instance];
      const tr = document.getElementById(window.SuggestFramework_Name[instance] + 'Suggestions[' + i + ']');
      if (!tr) { if (i < 0) box.scrollTop = 0; return; }
      const oben = tr.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientTop;
      const unten = oben + tr.offsetHeight;
      if (oben < 0) box.scrollTop += oben;
      else if (unten > box.clientHeight) box.scrollTop += unten - box.clientHeight;
    };
    for (const name of ['SuggestFramework_SelectNext', 'SuggestFramework_SelectPrevious']) {
      const orig = window[name];
      if (typeof orig !== 'function') continue;
      window[name] = function (instance) {
        const r = orig.apply(this, arguments);
        try { sichtbarHalten(instance); } catch (e) {}
        return r;
      };
    }

    const original = window.SuggestFramework_Suggest;
    function umbauen(instance) {
      const box = window.SuggestFramework_OutputContainer[instance];
      const input = window.SuggestFramework_InputContainer[instance];
      if (!box || !input || !/produktNr/.test(input.name)) return;
      const tab = box.querySelector('table.suggest-combo');
      if (!tab) return;
      tab.classList.add('dws-vorschlag');
      const texte = gem && gem.texte || {};
      let fehlt = false;
      for (const tr of tab.querySelectorAll('tbody tr')) {
        const nr = (tr.cells[0]?.textContent || '').trim();
        const td = tr.cells[1];
        if (!td || td.dataset.dwsVz) continue;
        const zeilen = texte[nr];
        if (!zeilen) { if (nr) fehlt = true; continue; }
        td.dataset.dwsVz = '1';
        td.title = zeilen.join('\n');                                  // voller Text per Mouse-over
        td.replaceChildren(...zeilen.slice(0, VORSCHLAG_ZEILEN).map(z => {
          const div = document.createElement('div');
          div.className = 'dws-vz';
          div.textContent = z;
          return div;
        }));
      }
      // Unbekannte Nummer (z. B. gerade angelegtes Produkt): Liste hoechstens einmal je Minute neu laden
      if (fehlt && Date.now() - prTexteNeuVersucht > 60000) {
        prTexteNeuVersucht = Date.now();
        aktualisieren().then(() => umbauen(instance));
      }
    }
    window.SuggestFramework_Suggest = function (instance, list) {
      const r = original.apply(this, arguments);
      try { umbauen(instance); hoeheSetzen(instance); window.SuggestFramework_OutputContainer[instance].scrollTop = 0; }
      catch (e) { console.warn('[DWS] Vorschlagsliste', e); }
      if (!gem) aktualisieren().then(() => umbauen(instance));
      return r;
    };
    window.SuggestFramework_Suggest.dwsMehrzeilig = true;
  }

  // Belegnummern aus Links einer Collmex-Seite lesen (code z. B. 'qoch', 'kach', 'ivch')
  function belegNummern(d, code) {
    const re = new RegExp(',' + code + ',(\\d+)');
    return [...new Set([...d.querySelectorAll('a')]
      .map(a => ((a.getAttribute('href') || '').match(re) || [])[1]).filter(Boolean))];
  }
  function auftragsInfoAus(d) {
    return { angebote: belegNummern(d, 'qoch'), rechnungen: belegNummern(d, 'ivch') };
  }
  // Auftragsseite abrufen (einmal je Auftrag, wird gemerkt)
  const auftragsCache = {};
  function auftragsInfo(mandant, nr) {
    if (!auftragsCache[nr]) {
      auftragsCache[nr] = fetch(`/c.cmx?${mandant},1,kach,${nr}`, { credentials: 'include' })
        .then(r => r.arrayBuffer())
        .then(b => auftragsInfoAus(new DOMParser().parseFromString(new TextDecoder('windows-1252').decode(b), 'text/html')));
    }
    return auftragsCache[nr];
  }
  // Zelle mit klickbaren Belegnummern fuellen
  function belegLinks(td, nrn, mandant, code, wort) {
    td.style.color = '';
    if (!nrn.length) { td.textContent = '–'; td.title = `Kein ${wort} verknüpft`; return; }
    td.textContent = '';
    nrn.forEach((nr, i) => {
      if (i) td.append(', ');
      const a = document.createElement('a');
      a.href = `/c.cmx?${mandant},1,${code},${nr}`;
      a.textContent = nr;
      a.title = `${wort} öffnen`;
      td.append(a);
    });
  }

  const LISTEN = {
    'Angebot':       { code: 'qochhead', wort: 'Angebote',     ausgabe: true },
    // Kundenauftraege: kein Bearbeiter (zeigt Collmex selbst), aber Angebotsnummer rechts vom Auftragsdatum
    'Kundenauftrag': { code: 'kach', wort: 'Aufträge', ohneBearb: true, angebot: true, datum: 'Auftragsdatum' },
    'Lieferung':     { code: 'dvchhead', wort: 'Lieferungen' },
    'Rechnung':      { code: 'ivchhead', wort: 'Rechnungen', angebot: true, auftrag: true, datum: 'Datum' },
    'Kunde':         { code: 'cuch', suffix: ',1', wort: 'Kunden', nurAngelegt: true, aenderung: true },
    // Adressen (inkl. Ansprechpartner): Detailseite adrch,<nr>,<typ> - Link steht in der Zeile, Felder wie bei Kunden
    'Adresse':       { link: 'adrch', wort: 'Adressen', nurAngelegt: true, aenderung: true },
    // Produkte: kein Bearbeiter-Feld in Collmex; Ersteller und letzter Aenderer stehen im Reiter Allgemein
    'Produkt':       { code: 'prch', suffix: ',1', wort: 'Produkte', ohneBearb: true, produkt: true, verwendung: true },
  };

  function run() {
    const liste = (document.title.match(/^(Angebot|Kundenauftrag|Lieferung|Rechnung|Kunde|Adresse|Produkt) suchen/) || [])[1];
    if (!liste) return;
    const cfg = LISTEN[liste];
    if (!cfg) return;
    if (document.getElementById('dws-bar')) return;

    const rows = listenZeilen();
    if (!rows.length) return;

    const mandant = location.search.slice(1).split(',')[0];
    const hdr = rows[0].previousElementSibling;
    const zellStil = 'padding-left:12px;white-space:nowrap;vertical-align:top;color:#aaa';

    // Spalten anlegen: Bearbeiter/Angelegt von, bei Angeboten danach Letzte Ausgabe
    const spalten = [];
    if (!cfg.ohneBearb) spalten.push(cfg.nurAngelegt ? 'Angelegt von' : 'Bearb. / Angelegt');
    if (cfg.produkt) spalten.push('Angelegt von', 'Angelegt am', 'Geändert am', 'Geändert von');
    if (cfg.verwendung) spalten.push('in AN', 'in AU');   // AN = Angebote, AU = Auftraege
    if (cfg.aenderung) spalten.push('Letzte Änderung');
    if (cfg.ausgabe) spalten.push('Letzte Ausgabe');
    spalten.forEach(t => {
      const th = hdr.insertCell(-1);
      th.style.cssText = 'font-weight:bold;padding-left:12px;white-space:nowrap';
      th.textContent = t;
      if (t === 'Letzte Ausgabe') th.id = 'dws-la-hdr';
    });

    // Angebots-/Auftragsspalte direkt rechts vom Datum einfuegen
    const hdrZellen = [...hdr.cells];
    const datIdx = hdrZellen.findIndex(c => c.innerText.trim() === cfg.datum);
    let datPos = 0;                                   // Position mit colspan
    for (let k = 0; k < datIdx; k++) datPos += hdrZellen[k].colSpan || 1;
    // Reihenfolge: erst Auftrag einfuegen, dann Angebot davor -> Angebot | Auftrag
    if (cfg.auftrag) {
      const th = hdr.insertCell(datIdx >= 0 ? datIdx + 1 : -1);
      th.style.cssText = 'font-weight:bold;padding-left:12px;white-space:nowrap';
      th.textContent = 'Auftrag';
    }
    if (cfg.angebot) {
      const th = hdr.insertCell(datIdx >= 0 ? datIdx + 1 : -1);
      th.style.cssText = 'font-weight:bold;padding-left:12px;white-space:nowrap';
      th.textContent = 'Angebot';
    }
    const zelleNachDatum = tr => {                     // Zellindex in der Zeile rechts vom Datum
      if (datIdx < 0) return -1;
      let n = 0, k = 0;
      for (const c of tr.cells) { if (n === datPos) return k + 1; n += c.colSpan || 1; k++; }
      return -1;
    };

    const jobs = rows.map(tr => {
      const nr = tr.querySelectorAll('a')[1].textContent.trim();
      // Listen mit eigenem Detail-Link (Adressen): URL direkt aus der Zeile nehmen
      const url = cfg.link ? ([...tr.querySelectorAll('a')]
        .find(a => (a.getAttribute('href') || '').includes(',' + cfg.link + ','))?.getAttribute('href') || '') : '';
      let tdK = null;
      if (cfg.auftrag) { tdK = tr.insertCell(zelleNachDatum(tr)); tdK.style.cssText = zellStil; tdK.textContent = '–'; }
      let tdQ = null;
      if (cfg.angebot) { tdQ = tr.insertCell(zelleNachDatum(tr)); tdQ.style.cssText = zellStil; tdQ.textContent = '–'; }
      let tdB = null;
      if (!cfg.ohneBearb) { tdB = tr.insertCell(-1); tdB.style.cssText = zellStil; tdB.textContent = '–'; }
      let tdP = null;
      if (cfg.produkt) tdP = [0, 1, 2, 3].map(() => { const c = tr.insertCell(-1); c.style.cssText = zellStil; c.textContent = '–'; return c; });
      let tdV = null;
      if (cfg.verwendung) tdV = [0, 1].map(() => { const c = tr.insertCell(-1); c.style.cssText = zellStil + ';text-align:right'; c.textContent = '–'; return c; });
      let tdG = null;
      if (cfg.aenderung) { tdG = tr.insertCell(-1); tdG.style.cssText = zellStil; tdG.textContent = '–'; }
      let tdA = null;
      if (cfg.ausgabe) { tdA = tr.insertCell(-1); tdA.style.cssText = zellStil; tdA.textContent = '–'; }
      return { nr, url, tdQ, tdK, tdB, tdP, tdV, tdG, tdA };
    });

    // Bedienleiste über der Liste
    const bar = document.createElement('div');
    bar.id = 'dws-bar';
    bar.style.cssText = 'margin:6px 0 6px 8px;font:12px sans-serif;display:flex;gap:8px;align-items:center';
    const status = document.createElement('span');
    const btnNext = document.createElement('button');
    const btnAll = document.createElement('button');
    btnNext.type = btnAll.type = 'button';
    btnNext.textContent = `Nächste ${BLOCK} laden`;
    btnAll.textContent = 'Alle laden';
    const dreh = spinner();
    bar.append('Zusatzspalten:', btnNext, btnAll, dreh, status);
    const table = rows[0].closest('table');
    table.parentNode.insertBefore(bar, table);

    let next = 0;
    let busy = false;

    function updateUi() {
      const done = Math.min(next, jobs.length);
      status.textContent = `${done} von ${jobs.length} ${cfg.wort} geladen` + (busy ? ' – lädt …' : '');
      dreh.style.display = busy ? 'inline-block' : 'none';
      btnNext.disabled = btnAll.disabled = busy || done >= jobs.length;
    }

    async function load(job) {
      if (job.tdB) job.tdB.textContent = '…';
      if (job.tdQ) job.tdQ.textContent = '…';
      if (job.tdK) job.tdK.textContent = '…';
      if (job.tdA) job.tdA.textContent = '…';
      if (job.tdG) job.tdG.textContent = '…';
      if (job.tdP) job.tdP.forEach(c => { c.textContent = '…'; });
      if (job.tdV) job.tdV.forEach(c => { c.textContent = '…'; });
      try {
        if (cfg.link && !job.url) throw new Error('kein Detail-Link');
        const r = await fetch(job.url || `/c.cmx?${mandant},1,${cfg.code},${encodeURIComponent(job.nr)}${cfg.suffix || ''}`, { credentials: 'include' });
        const html = new TextDecoder('windows-1252').decode(await r.arrayBuffer());
        const d = new DOMParser().parseFromString(html, 'text/html');

        // Bearbeiter (Nummer + Name) und Angelegt von (Kuerzel + Name)
        const feld = label => {
          const td = [...d.querySelectorAll('td')].find(t => t.children.length < 2 && t.textContent.trim() === label);
          return (td?.nextElementSibling?.innerText || '').replace(/\s+/g, ' ').trim();
        };
        const bNr = d.querySelector('[name="group_bearbeiter"]')?.value || '';
        const bName = feld('Bearbeiter:').replace(/^-\s*/, '');
        const angelegt = feld('Angelegt von:');
        const angelegtAm = feld('Angelegt am:');
        const angelegtTxt = `${angelegt || 'unbekannt'}${angelegtAm ? ' am ' + angelegtAm : ''}`;
        const kuerzel = angelegt.split(' - ')[0] || '';
        if (job.tdQ || job.tdK) {
          let angebote = [], auftraege = [];
          if (liste === 'Kundenauftrag') {
            // Seite ist bereits die Auftragsseite
            const info = auftragsInfoAus(d);
            auftragsCache[job.nr] = Promise.resolve(info);
            rechnungsCache[job.nr] = info.rechnungen;
            angebote = info.angebote;
          } else {
            // Rechnung: Auftraege stehen auf der Rechnungsseite, Angebote auf der jeweiligen Auftragsseite
            auftraege = belegNummern(d, 'kach');
            for (const k of auftraege) angebote.push(...(await auftragsInfo(mandant, k)).angebote);
            angebote = [...new Set(angebote)];
          }
          if (job.tdQ) belegLinks(job.tdQ, angebote, mandant, 'qoch', 'Angebot');
          if (job.tdK) belegLinks(job.tdK, auftraege, mandant, 'kach', 'Auftrag');
        }
        if (job.tdB) {
        job.tdB.style.color = '';
        if (cfg.nurAngelegt) {
          job.tdB.textContent = kuerzel || '–';
          job.tdB.title = `Angelegt von: ${angelegtTxt}`;
        } else {
          job.tdB.textContent = `${bNr || '–'} / ${kuerzel || '–'}`;
          job.tdB.title = `Bearbeiter: ${bNr ? bNr + ' - ' + bName : 'keiner'}\nAngelegt von: ${angelegtTxt}`;
        }
        }

        if (job.tdV) {
          const [vA, vK] = await Promise.all([verwendung(mandant, 'qo', job.nr), verwendung(mandant, 'ka', job.nr)]);
          [[job.tdV[0], vA, 'Angeboten'], [job.tdV[1], vK, 'Aufträgen']].forEach(([c, v, wort]) => {
            c.style.color = v.anzahl ? '' : '#999';
            c.textContent = String(v.anzahl);
            c.title = `In ${v.anzahl} ${wort} verwendet (alle Zeiträume, ohne gelöschte)` +
              (v.geprueft ? `\nEinzeln geprüft: Collmex fand ${v.roh} Teiltreffer` : '');
          });
        }
        if (job.tdP) {
          // Zeilen im Reiter Allgemein: "Angelegt am: 18.01.2026 - 17:07:59 von Benutzer: 5439279 - Sören Schulz"
          //                             "Zuletzt geändert am: 07.07.2026 - 13:49:00 von: hagedorn - Knud Hagedorn"
          const zeilen = [...d.querySelectorAll('tr')].filter(z => !z.querySelector('tr'))
            .map(z => z.textContent.replace(/\s+/g, ' ').trim());
          const lies = re => { for (const z of zeilen) { const m = z.match(re); if (m) return m; } return null; };
          const an = lies(/Angelegt am: (\d\d\.\d\d\.\d{4}) - (\d\d:\d\d)\S* von Benutzer: ?(.*)$/);
          const ge = lies(/Zuletzt geändert am: (\d\d\.\d\d\.\d{4}) - (\d\d:\d\d)\S* von: ?(.*)$/);
          const [cAv, cAm, cGm, cGv] = job.tdP;
          const setze = (c, text, titel) => { c.style.color = ''; c.textContent = text || '–'; c.title = titel || ''; };
          setze(cAv, an && an[3] ? an[3].split(' - ')[0] : '', an && an[3] ? `Angelegt von: ${an[3]}` : '');
          setze(cAm, an ? `${an[1]} ${an[2]}` : '');
          setze(cGm, ge ? `${ge[1]} ${ge[2]}` : '');
          setze(cGv, ge && ge[3] ? ge[3].split(' - ')[0] : '', ge && ge[3] ? `Geändert von: ${ge[3]}` : '');
        }
        if (job.tdG) {
          const gAm = feld('Geändert am:');            // z. B. 21.09.2026 - 12:42:51
          const gVon = feld('Geändert von:');          // z. B. hagedorn - Knud Hagedorn
          job.tdG.style.color = '';
          job.tdG.textContent = gAm ? `${gAm.split(' - ')[0]} ${gVon.split(' - ')[0]}` : '–';
          job.tdG.title = `Geändert am: ${gAm || 'unbekannt'}\nGeändert von: ${gVon || 'unbekannt'}`;
        }
        if (job.tdA) {
          const am = d.querySelector('[name="group_zuletztAusgegebenAm"]')?.value || '';
          const sel = d.querySelector('[name="group_ausgabeMedium"]');
          const als = sel ? (sel.selectedOptions[0]?.text || '').trim() : '';
          job.tdA.style.color = '';
          job.tdA.replaceChildren(am
            ? markierung(`${am} (${als})`, FARBEN[als])
            : markierung('nie ausgegeben', FARBE_NIE));
        }
      } catch (e) {
        if (job.tdB) { job.tdB.style.color = '#c00'; job.tdB.textContent = 'Fehler'; }
        if (job.tdQ) { job.tdQ.style.color = '#c00'; job.tdQ.textContent = 'Fehler'; }
        if (job.tdK) { job.tdK.style.color = '#c00'; job.tdK.textContent = 'Fehler'; }
        if (job.tdA) { job.tdA.style.color = '#c00'; job.tdA.textContent = 'Fehler'; }
        if (job.tdG) { job.tdG.style.color = '#c00'; job.tdG.textContent = 'Fehler'; }
        if (job.tdP) job.tdP.forEach(c => { c.style.color = '#c00'; c.textContent = 'Fehler'; });
        if (job.tdV) job.tdV.forEach(c => { c.style.color = '#c00'; c.textContent = 'Fehler'; });
      }
    }

    async function loadCount(n) {
      if (busy) return;
      busy = true;
      const batch = jobs.slice(next, next + n);
      next += batch.length;
      updateUi();
      const queue = batch.slice();
      await Promise.all(Array.from({ length: PARALLEL }, async () => {
        while (queue.length) await load(queue.shift());
      }));
      busy = false;
      updateUi();
    }

    btnNext.addEventListener('click', () => loadCount(BLOCK));
    btnAll.addEventListener('click', () => {
      const rest = jobs.length - next;
      if (rest > 200 && !confirm(`${rest} ${cfg.wort} nachladen? Das dauert etwas.`)) return;
      loadCount(rest);
    });

    loadCount(BLOCK);
  }

  // ---- Jobticket (interner Auftragszettel fuer die Fertigung) auf der Kundenauftragsseite ----
  // Uebernommen aus dem Collmex-Lesezeichen-Widget (Stand 17.10.2026). Nur auf Klick.
  // Liest Auftrag, Lieferadresse (Reiter Versand, sonst Kundenstamm) und Warenpositionen.
  // Schreibt nichts in Collmex. Ohne Preise, ohne Positionen 9xxxxx (Dienstleistung/Versand).
  function jobticket() {
    if (!/,kach,\d+/.test(location.href)) return;
    if (!document.querySelector('[name="group_kaNr"]') || document.getElementById('dws-jt-btn')) return;
    const mandant = location.search.slice(1).split(',')[0];
    const Z_OV = 2147483646;                      // Overlay knapp unter dem Lesezeichen-Widget
    // Bevorzugt in die Collmex-Buttonreihe (vor Loeschen...), sonst fest oben rechts im Fenster
    const loeschen = document.querySelector('a.cmdbtn.loeschen');
    let azBtn;
    if (loeschen && loeschen.parentElement.tagName === 'TD') {
      azBtn = document.createElement('a');
      azBtn.className = 'cmdbtn';
      azBtn.href = '#';
      azBtn.style.cssText = 'background-image:none;padding-left:8px;color:#1d5a9e;font-weight:bold';
      const td = document.createElement('td');
      td.appendChild(azBtn);
      loeschen.parentElement.before(td);
    } else {
      azBtn = document.createElement('button');
      azBtn.type = 'button';
      azBtn.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483000;padding:8px 14px;border:1px solid #2a6ebb;' +
        'border-radius:6px;background:#fff;color:#1d5a9e;font:bold 13px Arial,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)';
      document.body.appendChild(azBtn);
    }
    azBtn.id = 'dws-jt-btn';
    azBtn.textContent = 'Jobticket';
    azBtn.title = 'Internes Jobticket ohne Preise erzeugen – schreibt nichts in Collmex';
    azBtn.addEventListener('click', e => { e.preventDefault(); oeffnen(); });

    function oeffnen() {
      function val(n, doc) {
        var e = (doc || document).querySelector('[name="' + n + '"]');
        if (!e) return '';
        if (e.tagName === 'SELECT') return (e.options[e.selectedIndex] || {}).text || '';
        return e.value || '';
      }
      function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
      function load(url) {
        return fetch(url, { credentials: 'include' }).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
          var txt = new TextDecoder('windows-1252').decode(buf);
          return new DOMParser().parseFromString(txt, 'text/html');
        });
      }
      function adresse(doc) {
        var f = function (n) { return val('addresse_' + n, doc).trim(); };
        var person = [f('adrVorname'), f('adrName')].filter(Boolean).join(' ');
        var plzOrt = [f('adrPLZOrt'), f('adrOrt')].filter(Boolean).join(' ');
        var land = f('adrLand');
        var l = [f('adrFirma'), f('adrAbteilung'), person, f('adrStrasse'), plzOrt, (land && land !== 'DE') ? land : ''].filter(Boolean);
        return { lines: l, tel: f('adrTelefon'), leer: !f('adrStrasse') && !f('adrFirma') && !f('adrName') };
      }
      var au = val('group_kaNr'), kd = val('group_kundeNr'), dat = val('group_auftragsDatum');
      var kn = '';
      var kdEl = document.querySelector('[name="group_kundeNr"]');
      if (kdEl && kdEl.parentElement && kdEl.parentElement.nextElementSibling) {
        kn = kdEl.parentElement.nextElementSibling.innerText.replace(/^\s*-\s*/, '').trim();
      }
      var firma = kn.replace(/,\s*[^,]*$/, '');
      var KUNDE_RE = /\b(Ihr|Ihre|Ihrer|Ihren|Ihrem|Ihnen|Sie)\b/;
      var rows = '', n = 0;
      for (var i = 1; i < 200; i++) {
        if (!document.querySelector('[name="pos_' + i + '_produktNr"]')) continue;
        var art = val('pos_' + i + '_produktNr').trim(), txt = val('pos_' + i + '_bezeichnung').trim();
        if (!art || /^9/.test(art)) continue; // nur Warenpositionen (9xxxxx = Dienstleistung/Versand)
        n++;
        var zeilen = txt.split('\n').map(function (z) {
          // Klammerteile, die den Kunden ansprechen, einzeln ausblenden; sonst ganze Zeile markieren
          var teile = z.split(/(\([^()]*\))/), klammerTreffer = false, inner = '';
          teile.forEach(function (t) {
            if (/^\(.*\)$/.test(t) && KUNDE_RE.test(t)) { klammerTreffer = true; inner += '<span class="z off sus" title="Klicken: ein-/ausblenden">' + esc(t) + '</span>'; }
            else inner += esc(t);
          });
          var ganz = !klammerTreffer && KUNDE_RE.test(z);
          return '<div class="z' + (ganz ? ' off sus' : '') + '" title="Klicken: Zeile ein-/ausblenden">' + inner + '</div>';
        }).join('');
        rows += '<tr class="pos"><td class="sel"><input type="checkbox" checked title="Position auf dem Jobticket"></td><td>' + esc(val('pos_' + i + '_extPos') || i) + '</td><td>' + esc(art) + '</td><td>'
          + zeilen + '</td><td>' + esc(val('pos_' + i + '_auftragsMenge') + ' ' + val('pos_' + i + '_mengeneinheit'))
          + '</td><td></td></tr>';
      }
      // Overlay-Fenster: verschiebbar (Titelleiste), skalierbar (Ecke unten rechts), Tab-Button
      var alt = document.getElementById('cmx-jt-ov'); if (alt) alt.remove();
      var ov = document.createElement('div');
      ov.id = 'cmx-jt-ov';
      ov.style.cssText = 'position:fixed;inset:0;z-index:' + Z_OV + ';background:rgba(0,0,0,.35);';
      // Position und Groesse des Vorschaufensters werden im Browser gemerkt (beim Oeffnen ins Fenster eingepasst)
      var JT_KEY = 'dws-jobticket-fenster';
      var bw = Math.min(900, window.innerWidth * 0.94), bh = window.innerHeight * 0.92;
      var bl = (window.innerWidth - bw) / 2, bt = (window.innerHeight - bh) / 2;
      try {
        var g = JSON.parse(localStorage.getItem(JT_KEY) || 'null');
        if (g && isFinite(g.l) && isFinite(g.t) && isFinite(g.w) && isFinite(g.h)) {
          bw = Math.max(420, Math.min(g.w, window.innerWidth));
          bh = Math.max(300, Math.min(g.h, window.innerHeight));
          bl = Math.max(-bw + 120, Math.min(window.innerWidth - 120, g.l));
          bt = Math.max(0, Math.min(window.innerHeight - 40, g.t));
        }
      } catch (e) {}
      var box = document.createElement('div');
      box.style.cssText = 'position:absolute;left:' + bl + 'px;top:' + bt + 'px;width:' + bw + 'px;height:' + bh + 'px;min-width:420px;min-height:300px;background:#e9ecef;border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,.4);overflow:hidden;display:flex;flex-direction:column;';
      var bar = document.createElement('div');
      bar.style.cssText = 'flex:none;display:flex;align-items:center;gap:8px;padding:6px 8px 6px 14px;background:#2a6ebb;color:#fff;font:bold 13px Arial;cursor:move;user-select:none;';
      bar.innerHTML = '<span style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">Jobticket – Vorschau</span>'
        + '<span id="cmx-jt-tab" title="In neuem Tab öffnen (inkl. aktueller Auswahl)" style="cursor:pointer;padding:3px 9px;border:1px solid rgba(255,255,255,.6);border-radius:5px;font-weight:normal;">↗ Neuer Tab</span>'
        + '<span id="cmx-jt-x" title="Schließen (Esc)" style="cursor:pointer;padding:3px 9px;font-size:15px;">✕</span>';
      var fr = document.createElement('iframe');
      fr.style.cssText = 'border:0;width:100%;flex:1;display:block;background:#e9ecef;';
      var shield = document.createElement('div');   // faengt Maus ueber dem iframe beim Ziehen/Skalieren
      shield.style.cssText = 'position:absolute;inset:0;display:none;cursor:move;';
      var grip = document.createElement('div');
      grip.title = 'Größe ändern';
      grip.style.cssText = 'position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;z-index:3;background:linear-gradient(135deg,transparent 50%,#2a6ebb 50%);border-bottom-right-radius:10px;';
      box.appendChild(bar); box.appendChild(fr); box.appendChild(shield); box.appendChild(grip); ov.appendChild(box); document.body.appendChild(ov);
      var drag = null, rsz = null;
      function bewegen(e) {
        if (rsz) {
          box.style.width = Math.max(420, rsz.w + e.clientX - rsz.x) + 'px';
          box.style.height = Math.max(300, rsz.h + e.clientY - rsz.y) + 'px';
          return;
        }
        if (!drag) return;
        var l = Math.max(-box.offsetWidth + 120, Math.min(window.innerWidth - 120, e.clientX - drag.x));
        var t = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.y));
        box.style.left = l + 'px'; box.style.top = t + 'px';
      }
      function loslassen() {
        if (drag || rsz) {
          try { localStorage.setItem(JT_KEY, JSON.stringify({ l: box.offsetLeft, t: box.offsetTop, w: box.offsetWidth, h: box.offsetHeight })); } catch (e) {}
        }
        drag = null; rsz = null; shield.style.display = 'none'; shield.style.cursor = 'move';
      }
      function esc1(e) { if (e.key === 'Escape') zu(); }
      function zu() {
        ov.remove();
        document.removeEventListener('keydown', esc1);
        document.removeEventListener('pointermove', bewegen);
        document.removeEventListener('pointerup', loslassen);
      }
      bar.querySelector('#cmx-jt-x').onclick = zu;
      document.addEventListener('keydown', esc1);
      document.addEventListener('pointermove', bewegen);
      document.addEventListener('pointerup', loslassen);
      bar.addEventListener('pointerdown', function (e) {
        if (e.target.id === 'cmx-jt-x' || e.target.id === 'cmx-jt-tab' || e.target.id === 'cmx-jt-memo') return;
        drag = { x: e.clientX - box.offsetLeft, y: e.clientY - box.offsetTop };
        shield.style.display = 'block'; e.preventDefault();
      });
      grip.addEventListener('pointerdown', function (e) {
        rsz = { x: e.clientX, y: e.clientY, w: box.offsetWidth, h: box.offsetHeight };
        shield.style.cursor = 'nwse-resize'; shield.style.display = 'block'; e.preventDefault();
      });
      var JT_SCRIPT = "(function(){var D=document;"
        // Kommentarfeld: Zeile als leer markieren, solange kein Text drinsteht (leer = nicht gedruckt)
        // Memo-Button nur in der Vorschau (dort haengt die Funktion dran), nicht im neuen Tab
        + "var mb=D.getElementById('jt-memo');if(mb&&window.parent===window)mb.style.display='none';"
        + "var k=D.querySelector('.kom-f');if(k){var chk=function(){k.closest('tr').classList.toggle('leer',!k.innerText.trim());};k.addEventListener('input',chk);chk();}"
        + "D.querySelectorAll('.z').forEach(function(z){z.onclick=function(e){e.stopPropagation();z.classList.toggle('off');};});"
        + "D.querySelectorAll('tr.pos input').forEach(function(cb){cb.onchange=function(){if(cb.checked)cb.setAttribute('checked','');else cb.removeAttribute('checked');cb.closest('tr').classList.toggle('off',!cb.checked);};});"
        + "var p=D.getElementById('jt-print');if(p)p.onclick=function(){var P=null,t;try{if(window.parent!==window){P=window.parent.document;t=P.title;P.title=D.title;}}catch(e){}"
        + "window.focus();window.print();if(P)setTimeout(function(){P.title=t;},1000);};"
        + "D.addEventListener('keydown',function(e){if(e.key==='Escape'){try{var x=window.parent.document.getElementById('cmx-jt-x');if(x&&window.parent!==window)x.click();}catch(_){}}});"
        + "})();";
      var w = fr.contentWindow;
      w.document.open(); w.document.write('<p style="font:14px Arial;padding:20px">Jobticket wird erstellt …</p>'); w.document.close();
      var base = 'https://www.collmex.de/c.cmx?' + mandant + ',1,';
      // Internes Memo (Reiter Verkauf) lesen: JT:-Zeilen werden als Kommentar vorbelegt
      var memoP = load(base + 'kachhead,' + au).then(function (d) { return memoKommentar(val('group_memo', d)); }).catch(function () { return ''; });
      load(base + 'kachshp,' + au).then(function (shp) {
        var a = adresse(shp);
        if (!a.leer) return { a: a, q: 'abweichende Lieferadresse (Collmex, Reiter Versand)' };
        return load(base + 'cuch,' + kd + ',1').then(function (cu) { return { a: adresse(cu), q: 'wie Rechnungsanschrift (Kundenstamm)' }; });
      }).catch(function () { return { a: { lines: ['– nicht ermittelbar –'], tel: '' }, q: 'Fehler beim Lesen' }; })
      .then(function (L) {
        var heute = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
        var kurz = firma.split(/\s+/)[0] || 'Kunde';
        if (!L.a.lines.length) L.a.lines = ['– nicht ermittelbar, bitte eintragen –'];
        var liefer = L.a.lines.map(esc).join('<br>') + (L.a.tel ? '<br>Tel. ' + esc(L.a.tel) : '') + '<div class="q">' + esc(L.q) + '</div>';
        var css = '@page{size:A4 portrait;margin:15mm 18mm}'
          + 'body{font:11pt Arial,sans-serif;color:#000;margin:0}'
          + '.sheet{max-width:174mm;margin:0 auto}'
          + 'h1{font-size:18pt;margin:0 0 4px}.hint{font-size:9pt;color:#555;margin-bottom:14px}'
          + 'table{border-collapse:collapse;width:100%;margin-bottom:14px}td,th{border:1px solid #888;padding:5px 7px;vertical-align:top;text-align:left}th{background:#eee}'
          + '.k td:first-child{background:#eee;font-weight:bold;width:32mm}.q{font-size:8.5pt;color:#666;margin-top:3px}'
          + '[contenteditable]{min-height:1.2em}'
          + '@media screen{body{background:#e9ecef;padding:20px}.sheet{background:#fff;padding:20px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.15)}'
          + '.bar{max-width:174mm;margin:0 auto 14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}'
          + '.bar button{font:bold 13px Arial;padding:9px 18px;border:0;border-radius:6px;background:#2a6ebb;color:#fff;cursor:pointer}'
          + '.bar span{font-size:12px;color:#444}[contenteditable]{background:#fffbe6;outline:1px dashed #d9c27a}'
          + '.z{cursor:pointer;border-radius:3px;padding:0 2px}.z:hover{background:#eef4fb}.z.off{text-decoration:line-through;color:#999}.z.sus{background:#fde8cc}'
          + 'tr.pos.off td{opacity:.35}td.sel{width:6mm;text-align:center}}'
          + '.kom-f{white-space:pre-wrap;word-break:break-word}'
          + '.memo-btn{margin-top:5px;font:normal 11px Arial;padding:3px 6px;border:1px solid #2a6ebb;border-radius:4px;background:#fff;color:#1d5a9e;cursor:pointer;white-space:nowrap}'
          + '.memo-btn:hover{background:#eef4fb}'
          + '@media print{.bar,td.sel,th.sel,.off,.q,tr.kom.leer,.memo-btn{display:none}}';
        var html = '<!doctype html><html><head><meta charset="utf-8"><title>Jobticket_AU' + esc(au) + '_' + esc(kurz) + '</title><style>' + css + '</style></head><body>'
          + '<div class="bar"><button id="jt-print">Drucken / als PDF speichern</button>'
          + '<span>Häkchen = Position drauf. Zeile anklicken = ein-/ausblenden. Orange = spricht den Kunden an, standardmäßig ausgeblendet. Gelbe Felder beschreibbar.</span></div>'
          + '<div class="sheet"><h1>Jobticket AU ' + esc(au) + '</h1>'
          + '<div class="hint">Intern – keine Preise. Erzeugt aus Collmex-Kundenauftrag ' + esc(au) + ' am ' + heute + '; Collmex unverändert.</div>'
          + '<table class="k"><tr><td>Kunde</td><td>' + esc(firma || kn) + '</td></tr><tr><td>KD-Nr.</td><td>' + esc(kd) + '</td></tr>'
          + '<tr><td>AU / Datum</td><td>AU ' + esc(au) + ' / ' + esc(dat) + '</td></tr>'
          + '<tr><td>Lieferadresse</td><td contenteditable>' + liefer + '</td></tr>'
          + '<tr><td>Start</td><td contenteditable></td></tr><tr><td>Zieltermin</td><td contenteditable></td></tr>'
          + '<tr><td>FE</td><td contenteditable></td></tr>'
          + '<tr class="kom leer"><td>Kommentar<br><button type="button" id="jt-memo" class="memo-btn" title="Kommentar als JT:-Zeilen ins interne Memo eintragen (Reiter Verkauf) – speichern musst du dort selbst">→ Internes Memo</button></td>'
          + '<td contenteditable class="kom-f"></td></tr></table>'
          + '<b>Positionen</b><table><tr><th class="sel"></th><th style="width:10mm">Pos</th><th style="width:20mm">Art.-Nr.</th><th>Bezeichnung</th><th style="width:20mm">Menge</th><th style="width:16mm">erledigt</th></tr>'
          + rows + '</table></div><script>' + JT_SCRIPT + '<\/script></body></html>';
        w.document.open(); w.document.write(html); w.document.close();
        var wd = w.document;
        wd.addEventListener('keydown', esc1);
        function alertBar(t) { bar.querySelector('span').textContent = t; }
        alertBar('Jobticket AU ' + au + ' – ' + (firma || kn));
        bar.querySelector('#cmx-jt-tab').onclick = function () {
          var nw = window.open('', '_blank');
          if (!nw) { alertBar('Popup blockiert – bitte für collmex.de erlauben'); return; }
          nw.document.open(); nw.document.write('<!doctype html>' + wd.documentElement.outerHTML); nw.document.close();
          zu();
        };
        var kom = wd.querySelector('.kom-f');
        memoP.then(function (t) {
          if (!t || !kom || kom.innerText.trim()) return;
          kom.textContent = t;
          kom.dispatchEvent(new Event('input'));
        });
        var memoBtn = wd.getElementById('jt-memo');
        if (memoBtn) memoBtn.onclick = function () {
          var text = kom ? kom.innerText.replace(/\u00a0/g, ' ').replace(/\n{2,}/g, '\n').trim() : '';
          try {
            localStorage.setItem(MEMO_KEY, JSON.stringify({ au: au, text: text, ts: Date.now() }));
          } catch (e) { alertBar('Übergabe ans Memo nicht möglich (Browser-Speicher gesperrt)'); return; }
          location.href = '/c.cmx?' + mandant + ',1,kachhead,' + au;
        };
        azBtn.textContent = 'Jobticket (' + n + ' Pos.)';
      });
    }
  }

  // ---- Jobticket-Kommentar ins interne Memo (Reiter Verkauf) eintragen ----
  // Kommentarzeilen stehen mit Praefix "JT: " unten im Memo; andere Zeilen (z. B. Bestellvermerke) bleiben unveraendert.
  // Es wird NUR das Feld auf der Seite gefuellt. Gespeichert wird erst, wenn der Benutzer in Collmex auf Speichern klickt.
  const MEMO_KEY = 'dws-jt-memo-uebergabe';
  function memoKommentar(memo) {
    return String(memo || '').split(/\r?\n/).filter(z => /^JT:/.test(z)).map(z => z.replace(/^JT:\s?/, '')).join('\n');
  }
  function memoEintragen() {
    if (!/,kachhead,\d+/.test(location.href)) return;
    let u = null;
    try { u = JSON.parse(localStorage.getItem(MEMO_KEY) || 'null'); localStorage.removeItem(MEMO_KEY); } catch (e) { return; }
    if (!u || Date.now() - u.ts > 10 * 60000) return;
    const ta = document.querySelector('[name="group_memo"]');
    const nr = document.querySelector('[name="group_kaNr"]')?.value;
    if (!ta || String(nr) !== String(u.au)) return;
    const rest = ta.value.split(/\r?\n/).filter(z => !/^JT:/.test(z)).join('\n').replace(/\s+$/, '');
    const jt = u.text ? u.text.split('\n').map(z => 'JT: ' + z.trim()).join('\n') : '';
    const neu = [rest, jt].filter(Boolean).join('\n');
    const hinweis = document.createElement('div');
    hinweis.style.cssText = 'margin:4px 0;padding:4px 8px;border-radius:4px;font:bold 12px Arial,sans-serif;';
    if (neu === ta.value) {
      hinweis.style.cssText += 'background:#dedede;color:#333';
      hinweis.textContent = 'Jobticket-Kommentar stand schon so im Memo – nichts geändert.';
    } else {
      ta.value = neu;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      ta.rows = Math.max(ta.rows, neu.split('\n').length + 1);
      ta.style.background = '#fffbe6';
      ta.style.outline = '2px solid #d9a400';
      hinweis.style.cssText += 'background:#fde8cc;color:#7a4500';
      hinweis.textContent = u.text
        ? 'Jobticket-Kommentar als JT:-Zeilen eingetragen – NOCH NICHT GESPEICHERT. Bitte prüfen und auf Speichern klicken.'
        : 'Kommentar war leer: JT:-Zeilen entfernt – NOCH NICHT GESPEICHERT. Bitte prüfen und auf Speichern klicken.';
    }
    ta.after(hinweis);
    ta.scrollIntoView({ block: 'center' });
    ta.focus();
  }

  // ---- Kundenansicht: Buttons zum direkten Anlegen von Angebot, Auftrag, Rechnung, Lieferung ----
  // Die Buttons oeffnen nur die Collmex-Seite "... anlegen" (qocr/kacr/ivcr/dvcr) mit vorbelegter Kundennummer.
  // Angelegt wird erst, wenn der Benutzer dort selbst auf "... anlegen" klickt. Das Skript schreibt nichts in Collmex.
  // Kundennummer wird per URL-Anker (#dws-kunde=<nr>) uebergeben, weil Collmex keinen URL-Parameter dafuer kennt.
  const BELEG_NEU = [
    { code: 'qocr', text: '+ Angebot',   titel: 'Neues Angebot für diesen Kunden' },
    { code: 'kacr', text: '+ Auftrag',   titel: 'Neuen Kundenauftrag für diesen Kunden' },
    { code: 'ivcr', text: '+ Rechnung',  titel: 'Neue Rechnung für diesen Kunden' },
    { code: 'dvcr', text: '+ Lieferung', titel: 'Lieferung(en) für diesen Kunden anlegen' },
  ];
  function kundenButtons() {
    const m = location.href.match(/,cuch,(\d+)/);
    if (!m || document.getElementById('dws-neu-qocr')) return;
    const kunde = m[1];
    const mandant = location.search.slice(1).split(',')[0];
    // Vor "Loeschen" in die Collmex-Buttonreihe (Loeschen ist hier ein input, kein Link)
    const loeschen = document.querySelector('.cmdbtn.loeschen') || [...document.querySelectorAll('.cmdbtn')].pop();
    if (!loeschen || loeschen.parentElement.tagName !== 'TD') return;
    const vorTd = loeschen.parentElement;
    BELEG_NEU.forEach(b => {
      const a = document.createElement('a');
      a.id = 'dws-neu-' + b.code;
      a.className = 'cmdbtn';
      a.href = `/c.cmx?${mandant},1,${b.code}#dws-kunde=${kunde}`;
      a.style.cssText = 'background-image:none;padding-left:8px;color:#1d5a9e;font-weight:bold';
      a.textContent = b.text;
      a.title = `${b.titel} (Kunde ${kunde})\nÖffnet die Anlegen-Seite – angelegt wird erst dort per Klick`;
      const td = document.createElement('td');
      td.appendChild(a);
      vorTd.before(td);
    });
  }
  // Auf der Anlegen-Seite: uebergebene Kundennummer eintragen und den Anlegen-Button hervorheben
  function belegNeuVorbelegen() {
    const m = location.hash.match(/dws-kunde=(\d+)/);
    if (!m || !/,(qocr|kacr|ivcr|dvcr)(\W|$)/.test(location.href)) return;
    history.replaceState(null, '', location.href.replace(/#.*$/, ''));
    const kunde = m[1];
    const mandant = location.search.slice(1).split(',')[0];
    const feld = document.querySelector('[name="group_kundeNr"]');
    const btn = document.querySelector('[name="anlegen"]');
    if (!feld) return;
    // Collmex belegt selbst mit dem zuletzt geoeffneten Kunden vor; weicht der ab, Nummer und angezeigten Namen ersetzen
    const nameZelle = feld.closest('td')?.nextElementSibling;
    const nameLink = nameZelle ? [...nameZelle.querySelectorAll('a')].find(a => a.textContent.trim()) : null;
    if (feld.value.trim() !== kunde) {
      feld.value = kunde;
      feld.dispatchEvent(new Event('input', { bubbles: true }));
      feld.dispatchEvent(new Event('change', { bubbles: true }));
      if (nameLink) {
        nameLink.textContent = '…';
        nameLink.href = `/c.cmx?${mandant},1,cuch,${kunde},1`;
        fetch(nameLink.href, { credentials: 'include' }).then(htmlParse).then(d => {
          const v = n => (d.querySelector(`[name="addresse_${n}"]`)?.value || '').trim();
          const name = v('adrFirma') || [v('adrVorname'), v('adrName')].filter(Boolean).join(' ');
          nameLink.textContent = [name, v('adrOrt')].filter(Boolean).join(', ') || `Kunde ${kunde}`;
        }).catch(() => { nameLink.textContent = `Kunde ${kunde}`; });
      }
    }
    feld.style.background = '#fffbe6';
    feld.style.outline = '2px solid #d9a400';
    const hinweis = document.createElement('span');
    hinweis.style.cssText = 'margin-left:10px;padding:2px 8px;border-radius:4px;background:#fde8cc;color:#7a4500;font:bold 12px Arial,sans-serif;white-space:nowrap';
    hinweis.textContent = `Kunde ${kunde} vorbelegt – zum Anlegen auf „${btn ? btn.value : 'anlegen'}“ klicken`;
    (nameZelle || feld.parentElement).appendChild(hinweis);
    if (btn) btn.focus();
  }

  // ---- Klassische Menueleiste: Ausklappmenues an den Collmex-Reitern Buchhaltung, Verkauf, Warenwirtschaft, Verwaltung ----
  // Inhalt = Kaesten der jeweiligen Bereichsseite (acc/crm/scm/settings). Gestaltung wird uebernommen:
  // Die Kaesten werden 1:1 mit Collmex' eigenen CSS-Klassen nachgebaut (Kopfzeile, Schrift, wechselnde Zeilenfarben).
  // Ebene 1 = Kasten mit allen Gruppen des Bereichs, Ebene 2 = der Original-Kasten der Gruppe.
  // Wird je Mandant im Browser gemerkt und hoechstens einmal am Tag neu gelesen (nur lesend).
  // Klick auf den Reiter selbst oeffnet wie bisher die Bereichsseite.
  // Der aktive Reiter verlinkt mit Zusatz (z. B. ...,crm,back=1), daher weitere Parameter zulassen
  const MENUE_BEREICHE = /^\/c\.cmx\?\d+,\d+,(acc|crm|scm|settings)(,[^,]*)*$/;
  const MENUE_MAX_ALTER = 24 * 3600000;
  function menueSauber(el) {
    el.querySelectorAll('script').forEach(s => s.remove());
    for (const x of [el, ...el.querySelectorAll('*')]) {
      for (const at of [...x.attributes]) {
        if (/^on/i.test(at.name) || at.name === 'id') x.removeAttribute(at.name);
        else if ((at.name === 'href' || at.name === 'src') && /^\s*javascript:/i.test(at.value)) x.removeAttribute(at.name);
      }
    }
    return el;
  }
  // Liest die Kaesten einer Bereichsseite: { gruppen: [{ titel, html }], huelle: {Klassen der umgebenden Tabelle}, breite }
  function menueAus(doc, live) {
    const boxen = [...doc.querySelectorAll('table.box')];
    const gruppen = boxen.map(box => {
      const k = menueSauber(box.cloneNode(true));
      const zeilen = [...k.rows];
      if (!zeilen.length) return null;
      zeilen.slice(1).forEach(tr => { if (!tr.querySelector('a[href]')) tr.remove(); });   // leere Fuellzeilen weg
      return { titel: zeilen[0].textContent.replace(/\s+/g, ' ').trim(), html: k.outerHTML, n: k.rows.length - 1 };
    }).filter(g => g && g.titel && g.n);
    const td = boxen[0]?.parentElement;
    const huelle = td && td.tagName === 'TD'
      ? { td: td.className, tr: td.parentElement.className, tab: td.closest('table')?.className || '' } : {};
    const breite = live && boxen[0] ? Math.round(boxen[0].getBoundingClientRect().width) : 0;
    return { gruppen, huelle, breite };
  }
  // ---- Menue Ebene 3: die letzten Belege hinter "Anzeigen und aendern" (Auftraege, Angebote, Rechnungen) ----
  // Liste = Collmex-Suche mit den unveraenderten Standardvorgaben (wie ein Klick auf Suchen), nur lesend.
  // Wird im Browser gemerkt und nach 3 Minuten beim naechsten Aufklappen im Hintergrund neu gelesen.
  const LETZTE_ANZAHL = 20;
  const LETZTE_MAX_ALTER = 3 * 60000;
  const LETZTE = {
    ka: { wort: 'Aufträge',   datum: 'Auftragsdatum', detail: 'kach', regeln: STATUS_STIL },
    qo: { wort: 'Angebote',   datum: 'Angebotsdatum', detail: 'qoch', regeln: null },
    iv: { wort: 'Rechnungen', datum: 'Datum',         detail: 'ivch', regeln: STATUS_STIL_RE },
  };
  const LETZTE_LINK = /^\/c\.cmx\?\d+,\d+,(ka|qo|iv)(,[^,]*)*$/;
  const letzteLaeuft = {};
  function letzteGemerkt(mandant, code) {
    try { return JSON.parse(localStorage.getItem(`dws-letzte:${mandant}:${code}`) || 'null'); } catch (e) { return null; }
  }
  function letzteHolen(mandant, code) {
    if (!letzteLaeuft[code]) {
      letzteLaeuft[code] = (async () => {
        const url = `/c.cmx?${mandant},1,${code}`;
        const f = (await fetch(url, { credentials: 'include' }).then(htmlParse)).querySelector('form');
        if (!f) throw new Error('kein Suchformular');
        const fd = new URLSearchParams();
        for (const e of f.elements) {
          if (!e.name || e.disabled) continue;
          if (e.type === 'submit' && e.name !== 'suchen') continue;
          if ((e.type === 'checkbox' || e.type === 'radio') && !e.checked) continue;
          fd.append(e.name, e.value);
        }
        const d = await fetch(url, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: fd.toString()
        }).then(htmlParse);
        const rows = listenZeilen(d);
        const pos = {};
        if (rows.length && rows[0].previousElementSibling) {
          let i = 0;
          for (const th of rows[0].previousElementSibling.cells) { pos[th.textContent.trim()] = i; i += th.colSpan || 1; }
        }
        const zelle = (tr, name) => {
          const idx = pos[name];
          if (idx === undefined) return '';
          let n = 0;
          for (const c of tr.cells) { if (n === idx) return c.textContent.replace(/\s+/g, ' ').trim(); n += c.colSpan || 1; }
          return '';
        };
        const cfg = LETZTE[code];
        const liste = rows.map(tr => {
          const a = tr.querySelectorAll('a')[1];
          const nr = a.textContent.trim();
          let href = a.getAttribute('href') || '';
          if (!/^\/c\.cmx\?/.test(href)) href = `/c.cmx?${mandant},1,${cfg.detail},${nr}`;
          return { nr, href, name: zelle(tr, 'Name') || zelle(tr, 'Kunde'), datum: zelle(tr, cfg.datum), status: zelle(tr, 'Status') };
        }).filter(x => /^\d+$/.test(x.nr)).sort((x, y) => y.nr - x.nr).slice(0, LETZTE_ANZAHL);
        try { localStorage.setItem(`dws-letzte:${mandant}:${code}`, JSON.stringify({ ts: Date.now(), liste })); } catch (e) {}
        return liste;
      })().finally(() => { delete letzteLaeuft[code]; });
    }
    return letzteLaeuft[code];
  }

  function menueleiste() {
    const tabs = [...document.querySelectorAll('a.topmenu')].filter(a => MENUE_BEREICHE.test(a.getAttribute('href') || ''));
    if (!tabs.length || document.getElementById('dws-menue-css')) return;
    const mandant = location.search.slice(1).split(',')[0];
    const KEY = 'dws-menue2:' + mandant;
    try { localStorage.removeItem('dws-menue:' + mandant); } catch (e) {}   // altes Format (1.39)
    let cache = null;
    try { cache = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
    if (!cache || !cache.daten || !cache.ts) cache = { daten: {}, ts: {} };
    const speichern = () => { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) {} };
    const merken = (code, d) => {
      if (!d.breite && cache.daten[code]?.breite) d.breite = cache.daten[code].breite;
      cache.daten[code] = d; cache.ts[code] = Date.now(); speichern();
    };
    // Auf einer Bereichsseite: Menue direkt aus der Seite uebernehmen (immer aktuell, mit gemessener Kastenbreite)
    const hier = ((location.pathname + location.search).match(MENUE_BEREICHE) || [])[1];
    if (hier) {
      const d = menueAus(document, true);
      if (d.gruppen.length) merken(hier, d);
    }
    const laeuft = {};
    function bereich(code) {
      const da = cache.daten[code];
      if (da && Date.now() - (cache.ts[code] || 0) < MENUE_MAX_ALTER) return Promise.resolve(da);
      if (!laeuft[code]) {
        laeuft[code] = fetch(`/c.cmx?${mandant},1,${code}`, { credentials: 'include' }).then(htmlParse).then(doc => {
          const d = menueAus(doc, false);
          if (d.gruppen.length) merken(code, d);
          return cache.daten[code] || null;
        }).catch(() => cache.daten[code] || null).finally(() => { delete laeuft[code]; });
      }
      return da ? Promise.resolve(da) : laeuft[code];   // veraltet: alten Stand zeigen, im Hintergrund erneuern
    }

    const st = document.createElement('style');
    st.id = 'dws-menue-css';
    st.textContent =
      '#dws-menue{position:absolute;z-index:100000}' +
      '#dws-menue table.dws-huelle{border-collapse:separate;border-spacing:0;margin:0}' +
      '#dws-menue table.dws-huelle>tbody>tr>td{padding:0;vertical-align:top}' +
      '#dws-menue .dws-kasten{box-shadow:2px 3px 9px rgba(0,0,0,.28);margin:0}' +
      '#dws-menue tr.dws-z:hover,#dws-menue tr.dws-z:hover>td,#dws-menue tr.dws-aktiv,#dws-menue tr.dws-aktiv>td' +
      '{background-color:#fbe3b8!important;background-image:none!important}' +
      '#dws-menue .dws-pfeil{float:right;margin-left:14px;color:#888}' +
      '#dws-menue a.dws-hier{font-weight:bold}' +
      '#dws-menue td.menulink{white-space:nowrap}' +
      '#dws-menue .dws-belzeile{display:flex;align-items:center;gap:8px}' +
      '#dws-menue a.dws-beleg{flex:1 1 auto;min-width:0;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none}' +
      '#dws-menue .dws-beldatum{flex:none;margin-left:auto;padding-left:10px;color:#777}' +
      '#dws-menue .dws-belstatus{flex:none;display:inline-block;width:12px;height:12px;box-sizing:border-box;border-radius:2px;padding:0!important}' +
      '#dws-menue a.dws-neutab{display:inline-block;margin:0 3px 0 -6px;padding:0 5px;border-radius:3px;color:#666;text-decoration:none;font-weight:bold}' +
      '#dws-menue a.dws-neutab:hover{background:#e0b870;color:#000}' +
      '#dws-menue .dws-laden{background:#fff;border:1px solid #bbb;padding:5px 10px;font:13px arial,helvetica,sans-serif;color:#555;white-space:nowrap}';
    document.head.appendChild(st);

    const hierUrl = location.pathname + location.search;
    const ausHtml = html => { const t = document.createElement('template'); t.innerHTML = html; return t.content.firstElementChild; };
    // Kasten in dieselbe Umgebung wie auf der Bereichsseite setzen, damit Collmex' CSS genauso greift
    function huelle(d, kasten) {
      const h = d.huelle || {};
      const t = document.createElement('table');
      t.className = ((h.tab || '') + ' dws-huelle').trim();
      const tr = t.createTBody().insertRow();
      if (h.tr) tr.className = h.tr;
      const td = tr.insertCell();
      if (h.td) td.className = h.td;
      kasten.classList.add('dws-kasten');
      if (d.breite) kasten.style.minWidth = d.breite + 'px';   // Mindestbreite wie auf der Bereichsseite, darf wachsen
      td.append(kasten);
      return t;
    }
    function textErsetzen(el, alt, neu) {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n, letzter = null;
      while ((n = w.nextNode())) {
        if (n.data.replace(/\s+/g, ' ').trim() === alt) { n.data = neu; return; }
        if (n.data.trim()) letzter = n;
      }
      if (letzter) letzter.data = neu;
    }
    // Ebene 1: Kasten im Collmex-Stil mit einer Zeile je Gruppe
    function hauptKasten(d, code, name) {
      const vorlage = d.gruppen.find(g => g.n >= 2) || d.gruppen[0];
      const k = ausHtml(vorlage.html);
      const zeilen = [...k.rows];
      const kopf = zeilen[0];
      const muster = zeilen.slice(1, 3);
      textErsetzen(kopf, vorlage.titel, name);
      kopf.querySelectorAll('img').forEach(i => i.remove());
      // Symbol der Vorlage (Hintergrundbild der Ueberschrift h4) gehoert nicht zum Bereich
      kopf.querySelectorAll('h4').forEach(h => { h.style.backgroundImage = 'none'; h.style.paddingLeft = '10px'; });
      zeilen.slice(1).forEach(r => r.remove());
      d.gruppen.forEach((g, i) => {
        const m = muster[i % muster.length];
        const tr = m.cloneNode(true);
        tr.className = m.className;
        const a = tr.querySelector('a');
        a.textContent = g.titel;
        a.href = `/c.cmx?${mandant},1,${code}`;
        a.removeAttribute('target');
        const pf = document.createElement('span');
        pf.className = 'dws-pfeil';
        pf.textContent = '▸';
        a.parentElement.prepend(pf);
        tr.classList.add('dws-z');
        kopf.parentElement.append(tr);
      });
      return k;
    }

    let menue = null, offenFuer = null, zuTimer = null, aufTimer = null;
    const schliessen = () => { if (menue) menue.remove(); menue = null; offenFuer = null; };
    const spaeterZu = () => { clearTimeout(aufTimer); clearTimeout(zuTimer); zuTimer = setTimeout(schliessen, 350); };

    function aufbauen(box, d, code, name) {
      box.textContent = '';
      if (!d || !d.gruppen.length) {
        const a = document.createElement('a');
        a.className = 'dws-laden';
        a.style.display = 'block';
        a.href = `/c.cmx?${mandant},1,${code}`;
        a.textContent = 'Menü nicht lesbar – Bereichsseite öffnen';
        box.append(a);
        return;
      }
      const haupt = hauptKasten(d, code, name);
      const ebene1 = huelle(d, haupt);
      box.append(ebene1);
      let flyout = null, aktiv = null;
      let ebene3 = null, e3Zeile = null;
      const letzteZu = () => {
        if (ebene3) ebene3.remove();
        ebene3 = null;
        if (e3Zeile) e3Zeile.classList.remove('dws-aktiv');
        e3Zeile = null;
      };
      // Ebene 3: Kasten im Stil der Gruppe mit den letzten Belegen, rechts neben der Zeile "Anzeigen und aendern"
      function letzteZeigen(zeile, lc, gruppe) {
        if (e3Zeile === zeile) return;
        letzteZu();
        e3Zeile = zeile; zeile.classList.add('dws-aktiv');
        const cfg = LETZTE[lc];
        const listenHref = zeile.querySelector('td.menulink a[href]:not(.dws-neutab)').getAttribute('href');
        const k = ausHtml(gruppe.html);
        const zeilen = [...k.rows];
        const kopf = zeilen[0];
        const muster = zeilen.length > 2 ? zeilen.slice(1, 3) : [zeilen[1] || kopf];
        textErsetzen(kopf, gruppe.titel, `Letzte ${LETZTE_ANZAHL} ${cfg.wort}`);
        zeilen.slice(1).forEach(r => r.remove());
        const tbody = kopf.parentElement;
        const neueZeile = (i, fuellen) => {
          const tr = muster[i % muster.length].cloneNode(true);
          const td = tr.cells[0];
          td.textContent = '';
          td.className = 'menulink';
          for (let c = tr.cells.length - 1; c > 0; c--) tr.deleteCell(c);
          fuellen(td);
          tr.classList.add('dws-z');
          tbody.append(tr);
        };
        const zeichnen = liste => {
          [...k.rows].slice(1).forEach(r => r.remove());
          if (liste === null) {
            neueZeile(0, td => { td.style.color = '#777'; td.append(spinner(), ` ${cfg.wort} werden geladen …`); });
          } else if (liste === false) {
            neueZeile(0, td => { td.style.color = '#c00'; td.textContent = 'Liste nicht lesbar'; });
          } else {
            liste.forEach((b, i) => neueZeile(i, td => {
              // Raster: Knopf | Nummer + Name (gekuerzt) | Datum | Statusquadrat (Farben wie in den Listen)
              const z = document.createElement('div');
              z.className = 'dws-belzeile';
              const nt = document.createElement('a');
              nt.className = 'dws-neutab';
              nt.href = b.href; nt.target = '_blank'; nt.rel = 'noopener';
              nt.textContent = '↗';
              nt.title = `${b.nr} in neuem Tab öffnen`;
              const a = document.createElement('a');
              a.className = 'dws-beleg' + (b.href === hierUrl ? ' dws-hier' : '');
              a.href = b.href;
              a.textContent = `${b.nr}  ${b.name}`;
              a.title = `${b.nr} – ${b.name}${b.datum ? '\n' + b.datum : ''}${b.status ? '\n' + b.status : ''}`;
              const dat = document.createElement('span');
              dat.className = 'dws-beldatum';
              dat.textContent = b.datum || '';
              const q = document.createElement('span');
              q.className = 'dws-belstatus';
              const regel = b.status && cfg.regeln && cfg.regeln.find(r => r.test(b.status));
              // Streifen fuer das kleine Quadrat enger machen
              // Rand in der Schriftfarbe der Regel (currentColor), damit die hellen Farben sichtbar sind
              q.style.cssText = regel ? 'border:1px solid currentColor;' + regel.stil.replace(/7px/g, '2px').replace(/14px/g, '4px')
                : (b.status ? 'border:1px solid #999;background:#fff' : 'visibility:hidden');
              q.title = b.status || '';
              z.append(nt, a, dat, q);
              td.append(z);
            }));
            if (!liste.length) neueZeile(0, td => { td.style.color = '#777'; td.textContent = `Keine ${cfg.wort} gefunden`; });
          }
          neueZeile(k.rows.length - 1, td => {
            const a = document.createElement('a');
            a.href = listenHref;
            a.textContent = `Alle ${cfg.wort} anzeigen …`;
            a.style.fontStyle = 'italic';
            td.append(a);
          });
        };
        const e3 = huelle(d, k);
        e3.style.position = 'absolute';
        ebene3 = e3;
        const plaziere = () => {
          if (ebene3 !== e3 || !flyout) return;
          const br = box.getBoundingClientRect(), fr = flyout.getBoundingClientRect(), zr = zeile.getBoundingClientRect();
          const kopfH = kopf.getBoundingClientRect().height;
          e3.style.left = (fr.right - br.left - 1) + 'px';
          let top = zr.top - br.top - kopfH;
          e3.style.top = top + 'px';
          let er = e3.getBoundingClientRect();
          if (er.right > document.documentElement.clientWidth - 4) e3.style.left = (fr.left - br.left - er.width + 1) + 'px';
          if (er.bottom > window.innerHeight - 4) top -= er.bottom - (window.innerHeight - 4);
          e3.style.top = Math.max(top, 4 - br.top) + 'px';
        };
        const gem = letzteGemerkt(mandant, lc);
        zeichnen(gem && Array.isArray(gem.liste) ? gem.liste : null);
        box.append(e3);
        plaziere();
        if (!gem || Date.now() - (gem.ts || 0) > LETZTE_MAX_ALTER) {
          letzteHolen(mandant, lc)
            .then(l => { if (ebene3 === e3) { zeichnen(l); plaziere(); } })
            .catch(() => { if (ebene3 === e3 && !(gem && gem.liste)) { zeichnen(false); plaziere(); } });
        }
      }
      [...haupt.rows].slice(1).forEach((tr, i) => {
        tr.addEventListener('mouseenter', () => {
          if (aktiv === tr) return;
          if (aktiv) aktiv.classList.remove('dws-aktiv');
          aktiv = tr; tr.classList.add('dws-aktiv');
          letzteZu();
          if (flyout) flyout.remove();
          const sub = ausHtml(d.gruppen[i].html);
          [...sub.rows].slice(1).forEach(r => r.classList.add('dws-z'));
          sub.querySelectorAll('a[href]').forEach(a => { if (a.getAttribute('href') === hierUrl) a.classList.add('dws-hier'); });
          // Vor jedem Eintrag: kleiner Knopf, der den Eintrag in einem neuen Tab oeffnet
          sub.querySelectorAll('td.menulink a[href]').forEach(a => {
            const nt = document.createElement('a');
            nt.className = 'dws-neutab';
            nt.href = a.getAttribute('href');
            nt.target = '_blank';
            nt.rel = 'noopener';
            nt.textContent = '↗';
            nt.title = `${a.textContent.trim()} in neuem Tab öffnen`;
            a.before(nt);   // direkt vor den Link (Kasten Vertrag hat zwei Links je Zeile)
          });
          flyout = huelle(d, sub);
          flyout.style.position = 'absolute';
          flyout.style.left = (ebene1.offsetWidth - 1) + 'px';
          box.append(flyout);
          // erste Zeile des Untermenues auf Hoehe der gewaehlten Zeile
          const kopfH = sub.rows[0].getBoundingClientRect().height;
          flyout.style.top = Math.max(0, tr.getBoundingClientRect().top - box.getBoundingClientRect().top - kopfH) + 'px';
          if (flyout.getBoundingClientRect().right > document.documentElement.clientWidth - 4) {
            flyout.style.left = 'auto';
            flyout.style.right = (ebene1.offsetWidth - 1) + 'px';
          }
          // Zeilen mit einer Belegliste (Anzeigen und aendern bei Angebot, Auftrag, Rechnung) bekommen ein Untermenue
          const gruppe = d.gruppen[i];
          [...sub.rows].slice(1).forEach(r => {
            const lc = [...r.querySelectorAll('td.menulink a[href]:not(.dws-neutab)')]
              .map(a => (a.getAttribute('href').match(LETZTE_LINK) || [])[1]).find(Boolean);
            if (lc) {
              const pf = document.createElement('span');
              pf.className = 'dws-pfeil';
              pf.textContent = '▸';
              r.cells[0].prepend(pf);
            }
            r.addEventListener('mouseenter', () => { if (lc) letzteZeigen(r, lc, gruppe); else letzteZu(); });
          });
        });
      });
    }

    function oeffnen(tab, code) {
      clearTimeout(zuTimer);
      if (offenFuer === tab) return;
      schliessen();
      const box = document.createElement('div');
      box.id = 'dws-menue';
      const r = tab.getBoundingClientRect();
      box.style.left = (window.scrollX + r.left) + 'px';
      box.style.top = (window.scrollY + r.bottom - 1) + 'px';
      const laden = document.createElement('div');
      laden.className = 'dws-laden';
      laden.append(spinner(), ' Menü wird geladen …');
      box.append(laden);
      box.addEventListener('mouseenter', () => clearTimeout(zuTimer));
      box.addEventListener('mouseleave', spaeterZu);
      document.body.appendChild(box);
      menue = box; offenFuer = tab;
      bereich(code).then(d => { if (menue === box) aufbauen(box, d, code, tab.textContent.trim()); });
    }

    tabs.forEach(tab => {
      const code = (tab.getAttribute('href').match(MENUE_BEREICHE) || [])[1];
      tab.addEventListener('mouseenter', () => {
        clearTimeout(zuTimer); clearTimeout(aufTimer);
        aufTimer = setTimeout(() => oeffnen(tab, code), menue ? 0 : 120);   // kurze Verzoegerung gegen versehentliches Aufklappen
      });
      tab.addEventListener('mouseleave', spaeterZu);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') schliessen(); });
    document.addEventListener('click', e => { if (menue && !menue.contains(e.target)) schliessen(); });
    // Fehlende/veraltete Bereiche nacheinander im Hintergrund vorladen, damit das Menue sofort da ist
    let n = 0;
    tabs.forEach(tab => {
      const code = (tab.getAttribute('href').match(MENUE_BEREICHE) || [])[1];
      if (code !== hier) setTimeout(() => bereich(code), 1500 + 700 * n++);
    });
  }

  titelUmbrueche();
  memoEintragen();
  zebra();
  statusFarben();
  run();
  spaltenbreiten();
  kompaktSchalter();
  jobticket();
  kundenButtons();
  belegNeuVorbelegen();
  menueleiste();
  produktVorschlag();
})();
