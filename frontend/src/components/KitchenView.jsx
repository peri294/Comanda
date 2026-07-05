import { useState, useEffect } from 'react';
import { ChefHat, Check, Coffee, Play, LogOut } from 'lucide-react';
import { useSocketRoom } from '../hooks/useSocketRoom';
import { createAudioContext, playTone } from '../utils/sound';
import { BACKEND_URL } from '../config';

export default function KitchenView({ socket, token, onLogout }) {
  const [orders, setOrders] = useState([]);
  // Pedidos que el mostrador acaba de corregir, para resaltarlos un rato en la tarjeta
  const [flashIds, setFlashIds] = useState(new Set());

  // Fetch initial active orders
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/initial-state`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(data => {
        if (data.orders) {
          // Filter out delivered/cancelled orders
          setOrders(data.orders.filter(o => o.status !== 'entregado' && o.status !== 'cancelado'));
        }
      })
      .catch(err => console.error("Error loading initial kitchen orders:", err));
  }, [token]);

  useSocketRoom(socket, 'kitchen', token);

  // Listen for socket events
  useEffect(() => {
    if (!socket) return;

    // Received a new order
    socket.on('order-received', (newOrder) => {
      setOrders(prev => {
        // Prevent duplicate entries
        if (prev.find(o => o.id === newOrder.id)) return prev;
        return [...prev, newOrder];
      });
      // Sound cue
      playKitchenSound();
    });

    // Orders state updated
    socket.on('orders-updated', (updatedOrders) => {
      setOrders(updatedOrders);
    });

    // El mostrador corrigió o canceló un pedido que cocina ya tenía en pantalla
    socket.on('order-modified', ({ order, reason }) => {
      playOrderModifiedSound();
      if (reason === 'edited') {
        setFlashIds(prev => new Set(prev).add(order.id));
        setTimeout(() => {
          setFlashIds(prev => {
            const next = new Set(prev);
            next.delete(order.id);
            return next;
          });
        }, 5000);
      }
    });

    return () => {
      socket.off('order-received');
      socket.off('orders-updated');
      socket.off('order-modified');
    };
  }, [socket]);

  // Audio chime specifically for kitchen
  const playKitchenSound = () => {
    try {
      const ctx = createAudioContext();
      const gainNode = playTone(ctx, { freq: 659.25, type: 'triangle', gain: 0.2, duration: 0.6 }); // E5
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    } catch (e) {
      console.log("Audio play error", e);
    }
  };

  // Tono distinto (descendente) para cuando el mostrador corrige/cancela un pedido
  const playOrderModifiedSound = () => {
    try {
      const ctx = createAudioContext();
      playTone(ctx, { freq: 700, type: 'square', gain: 0.15, duration: 0.15 });
      playTone(ctx, { freq: 400, type: 'square', gain: 0.15, at: 0.18, duration: 0.25 });
    } catch (e) {
      console.log("Audio play error", e);
    }
  };

  // Change status of order
  const updateStatus = (orderId, newStatus) => {
    socket.emit('update-order-status', { orderId, status: newStatus });
  };

  // Time elapsed helper
  const getMinutesAgo = (dateStr) => {
    const elapsedMs = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(elapsedMs / 60000);
    if (mins < 1) return 'Hace instantes';
    return `Hace ${mins} min`;
  };

  // Counter states
  const pendingOrders = orders.filter(o => o.status === 'pendiente');
  const preparingOrders = orders.filter(o => o.status === 'en_preparacion');
  const readyOrders = orders.filter(o => o.status === 'listo');

  return (
    <div className="animate-fade-in">
      {/* Header bar with stats */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h2 style={{ fontSize: '1.8rem', fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <ChefHat size={32} style={{ color: 'var(--accent-gold)' }} /> Monitor de Cocina
          </h2>
          <p style={{ color: 'var(--text-secondary)' }}>Pantalla de control de pedidos en preparación.</p>
        </div>
        
        <div style={{ display: 'flex', gap: '12px' }}>
          <div className="glass-panel" style={{ padding: '10px 20px', textAlign: 'center' }}>
            <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>Pendientes</span>
            <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--warning)' }}>{pendingOrders.length}</div>
          </div>
          <div className="glass-panel" style={{ padding: '10px 20px', textAlign: 'center' }}>
            <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>En Preparación</span>
            <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--accent-gold)' }}>{preparingOrders.length}</div>
          </div>
          <div className="glass-panel" style={{ padding: '10px 20px', textAlign: 'center' }}>
            <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>Listos</span>
            <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--success)' }}>{readyOrders.length}</div>
          </div>
          <button
            className="btn-secondary"
            style={{ padding: '10px 16px', fontSize: '0.8rem' }}
            onClick={onLogout}
            title="Cerrar sesión de cocina"
          >
            <LogOut size={16} /> Salir
          </button>
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="glass-panel" style={{ padding: '80px 20px', textAlign: 'center' }}>
          <Coffee size={64} style={{ color: 'var(--text-muted)', margin: '0 auto 20px auto', display: 'block' }} />
          <h3 style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text-secondary)' }}>¡No hay pedidos activos en cocina!</h3>
          <p style={{ color: 'var(--text-muted)', marginTop: '8px' }}>Los pedidos que realicen los clientes aparecerán aquí.</p>
        </div>
      ) : (
        <div className="kitchen-board">
          {orders.map(order => (
            <div key={order.id} className={`glass-panel kitchen-card ${flashIds.has(order.id) ? 'kitchen-card-flash' : ''}`} style={{
              borderTop: `4px solid ${
                order.status === 'pendiente' ? 'var(--warning)' :
                order.status === 'en_preparacion' ? 'var(--accent-gold)' : 'var(--success)'
              }`
            }}>
              <div className="kitchen-card-header">
                <div>
                  <h3 style={{ fontSize: '1.3rem', fontWeight: 800 }}>Mesa {order.tableId}</h3>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>ID: {order.id.slice(-6)}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                  <span className={`badge ${
                    order.status === 'pendiente' ? 'badge-pending' :
                    order.status === 'en_preparacion' ? 'badge-cooking' : 'badge-ready'
                  }`}>
                    {order.status === 'pendiente' && 'Pendiente'}
                    {order.status === 'en_preparacion' && 'Preparando'}
                    {order.status === 'listo' && 'Listo'}
                  </span>
                  <span className="kitchen-card-time">{getMinutesAgo(order.createdAt)}</span>
                </div>
              </div>

              {order.notes && (
                <div className="kitchen-card-notes">
                  <strong>Nota del cliente:</strong> {order.notes}
                </div>
              )}

              <ul className="kitchen-card-items">
                {order.items.map((item, index) => (
                  <li key={index} className="kitchen-card-item">
                    <span>
                      <span className="kitchen-card-item-qty">{item.quantity}x</span> 
                      {item.name}
                    </span>
                  </li>
                ))}
              </ul>

              <div style={{ marginTop: 'auto' }}>
                {order.status === 'pendiente' && (
                  <button className="btn-primary" style={{ width: '100%' }} onClick={() => updateStatus(order.id, 'en_preparacion')}>
                    <Play size={16} /> Empezar Preparación
                  </button>
                )}
                {order.status === 'en_preparacion' && (
                  <button className="btn-primary" style={{ width: '100%', background: 'linear-gradient(135deg, var(--success), #4a9e62)', boxShadow: '0 4px 15px rgba(96, 180, 123, 0.3)' }} onClick={() => updateStatus(order.id, 'listo')}>
                    <Check size={16} /> Marcar como Listo
                  </button>
                )}
                {order.status === 'listo' && (
                  <button className="btn-secondary" style={{ width: '100%', color: 'var(--text-primary)', border: '1px solid rgba(255, 255, 255, 0.2)' }} onClick={() => updateStatus(order.id, 'entregado')}>
                    <Check size={16} /> Confirmar Entrega
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
