import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { X, Printer, ExternalLink, QrCode } from 'lucide-react';
import { tableClientUrl } from '../config';

const CAPTION = 'Escaneá para ver el menú y pedir desde tu mesa';

// QR de una mesa, listo para imprimir y pegar en la mesa. Codifica la URL absoluta del
// cliente con el token secreto de la mesa: el mismo link que abre el botón "Abrir link".
export default function TableQrModal({ table, onClose }) {
  const relativeUrl = tableClientUrl(table.id, table.qrToken);
  const absoluteUrl = `${window.location.origin}${window.location.pathname}${relativeUrl}`;
  // Un QR que apunta a localhost solo funciona en esta misma PC, no en el celular del cliente.
  const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);

  const qr = (size) => (
    <QRCodeSVG value={absoluteUrl} size={size} level="M" marginSize={2} title={`QR de la Mesa ${table.id}`} />
  );

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="glass-panel modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '420px' }}>
          <div className="modal-header">
            <h3 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <QrCode size={22} style={{ color: 'var(--accent-gold)' }} /> QR de la Mesa {table.id}
            </h3>
            <button className="modal-close" onClick={onClose} aria-label="Cerrar">
              <X size={24} />
            </button>
          </div>

          <div style={{ textAlign: 'center' }}>
            <div className="qr-code-box">{qr(220)}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '12px' }}>{CAPTION}</div>
          </div>

          {isLocalhost && (
            <p style={{ color: 'var(--warning)', fontSize: '0.8rem', marginTop: '14px' }}>
              Este QR apunta a localhost y solo abre en esta PC. Para probarlo con un celular,
              abrí el Mostrador desde la IP de la red (la dirección "Network" de Vite).
            </p>
          )}
          <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '14px', wordBreak: 'break-all' }}>
            {absoluteUrl}
          </p>
          <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
            <button className="btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => window.print()}>
              <Printer size={16} /> Imprimir
            </button>
            <a
              href={relativeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary"
              style={{ flex: 1, justifyContent: 'center', textDecoration: 'none' }}
              aria-label={`Abrir el link de la Mesa ${table.id}`}
            >
              <ExternalLink size={16} /> Abrir link
            </a>
          </div>
        </div>
      </div>

      {/* Hoja que sale al imprimir: fuera de #root, que en impresión se oculta entero
          (ver .qr-print-sheet en index.css). En pantalla no se ve. */}
      {createPortal(
        <div className="qr-print-sheet">
          <div className="qr-print-title">Mesa {table.id}</div>
          {qr(320)}
          <div className="qr-print-caption">{CAPTION}</div>
        </div>,
        document.body
      )}
    </>
  );
}
