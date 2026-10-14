import { useState } from 'react';
import { Settings, X, ImagePlus, Download } from 'lucide-react';
import { uploadImage, IMAGE_PRESETS } from '../utils/images';
import { BACKEND_URL } from '../config';

// Mismo tope que el server (MAX_BUSINESS_NAME_LENGTH en domain.js).
const MAX_BUSINESS_NAME_LENGTH = 60;

const inputStyle = {
  padding: '10px', borderRadius: '8px', background: 'rgba(0, 0, 0, 0.2)',
  border: '1px solid var(--border-color)', color: 'white', fontFamily: 'var(--font-main)', fontSize: '0.9rem'
};

// Configuración del local desde el Mostrador. El cambio no se aplica acá: el server lo
// guarda y lo difunde con settings-updated a todas las pantallas (esta incluida).
export default function SettingsModal({ socket, token, businessName, logoUrl, onClose }) {
  const [name, setName] = useState(businessName);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [backupState, setBackupState] = useState('');
  const trimmed = name.trim();
  const unchanged = trimmed === businessName;

  const submit = (e) => {
    e.preventDefault();
    if (!trimmed || unchanged) return;
    socket.emit('update-settings', { businessName: trimmed });
  };

  const chooseLogo = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setUploading(true);
    try {
      const id = await uploadImage(file, token, IMAGE_PRESETS.logo);
      socket.emit('update-settings', { logoImageId: id });
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  // La copia viene por fetch (lleva el token de sesión) y se guarda como archivo.
  const downloadBackup = async () => {
    setBackupState('Generando copia…');
    try {
      const res = await fetch(`${BACKEND_URL}/api/backup`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error();
      const filename = res.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/)?.[1] || 'comanda.db';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setBackupState(`Copia descargada: ${filename}`);
    } catch {
      setBackupState('No se pudo generar la copia. Probá de nuevo.');
    }
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '24px' }}>
          <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--accent-gold)' }}>Logo</span>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
            Reemplaza al ícono de la taza en el encabezado. Mejor una imagen cuadrada o apaisada con fondo transparente.
          </p>
          {error && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: 0 }}>{error}</p>}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {logoUrl && <img src={logoUrl} alt="Logo actual" style={{ height: '48px', maxWidth: '120px', objectFit: 'contain' }} />}
            <label className="btn-secondary" style={{ padding: '8px 12px', fontSize: '0.8rem', cursor: 'pointer' }}>
              <ImagePlus size={14} /> {uploading ? 'Subiendo…' : logoUrl ? 'Cambiar logo' : 'Subir logo'}
              <input type="file" accept="image/*" onChange={chooseLogo} disabled={uploading} hidden data-testid="logo-input" />
            </label>
            {logoUrl && (
              <button type="button" className="btn-secondary" style={{ padding: '8px 12px', fontSize: '0.8rem' }}
                onClick={() => socket.emit('update-settings', { logoImageId: null })}>
                Quitar logo
              </button>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '24px' }}>
          <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--accent-gold)' }}>Copia de seguridad</span>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
            Un archivo con todo: menú, fotos, mesas, ventas y cierres de caja. Conviene descargarla
            una vez por semana y guardarla fuera de esta computadora.
          </p>
          <button type="button" className="btn-secondary" style={{ padding: '10px', fontSize: '0.85rem', justifyContent: 'center' }} onClick={downloadBackup}>
            <Download size={14} /> Descargar copia de seguridad
          </button>
          {backupState && <p role="status" style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0 }}>{backupState}</p>}
        </div>
      </div>
    </div>
  );
}
