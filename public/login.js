// Página de login / creación del administrador (sin scripts incrustados, por la CSP)
const SETUP = document.body.dataset.setup === 'true';
const $ = (s) => document.querySelector(s);
if (SETUP) {
  $('#title').textContent = 'Creá tu usuario administrador';
  $('#subtitle').textContent = 'Es el primer ingreso: elegí el usuario y la contraseña con los que vas a entrar al panel.';
  $('#setup-extra').hidden = false;
  $('#pass').autocomplete = 'new-password';
  $('#go').textContent = 'Crear usuario y entrar';
}
const showError = (msg) => { $('#error').textContent = msg; $('#error').style.display = 'block'; };
$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#error').style.display = 'none';
  if (SETUP && $('#pass').value !== $('#pass2').value) return showError('Las contraseñas no coinciden.');
  $('#go').disabled = true;
  try {
    const res = await fetch(SETUP ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#user').value.trim(), password: $('#pass').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
    location.href = '/';
  } catch (err) { showError(err.message); $('#go').disabled = false; }
});
