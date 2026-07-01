import React, { useState, useEffect } from 'react';
import { 
  Monitor, CreditCard, DollarSign, Bell, CheckCircle, 
  Trash2, X, RefreshCw, ShoppingBag, Eye 
} from 'lucide-react';

export default function CounterView({ socket }) {
  const [tables, setTables] = useState([]);
  const [activeOrders, setActiveOrders] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [selectedTable, setSelectedTable] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [dailySales, setDailySales] = useState(0);

  // Load initial state
  useEffect(() => {
    fetch('http://localhost:3001/api/initial-state')
      .then(res => res.json())
      .then(data => {
        if (data.tables) setTables(data.tables);
        if (data.orders) setActiveOrders(data.orders);
      })
      .catch(err => console.error("Error fetching initial counter state:", err));
  }, []);

  // Socket event handling
  useEffect(() => {
    if (!socket) return;

    socket.emit('join', 'counter');
    // Si el socket se reconecta (ej. el server se reinicia), hay que re-unirse a la sala
    // porque Socket.io no restaura la membresía de las salas automáticamente.
    const rejoinOnReconnect = () => socket.emit('join', 'counter');
    socket.on('connect', rejoinOnReconnect);

    // Tables state update
    socket.on('tables-updated', (updatedTables) => {
      setTables(updatedTables);
    });

    // New order notification
    socket.on('order-received-counter', (newOrder) => {
      setActiveOrders(prev => {
        if (prev.find(o => o.id === newOrder.id)) return prev;
        return [...prev, newOrder];
      });
      
      addNotification({
        id: Date.now(),
        type: 'new_order',
        title: 'Nuevo pedido recibido',
        message: `Mesa ${newOrder.tableId} envió un pedido.`,
        time: new Date().toLocaleTimeString()
      });
      playNotificationSound('success');
    });

    // Bill requested notification
    socket.on('bill-requested', ({ tableId, paymentMethod, total }) => {
      addNotification({
        id: Date.now(),
        type: 'bill_requested',
        title: 'Solicitud de cuenta',
        message: `Mesa ${tableId} solicita cerrar cuenta en ${paymentMethod === 'efectivo' ? 'Efectivo' : 'Tarjeta'}. Total: $${total}`,
        time: new Date().toLocaleTimeString()
      });
      playNotificationSound('alert');
    });

    // Full order list sync (item merges, status changes, table closed)
    socket.on('orders-updated', (updatedOrders) => {
      setActiveOrders(updatedOrders);
    });

    return () => {
      socket.off('connect', rejoinOnReconnect);
      socket.off('tables-updated');
      socket.off('order-received-counter');
      socket.off('bill-requested');
      socket.off('orders-updated');
    };
  }, [socket]);

  // Push notification helper
  const addNotification = (notif) => {
    setNotifications(prev => [notif, ...prev].slice(0, 10)); // Keep last 10
  };

  // Sound Synth Synthesizer
  const playNotificationSound = (type = 'success') => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      if (type === 'alert') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
        
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1046.5, ctx.currentTime + 0.2);
        gain2.gain.setValueAtTime(0.15, ctx.currentTime + 0.2);
        osc2.start(ctx.currentTime + 0.2);
        osc2.stop(ctx.currentTime + 0.35);
      } else {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
        osc.stop(ctx.currentTime + 0.5);
      }
    } catch (e) {
      console.log("Audio API not allowed/error:", e);
    }
  };

  // Close table and process payment
  const handleCloseTable = (tableId, total) => {
    socket.emit('close-table', { tableId });
    setDailySales(prev => prev + total);
    
    // Clear details modal if open
    if (selectedTable && selectedTable.id === tableId) {
      setIsModalOpen(false);
    }
  };

  // View order details
  const handleViewDetails = (table) => {
    // Una mesa puede acumular varios pedidos separados (rondas sucesivas); el ticket
    // tiene que mostrarlos todos, no solo el último (table.currentOrderId).
    const tableOrders = activeOrders
      .filter(o => o.tableId === table.id)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    setSelectedTable({
      ...table,
      orders: tableOrders
    });
    setIsModalOpen(true);
  };

  // Stats calculation
  const tablesOccupied = tables.filter(t => t.status !== 'libre').length;
  const tablesWaitingBill = tables.filter(t => t.status === 'esperando_cuenta' || t.status === 'pagando_tarjeta').length;

  return (
    <div className="animate-fade-in">
      
      {/* Header & Stats Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h2 style={{ fontSize: '1.8rem', fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Monitor size={32} style={{ color: 'var(--accent-gold)' }} /> Panel del Mostrador
          </h2>
          <p style={{ color: 'var(--text-secondary)' }}>Gestión general de mesas, pedidos y cobros.</p>
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          <div className="glass-panel" style={{ padding: '10px 20px', textAlign: 'center', minWidth: '110px' }}>
            <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>Mesas Activas</span>
            <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--accent-gold)' }}>{tablesOccupied} / {tables.length}</div>
          </div>
          <div className="glass-panel" style={{ padding: '10px 20px', textAlign: 'center', minWidth: '110px' }}>
            <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>Cuentas Pendientes</span>
            <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--danger)' }}>{tablesWaitingBill}</div>
          </div>
          <div className="glass-panel" style={{ padding: '10px 20px', textAlign: 'center', minWidth: '110px' }}>
            <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>Caja del Día</span>
            <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--success)' }}>${dailySales}</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '24px' }}>
        
        {/* Main: Tables Grid */}
        <div>
          <div className="counter-grid">
            {tables.map(table => {
              const order = activeOrders.find(o => o.id === table.currentOrderId);
              return (
                <div 
                  key={table.id} 
                  className={`glass-panel table-card status-${table.status}`}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div className="table-card-number">Mesa {table.id}</div>
                      <div className={`table-card-status status-${table.status}`}>
                        {table.status === 'libre' && 'Libre'}
                        {table.status === 'pedido_pendiente' && 'Pedido Recibido'}
                        {table.status === 'comiendo' && 'Consumiendo'}
                        {table.status === 'esperando_cuenta' && 'Espera Efectivo'}
                        {table.status === 'pagando_tarjeta' && 'Espera Tarjeta'}
                      </div>
                    </div>
                  </div>

                  {table.status !== 'libre' && (
                    <div style={{ margin: '10px 0' }}>
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        Total consumo:
                      </div>
                      <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--accent-gold)' }}>
                        ${table.total}
                      </div>
                      {order && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                          Pedido: <span style={{ textTransform: 'capitalize', fontWeight: 600 }}>{order.status}</span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="table-card-footer">
                    {table.status === 'libre' ? (
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Mesa vacía</span>
                    ) : (
                      <div style={{ display: 'flex', width: '100%', gap: '8px', flexDirection: 'column' }}>
                        
                        {/* If client is waiting for payment */}
                        {(table.status === 'esperando_cuenta' || table.status === 'pagando_tarjeta') ? (
                          <button 
                            className="btn-primary" 
                            style={{ 
                              width: '100%', 
                              background: table.status === 'esperando_cuenta' 
                                ? 'linear-gradient(135deg, var(--danger), #be5237)' 
                                : 'linear-gradient(135deg, var(--accent-gold), var(--accent-mocha))',
                              fontSize: '0.85rem',
                              padding: '8px 12px'
                            }} 
                            onClick={() => handleCloseTable(table.id, table.total)}
                          >
                            {table.status === 'esperando_cuenta' ? (
                              <><DollarSign size={14} /> Cobrar Efectivo</>
                            ) : (
                              <><CreditCard size={14} /> Cobrar con Tarjeta</>
                            )}
                          </button>
                        ) : null}

                        <button 
                          className="btn-secondary" 
                          style={{ width: '100%', fontSize: '0.85rem', padding: '6px 12px' }}
                          onClick={() => handleViewDetails(table)}
                        >
                          <Eye size={14} /> Detalles
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Sidebar: Activity and Notifications */}
        <div>
          <div className="glass-panel" style={{ padding: '20px', height: '100%', display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <Bell size={18} style={{ color: 'var(--accent-gold)' }} /> Alertas Recientes
            </h3>

            {notifications.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center', marginTop: '20px' }}>
                Sin alertas. Las solicitudes de los clientes aparecerán aquí en tiempo real.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto', flex: 1 }}>
                {notifications.map(notif => (
                  <div key={notif.id} className="glass-panel" style={{ 
                    padding: '12px', 
                    fontSize: '0.85rem', 
                    borderLeft: `3px solid ${notif.type === 'bill_requested' ? 'var(--danger)' : 'var(--warning)'}`,
                    background: 'rgba(255, 255, 255, 0.02)'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginBottom: '2px' }}>
                      <span style={{ color: notif.type === 'bill_requested' ? 'var(--danger)' : 'var(--warning)' }}>{notif.title}</span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{notif.time}</span>
                    </div>
                    <p style={{ color: 'var(--text-secondary)' }}>{notif.message}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Table Detail Modal */}
      {isModalOpen && selectedTable && (
        <div className="modal-overlay" onClick={() => setIsModalOpen(false)}>
          <div className="glass-panel modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{ fontSize: '1.4rem', fontWeight: 800 }}>Mesa {selectedTable.id}</h3>
              <button className="modal-close" onClick={() => setIsModalOpen(false)}>
                <X size={24} />
              </button>
            </div>

            <div style={{ margin: '15px 0' }}>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                Estado: <strong style={{ color: 'var(--accent-gold)' }}>{selectedTable.status.toUpperCase()}</strong>
              </p>
              
              {selectedTable.orders && selectedTable.orders.length > 0 ? (
                <div style={{ marginTop: '20px' }}>
                  {selectedTable.orders.map((order, orderIdx) => (
                    <div key={order.id} style={{ marginBottom: '18px' }}>
                      <h4 style={{ fontSize: '1rem', fontWeight: 700, borderBottom: '1px solid var(--border-color)', paddingBottom: '8px', marginBottom: '10px' }}>
                        Pedido {orderIdx + 1} (Orden: {order.id.slice(-6)})
                      </h4>
                      <ul style={{ listStyle: 'none' }}>
                        {order.items.map((item, idx) => (
                          <li key={idx} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px dashed rgba(255,255,255,0.05)' }}>
                            <span><strong style={{ color: 'var(--accent-gold)' }}>{item.quantity}x</strong> {item.name}</span>
                            <span>${item.price * item.quantity}</span>
                          </li>
                        ))}
                      </ul>

                      {order.notes && (
                        <div style={{ marginTop: '12px', padding: '10px', background: 'rgba(244,162,97,0.08)', border: '1px solid rgba(244,162,97,0.2)', borderRadius: '8px', fontSize: '0.85rem' }}>
                          <strong>Notas:</strong> {order.notes}
                        </div>
                      )}
                    </div>
                  ))}

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--border-color)', fontSize: '1.25rem', fontWeight: 800 }}>
                    <span>Total Consumido:</span>
                    <span style={{ color: 'var(--accent-gold)' }}>${selectedTable.total}</span>
                  </div>
                </div>
              ) : (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '10px' }}>
                  No hay pedidos pendientes de entrega o consumo asignados a esta mesa.
                </p>
              )}
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '30px' }}>
              {selectedTable.status !== 'libre' && (
                <button 
                  className="btn-primary" 
                  style={{ flex: 1, background: 'linear-gradient(135deg, var(--success), #4a9e62)' }}
                  onClick={() => handleCloseTable(selectedTable.id, selectedTable.total)}
                >
                  Confirmar Cobro y Cerrar Mesa
                </button>
              )}
              <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setIsModalOpen(false)}>
                Cerrar Detalle
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
