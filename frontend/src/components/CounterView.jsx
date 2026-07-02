import { useState, useEffect } from 'react';
import { Monitor, CreditCard, DollarSign, Bell, X, Eye, LogOut, Pencil, Plus, Minus, Trash2, Hand, Check } from 'lucide-react';
import { useSocketRoom } from '../hooks/useSocketRoom';
import { createAudioContext, playTone } from '../utils/sound';

export default function CounterView({ socket, token, onLogout }) {
  const [tables, setTables] = useState([]);
  const [activeOrders, setActiveOrders] = useState([]);
  const [notifications, setNotifications] = useState([]);
  // Solo el id: la mesa y sus pedidos se derivan en vivo de `tables`/`activeOrders`
  // en cada render, así el modal no queda con datos viejos mientras está abierto.
  const [selectedTableId, setSelectedTableId] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [dailySales, setDailySales] = useState(0);
  const [menu, setMenu] = useState([]);

  // Edición de un pedido puntual (corrección de error humano, antes de cobrar)
  const [editingOrderId, setEditingOrderId] = useState(null);
  const [editItems, setEditItems] = useState([]);
  const [itemToAdd, setItemToAdd] = useState('');

  // Mesas que llamaron al mozo y todavía no fueron atendidas
  const [assistanceRequests, setAssistanceRequests] = useState([]);

  // Load initial state
  useEffect(() => {
    fetch('http://localhost:3001/api/initial-state', {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(data => {
        if (data.tables) setTables(data.tables);
        if (data.orders) setActiveOrders(data.orders);
        if (data.assistanceRequests) setAssistanceRequests(data.assistanceRequests);
      })
      .catch(err => console.error("Error fetching initial counter state:", err));
  }, [token]);

  // Menú, para poder agregar productos a un pedido al editarlo
  useEffect(() => {
    fetch('http://localhost:3001/api/menu')
      .then(res => res.json())
      .then(setMenu)
      .catch(err => console.error("Error fetching menu:", err));
  }, []);

  useSocketRoom(socket, 'counter', token);

  // Socket event handling
  useEffect(() => {
    if (!socket) return;

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

    // Una mesa llamó al mozo
    socket.on('assistance-requested', ({ tableId, timestamp }) => {
      setAssistanceRequests(prev => {
        if (prev.find(a => a.tableId === tableId)) return prev;
        return [...prev, { tableId, timestamp }];
      });

      addNotification({
        id: Date.now(),
        type: 'assistance',
        title: 'Llamado de mesa',
        message: `Mesa ${tableId} pidió asistencia.`,
        time: new Date().toLocaleTimeString()
      });
      playNotificationSound('assistance');
    });

    return () => {
      socket.off('tables-updated');
      socket.off('order-received-counter');
      socket.off('bill-requested');
      socket.off('orders-updated');
      socket.off('assistance-requested');
    };
  }, [socket]);

  const resolveAssistance = (tableId) => {
    socket.emit('resolve-assistance', { tableId });
    setAssistanceRequests(prev => prev.filter(a => a.tableId !== tableId));
  };

  // Push notification helper
  const addNotification = (notif) => {
    setNotifications(prev => [notif, ...prev].slice(0, 10)); // Keep last 10
  };

  // Sound Synth Synthesizer
  const playNotificationSound = (type = 'success') => {
    try {
      const ctx = createAudioContext();
      if (type === 'alert') {
        playTone(ctx, { freq: 880, duration: 0.15 });
        playTone(ctx, { freq: 1046.5, at: 0.2, duration: 0.15 });
      } else if (type === 'assistance') {
        // Distinto del de "cuenta solicitada": tres golpes iguales, no dos tonos ascendentes
        playTone(ctx, { freq: 740, type: 'triangle', gain: 0.18, duration: 0.12 });
        playTone(ctx, { freq: 740, type: 'triangle', gain: 0.18, at: 0.18, duration: 0.12 });
        playTone(ctx, { freq: 740, type: 'triangle', gain: 0.18, at: 0.36, duration: 0.18 });
      } else {
        const gainNode = playTone(ctx, { freq: 587.33, duration: 0.5 });
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
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
    if (selectedTableId === tableId) {
      closeModal();
    }
  };

  // View order details
  const handleViewDetails = (table) => {
    setSelectedTableId(table.id);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setSelectedTableId(null);
    cancelEditingOrder();
  };

  // --- Edición de un pedido puntual (solo mientras está 'pendiente') ---

  const startEditingOrder = (order) => {
    setEditingOrderId(order.id);
    setEditItems(order.items.map(item => ({ ...item })));
    setItemToAdd('');
  };

  const cancelEditingOrder = () => {
    setEditingOrderId(null);
    setEditItems([]);
    setItemToAdd('');
  };

  const changeEditItemQty = (productId, amount) => {
    setEditItems(prev =>
      prev
        .map(item => item.productId === productId ? { ...item, quantity: item.quantity + amount } : item)
        .filter(item => item.quantity > 0)
    );
  };

  const removeEditItem = (productId) => {
    setEditItems(prev => prev.filter(item => item.productId !== productId));
  };

  const addEditItem = () => {
    const menuItem = menu.find(m => m.id === itemToAdd);
    if (!menuItem) return;
    setEditItems(prev => {
      const existing = prev.find(item => item.productId === menuItem.id);
      if (existing) {
        return prev.map(item => item.productId === menuItem.id ? { ...item, quantity: item.quantity + 1 } : item);
      }
      return [...prev, { productId: menuItem.id, name: menuItem.name, price: menuItem.price, quantity: 1 }];
    });
    setItemToAdd('');
  };

  const saveEditedOrder = () => {
    socket.emit('edit-order', { orderId: editingOrderId, items: editItems });
    cancelEditingOrder();
  };

  const handleCancelOrder = (order) => {
    if (!window.confirm(`¿Cancelar el pedido completo de la Mesa ${order.tableId}?`)) return;
    socket.emit('cancel-order', { orderId: order.id });
    if (editingOrderId === order.id) cancelEditingOrder();
  };

  // --- Alta/baja de mesas (el backend asigna el número más chico sin usar,
  // y solo permite quitar mesas libres) ---

  const handleAddTable = () => {
    socket.emit('add-table', {});
  };

  const handleRemoveTable = (tableId) => {
    if (!window.confirm(`¿Dar de baja la Mesa ${tableId}? Su QR dejará de funcionar hasta que se vuelva a agregar.`)) return;
    socket.emit('remove-table', { tableId });
  };

  // Mesa y pedidos seleccionados, derivados en vivo (no una copia congelada al abrir el modal)
  const selectedTable = selectedTableId ? tables.find(t => t.id === selectedTableId) : null;
  const selectedTableOrders = selectedTableId
    ? activeOrders.filter(o => o.tableId === selectedTableId).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    : [];

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
          <button
            className="btn-secondary"
            style={{ padding: '10px 16px', fontSize: '0.8rem' }}
            onClick={handleAddTable}
            title="Agregar una mesa nueva (toma el número más chico disponible)"
          >
            <Plus size={16} /> Agregar Mesa
          </button>
          <button
            className="btn-secondary"
            style={{ padding: '10px 16px', fontSize: '0.8rem' }}
            onClick={onLogout}
            title="Cerrar sesión de mostrador"
          >
            <LogOut size={16} /> Salir
          </button>
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
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Mesa vacía</span>
                        <button
                          className="btn-secondary"
                          style={{ padding: '4px 8px', fontSize: '0.75rem', color: 'var(--danger)', borderColor: 'rgba(231, 111, 81, 0.3)' }}
                          onClick={() => handleRemoveTable(table.id)}
                          title={`Dar de baja la Mesa ${table.id}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
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

            {assistanceRequests.length > 0 && (
              <div style={{ marginBottom: '20px' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                  <Hand size={18} style={{ color: 'var(--danger)' }} /> Mesas que piden ayuda
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {assistanceRequests.map(req => (
                    <div key={req.tableId} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '10px 12px', borderRadius: '10px',
                      background: 'rgba(231, 111, 81, 0.1)', border: '1px solid rgba(231, 111, 81, 0.3)'
                    }}>
                      <span style={{ fontWeight: 700, color: 'var(--danger)' }}>Mesa {req.tableId}</span>
                      <button
                        className="btn-secondary"
                        style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                        onClick={() => resolveAssistance(req.tableId)}
                      >
                        <Check size={12} /> Atendida
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
        <div className="modal-overlay" onClick={closeModal}>
          <div className="glass-panel modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{ fontSize: '1.4rem', fontWeight: 800 }}>Mesa {selectedTable.id}</h3>
              <button className="modal-close" onClick={closeModal}>
                <X size={24} />
              </button>
            </div>

            <div style={{ margin: '15px 0' }}>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                Estado: <strong style={{ color: 'var(--accent-gold)' }}>{selectedTable.status.toUpperCase()}</strong>
              </p>
              
              {selectedTableOrders.length > 0 ? (
                <div style={{ marginTop: '20px' }}>
                  {selectedTableOrders.map((order, orderIdx) => (
                    <div key={order.id} style={{ marginBottom: '18px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px', marginBottom: '10px' }}>
                        <h4 style={{ fontSize: '1rem', fontWeight: 700 }}>
                          Pedido {orderIdx + 1} (Orden: {order.id.slice(-6)})
                        </h4>
                        {order.status === 'pendiente' && editingOrderId !== order.id && (
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              className="btn-secondary"
                              style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                              onClick={() => startEditingOrder(order)}
                            >
                              <Pencil size={12} /> Editar
                            </button>
                            <button
                              className="btn-secondary"
                              style={{ padding: '4px 10px', fontSize: '0.75rem', color: 'var(--danger)', borderColor: 'rgba(231, 111, 81, 0.3)' }}
                              onClick={() => handleCancelOrder(order)}
                            >
                              <Trash2 size={12} /> Cancelar
                            </button>
                          </div>
                        )}
                      </div>

                      {editingOrderId === order.id ? (
                        <div>
                          {editItems.length === 0 && (
                            <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: '10px' }}>
                              Sin productos: al guardar, el pedido queda cancelado.
                            </p>
                          )}
                          {editItems.map(item => (
                            <div key={item.productId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px dashed rgba(255,255,255,0.05)' }}>
                              <span>{item.name}</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <button className="btn-secondary" style={{ padding: '4px', borderRadius: '6px' }} onClick={() => changeEditItemQty(item.productId, -1)}>
                                  <Minus size={12} />
                                </button>
                                <span style={{ fontWeight: 700, minWidth: '16px', textAlign: 'center' }}>{item.quantity}</span>
                                <button className="btn-secondary" style={{ padding: '4px', borderRadius: '6px' }} onClick={() => changeEditItemQty(item.productId, 1)}>
                                  <Plus size={12} />
                                </button>
                                <button className="btn-secondary" style={{ padding: '4px', borderRadius: '6px', color: 'var(--danger)' }} onClick={() => removeEditItem(item.productId)}>
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </div>
                          ))}

                          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                            <select
                              value={itemToAdd}
                              onChange={(e) => setItemToAdd(e.target.value)}
                              style={{
                                flex: 1, padding: '8px', borderRadius: '8px',
                                background: 'rgba(0, 0, 0, 0.2)', border: '1px solid var(--border-color)',
                                color: 'white', fontFamily: 'var(--font-main)', fontSize: '0.85rem'
                              }}
                            >
                              <option value="">Agregar producto...</option>
                              {menu.map(m => (
                                <option key={m.id} value={m.id}>{m.name} — ${m.price}</option>
                              ))}
                            </select>
                            <button className="btn-secondary" style={{ fontSize: '0.8rem' }} disabled={!itemToAdd} onClick={addEditItem}>
                              <Plus size={14} /> Agregar
                            </button>
                          </div>

                          <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
                            <button className="btn-primary" style={{ flex: 1 }} onClick={saveEditedOrder}>
                              Guardar Cambios
                            </button>
                            <button className="btn-secondary" style={{ flex: 1 }} onClick={cancelEditingOrder}>
                              Descartar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
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
                        </>
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
              <button className="btn-secondary" style={{ flex: 1 }} onClick={closeModal}>
                Cerrar Detalle
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
