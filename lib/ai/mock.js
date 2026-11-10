'use strict';
// Tryb testowy: deterministyczne odpowiedzi agentów zbudowane z rzeczywistych danych systemu MXT.
// Nie wywołuje modelu i nie generuje kosztów. Każda odpowiedź jest wyraźnie oznaczona jako symulowana.
const TAG = '[Tryb testowy – odpowiedź symulowana, bez wywołania modelu Claude]';
const zl = n => new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 }).format(n);

function sums(d) {
  const by = st => d.wnioski.filter(w => w.status === st);
  const total = rows => rows.reduce((s, w) => s + (w.waluta === 'PLN' ? w.kwota : 0), 0);
  return { oczekuje: by('oczekuje').reduce((s, w) => s + w.liczba, 0), kwotaOczek: total(by('oczekuje')), kwotaZatw: total(by('zatwierdzona')) + total(by('wykonana')) };
}

function reply({ agent, kind, stage, topic, context, data, prior, message, promptVersion }) {
  const z = data.zadania, s = sums(data), dz = data.dzialy || {}, head = `${TAG}\n${agent.name} · prompt v${promptVersion}\n\n`;
  const deps = data.zadania_wg_dzialow.map(r => `${r.dzial}: ${r.otwarte} otwartych${r.po_terminie ? `, ${r.po_terminie} po terminie` : ''}`).join('; ') || 'brak otwartych zadań';
  if (kind === 'test_promptu') {
    return head + `Otrzymałem wiadomość: „${String(message).slice(0, 300)}”.\nOdpowiadam zgodnie z roboczym promptem (${promptVersion === 'robocza' ? 'wersja niezapisana' : 'wersja ' + promptVersion}). ` +
      `W trybie rzeczywistym w tym miejscu odpowie Claude. Test nie wykonuje żadnych operacji w systemie.`;
  }
  if (kind === 'posiedzenie' && stage === 'otwarcie') {
    return head + `Otwieram posiedzenie Zarządu AI.\nTemat: ${topic}\n${context ? 'Kontekst od administratora: ' + context + '\n' : ''}\nStan firmy na ${data.dzis}:\n` +
      `- zadania otwarte: ${z.otwarte} (po terminie: ${z.po_terminie}, pilne: ${z.pilne}),\n- wnioski oczekujące na decyzję: ${s.oczekuje} na łączną kwotę ${zl(s.kwotaOczek)} PLN.\n\n` +
      `Proszę CFO o ocenę finansową, COO o wpływ na operacje, CSO o wpływ na sprzedaż.`;
  }
  if (kind === 'posiedzenie' && stage === 'stanowisko') {
    if (agent.id === 'cfo') return head + `Stanowisko CFO w sprawie: ${topic}\n- Wnioski oczekujące: ${s.oczekuje}, łącznie ${zl(s.kwotaOczek)} PLN; zatwierdzone i wykonane: ${zl(s.kwotaZatw)} PLN.\n` +
      `- Finanse od początku roku: przychody ${zl(dz.przychod_rok || 0)} PLN, koszty ${zl(dz.koszt_rok || 0)} PLN, marża ${zl((dz.przychod_rok || 0) - (dz.koszt_rok || 0))} PLN.\n- Warunek poparcia: koszt mieści się w budżecie i przechodzi przez Approval Center.`;
    if (agent.id === 'coo') return head + `Stanowisko COO w sprawie: ${topic}\n- Obciążenie działów: ${deps}.\n- ${z.po_terminie ? `Najpierw domknąć ${z.po_terminie} zadań po terminie.` : 'Brak zaległości – zespół ma przestrzeń na wdrożenie.'}\n` +
      `- Plan: zadanie wdrożeniowe w Workflow z terminem i osobą odpowiedzialną, przegląd postępu co tydzień.`;
    return head + `Stanowisko CSO w sprawie: ${topic}\n- Sprzedaż: ${dz.oferty_w_toku || 0} ofert w toku, ${dz.budynki || 0} obsługiwanych budynków (dane z CRM i działów).\n` +
      `- Założenie (do weryfikacji): decyzja może wzmocnić ofertę działów 1 i 2.\n- Miernik sukcesu: liczba nowych ofert i klientów w kolejnym kwartale.`;
  }
  if (kind === 'posiedzenie' && stage === 'rekomendacja') {
    const who = (prior || []).map(p => p.agent).join(', ') || 'brak stanowisk';
    return head + `Rekomendacja Zarządu AI\nTemat: ${topic}\nUwzględnione stanowiska: ${who}.\n\n` +
      `Rekomenduję: przyjąć kierunek pod warunkiem zatwierdzenia budżetu w Approval Center${z.po_terminie ? ` i wcześniejszego domknięcia ${z.po_terminie} zaległych zadań` : ''}.\n` +
      `Ryzyka: ${dz.reklamacje_otwarte ? dz.reklamacje_otwarte + ' otwartych reklamacji' : 'brak istotnych zaległości'}; decyzja wymaga potwierdzenia budżetu.\nKolejne kroki: zadanie wdrożeniowe dla odpowiedzialnego działu, przegląd za 2 tygodnie.\n` +
      `Decyzję podejmuje administrator.`;
  }
  if (kind === 'raport') {
    return head + `Raport Zarządu AI – ${data.dzis}\n\n1. Operacje: ${z.otwarte} zadań otwartych, ${z.po_terminie} po terminie, ${z.pilne} pilnych, ${z.zakonczone_7d} zakończonych w 7 dni.\n` +
      `2. Zadania wg działów: ${deps}.\n3. Podzielniki i Montaże: ${dz.budynki || 0} budynków, ${dz.urzadzenia || 0} urządzeń, ${dz.montaze_14d || 0} montaży w 14 dni, ${dz.reklamacje_otwarte || 0} otwartych reklamacji.\n` +
      `4. Sprzedaż: ${dz.oferty_w_toku || 0} ofert w toku. Finanse od początku roku: przychody ${zl(dz.przychod_rok || 0)} PLN, koszty ${zl(dz.koszt_rok || 0)} PLN.\n` +
      `5. Decyzje: ${s.oczekuje} wniosków czeka na administratora (${zl(s.kwotaOczek)} PLN).\n6. Rekomendacja: ${z.po_terminie ? 'priorytet dla zaległych zadań' : dz.reklamacje_otwarte ? 'domknąć otwarte reklamacje' : 'utrzymać tempo'}.`;
  }
  if (String(topic || '').startsWith('Szkic odpowiedzi')) {
    const lang = (/język: (\w+)/.exec(context || '') || [])[1] || 'pl';
    const T = { de: 'Guten Tag,\n\nvielen Dank für Ihre Nachricht. Wir prüfen Ihre Anfrage und melden uns mit einer verbindlichen Antwort [Termin/Preis – bitte durch Mitarbeiter bestätigen].\n\nMit freundlichen Grüßen\nMXT',
      en: 'Dear Sir or Madam,\n\nthank you for your message. We are checking your request and will get back to you with a binding answer [date/price – to be confirmed by staff].\n\nKind regards\nMXT',
      pl: 'Dzień dobry,\n\ndziękujemy za wiadomość. Sprawdzamy zapytanie i wrócimy z wiążącą odpowiedzią [termin/cena – do potwierdzenia przez pracownika].\n\nZ poważaniem\nMXT' };
    return `${TAG}\n\n${T[lang] || T.en}`;
  }
  // zadanie przydzielone agentowi
  return head + `Zadanie: ${topic}\n${context ? 'Opis: ' + context + '\n' : ''}\nAnaliza (${agent.title}): na podstawie danych systemu – ${z.otwarte} otwartych zadań, ${s.oczekuje} wniosków w toku.\n` +
    `Propozycja: przygotuję szkic rozwiązania; operacje wiążące zgłoszę do Approval Center, gdzie zatwierdzi je administrator.`;
}

module.exports = { reply, TAG };
