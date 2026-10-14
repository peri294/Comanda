import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { X, Printer, QrCode } from 'lucide-react';
import { tableClientUrl } from '../config';
import { QR_CAPTION } from './TableQrModal';

const absoluteUrl = (table) => `${window.location.origin}${window.location.pathname}${tableClientUrl(table.id, table.qrToken)}`;

// QR de todas las mesas, una por hoja, para imprimir de una vez al instalar el sistema
// (o después de agregar mesas). Mismo QR y misma hoja que TableQrModal.
export default function PrintAllQrsModal({ tables, onClose }) {
  const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="glass-panel modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
          <div className="modal-header">
            <h3 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <QrCode size={22} style={{ color: 'var(--accent-gold)' }} /> Imprimir QR de las mesas
            </h3>
            <button className="modal-close" onClick={onClose} aria-label="Cerrar">
              <X size={24} />
            </button>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '12px' }}>
            Sale una hoja por mesa ({tables.length} en total) con su número y su QR. El QR no cambia:
            se imprime una vez y queda en la mesa. Si regenerás el QR de una mesa, imprimí solo esa
            desde el botón de QR de su tarjeta.
          </p>
          {isLocalhost && (
            <p style={{ color: 'var(--warning)', fontSize: '0.8rem', marginTop: '12px' }}>
              Estás en localhost: estos QR solo abren en esta PC. Imprimilos desde la dirección
              con la que entran los celulares (la del servidor del local).
            </p>
          )}
          <button className="btn-primary" style={{ width: '100%', marginTop: '16px', justifyContent: 'center' }} onClick={() => window.print()}>
            <Printer size={16} /> Imprimir {tables.length} QR
          </button>
        </div>
      </div>

      {/* Hojas que salen al imprimir: fuera de #root, como en TableQrModal */}
      {createPortal(
        <>
          {tables.map(table => (
            <div key={table.id} className="qr-print-sheet qr-print-page">
              <div className="qr-print-title">Mesa {table.id}</div>
              <QRCodeSVG value={absoluteUrl(table)} size={320} level="M" marginSize={2} title={`QR de la Mesa ${table.id}`} />
              <div className="qr-print-caption">{QR_CAPTION}</div>
            </div>
          ))}
        </>,
        document.body
      )}
    </>
  );
}
