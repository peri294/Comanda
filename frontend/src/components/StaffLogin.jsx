import { useState } from 'react';
import { Lock, ChefHat, Monitor } from 'lucide-react';

const ROLE_META = {
  kitchen: { label: 'Cocina', icon: ChefHat },
  counter: { label: 'Mostrador', icon: Monitor }
};

export default function StaffLogin({ role, onLogin, error, loading }) {
  const [password, setPassword] = useState('');
  const meta = ROLE_META[role] || { label: role, icon: Lock };
  const Icon = meta.icon;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (password) onLogin(password);
  };

  return (
    <div className="animate-fade-in" style={{ maxWidth: '380px', margin: '80px auto' }}>
      <div className="glass-panel" style={{ padding: '32px', textAlign: 'center' }}>
        <Icon size={40} style={{ color: 'var(--accent-gold)', marginBottom: '12px' }} />
        <h2 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: '4px' }}>Acceso {meta.label}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '20px' }}>
          Ingresá la contraseña del personal para continuar.
        </p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Contraseña"
            autoFocus
            style={{
              padding: '12px',
              borderRadius: '10px',
              background: 'rgba(0, 0, 0, 0.2)',
              border: '1px solid var(--border-color)',
              color: 'white',
              outline: 'none',
              fontFamily: 'var(--font-main)',
              textAlign: 'center',
              fontSize: '1rem'
            }}
          />
          {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
          <button className="btn-primary" type="submit" disabled={loading} style={{ justifyContent: 'center' }}>
            {loading ? 'Ingresando...' : 'Ingresar'}
          </button>
        </form>
      </div>
    </div>
  );
}
