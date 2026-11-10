'use strict';
// Polityka haseł MXT. Te same reguły sprawdza serwer (wiążąco) i ekran zmiany hasła (podpowiedź na żywo).
const WEAK = ['1234', '12345', '123456', '1234567', '12345678', '123456789', '1234567890', 'qwerty', 'qwerty123', 'password', 'password1', 'haslo', 'haslo123',
  'mxt', 'mxt123', 'mxt2026', 'admin', 'admin123', 'zaq12wsx', 'qwertyuiop', 'abc123', '1q2w3e4r', '1qaz2wsx', 'polska', 'polska123'];

// Zwraca listę niespełnionych wymagań (pusta = hasło poprawne).
function problems(pass, { login = '', current = '' } = {}) {
  const p = String(pass || ''), out = [];
  if (p.length < 10) out.push('co najmniej 10 znaków');
  if (p.length > 200) out.push('najwyżej 200 znaków');
  if (!/[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/.test(p)) out.push('co najmniej jedna litera');
  if (!/\d/.test(p)) out.push('co najmniej jedna cyfra');
  const low = p.toLowerCase(), l = String(login || '').toLowerCase();
  if (WEAK.some(w => low === w || low.startsWith(w) && low.length - w.length < 3)) out.push('nie może być popularnym hasłem');
  if (l && (low.includes(l) || low.includes(l.replace(/\./g, '')))) out.push('nie może zawierać loginu');
  if (current && p === current) out.push('musi różnić się od obecnego');
  return out;
}

module.exports = { problems };
