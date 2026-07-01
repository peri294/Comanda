import { useState, useCallback } from 'react';

const storageKey = (role) => `auth_token_${role}`;

// Sesión de personal (cocina/mostrador) con contraseña compartida por rol.
// El token se guarda en localStorage para no pedir login en cada carga de página.
export function useStaffAuth(role) {
  const [token, setToken] = useState(() => localStorage.getItem(storageKey(role)));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const login = useCallback(async (password) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('http://localhost:3001/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo iniciar sesión');

      localStorage.setItem(storageKey(role), data.token);
      setToken(data.token);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [role]);

  // Se llama también cuando el server rechaza el token (ej. se reinició y perdió
  // las sesiones en memoria), para volver a mostrar el login.
  const logout = useCallback(() => {
    localStorage.removeItem(storageKey(role));
    setToken(null);
  }, [role]);

  return { token, login, logout, error, loading };
}
