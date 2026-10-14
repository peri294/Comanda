import { useState } from 'react';
import { Settings, X } from 'lucide-react';

// Mismo tope que el server (MAX_BUSINESS_NAME_LENGTH en domain.js).
const MAX_BUSINESS_NAME_LENGTH = 60;

const inputStyle = {
  padding: '10px', borderRadius: '8px', background: 'rgba(0, 0, 0, 0.2)',
  border: '1px solid var(--border-color)', color: 'white', fontFamily: 'var(--font-main)', fontSize: '0.9rem'
};

// Configuración del local desde el Mostrador. El cambio no se aplica acá: el server lo
// guarda y lo difunde con settings-updated a todas las pantallas (esta incluida).
export default function SettingsModal({ socket, businessName, onClose }) {
  const [name, setName] = useState(businessName);
  const trimmed = name.trim();
  const unchanged = trimmed === businessName;

  const submit = (e) => {
    e.preventDefault();
    if (!trimmed || unchanged) return;
    socket.emit('update-settings', { businessName: trimmed });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="glass-panel modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
        <div className="modal-header">
          <h3 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Settings size={22} style={{ color: 'var(--accent-gold)' }} /> Configuración
          </h3>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar configuración">
            <X size={24} />
          </button>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '15px' }}>
          <label htmlFor="business-name" style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--accent-gold)' }}>
            Nombre del local
          </label>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
            Se muestra en el encabezado de todas las pantallas, incluidas las mesas de los clientes.
          </p>
          <input
            id="business-name"
            value={name}
            maxLength={MAX_BUSINESS_NAME_LENGTH}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
          <button type="submit" className="btn-primary" disabled={!trimmed || unchanged} style={{ padding: '10px', fontSize: '0.9rem' }}>
            {unchanged ? 'Guardado' : 'Guardar Nombre'}
          </button>
        </form>
      </div>
    </div>
  );
}
