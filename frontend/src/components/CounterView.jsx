import { useState, useEffect } from 'react';
import { Monitor, CreditCard, DollarSign, Bell, X, Eye, LogOut, Pencil, Plus, Minus, Trash2, Hand, Check, Archive, BookOpen, QrCode, RefreshCw, Lock, LockOpen, Sun, Moon } from 'lucide-react';
import { useSocketRoom } from '../hooks/useSocketRoom';
import { BACKEND_URL, tableClientUrl } from '../config';
import { createAudioContext, playTone } from '../utils/sound';
import { MENU_CATEGORIES } from '../menuCategories';

const headerButtonStyle = { padding: '10px 16px', fontSize: '0.8rem' };
const smallButtonStyle = { padding: '4px 8px', fontSize: '0.75rem' };
const inputStyle = {
  padding: '10px', borderRadius: '8px', background: 'rgba(0, 0, 0, 0.2)',
  border: '1px solid var(--border-color)', color: 'white', fontFamily: 'var(--font-main)', fontSize: '0.9rem'
};
const notificationColor = (type) =>
  type === 'bill_requested' ? 'var(--danger)' : type === 'register_closed' ? 'var(--success)' : 'var(--warning)';

// Sonidos de las alertas del mostrador (sintetizados, sin archivos de audio)
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

export default function CounterView({ socket, token, onLogout }) {
  const [tables, setTables] = useState([]);
  const [activeOrders, setActiveOrders] = useState([]);
  const [notifications, setNotifications] = useState([]);
  // Solo el id: la mesa y sus pedidos se derivan en vivo de `tables`/`activeOrders`
  // en cada render, así el modal no queda con datos viejos mientras está abierto.
  const [selectedTableId, setSelectedTableId] = useState(null);
  const [dailySales, setDailySales] = useState(0);
  const [menu, setMenu] = useState([]);

  // Edición de un pedido puntual (corrección de error humano, antes de cobrar)
  const [editingOrderId, setEditingOrderId] = useState(null);
  const [editItems, setEditItems] = useState([]);
  const [itemToAdd, setItemToAdd] = useState('');

  // Mesas que llamaron al mozo y todavía no fueron atendidas
  const [assistanceRequests, setAssistanceRequests] = useState([]);

  // Administración del menú (alta/edición/baja/stock de productos)
  const [isMenuAdminOpen, setIsMenuAdminOpen] = useState(false);
  const emptyMenuForm = { id: null, name: '', description: '', price: '', category: 'bebidas_calientes' };
  const [menuForm, setMenuForm] = useState(emptyMenuForm);

  // Estado inicial, re-pedido también tras cada reconexión del socket: los eventos
  // emitidos mientras la tablet estuvo sin conexión (microcorte de Wi-Fi, cambio de
  // red) se perdieron, así que al volver se rehidrata todo desde el server en vez de
  // quedarse con un panel congelado. El mismo endpoint trae mesas, pedidos, llamados
  // de asistencia y la caja del día (calculada por el server desde la DB, así una
  // recarga de página tampoco la resetea a $0).
  useEffect(() => {
    const fetchInitialState = () => {
      fetch(`${BACKEND_URL}/api/initial-state`, {
        headers: { Authorization: `Bearer ${token}` }
      })
        .then(res => res.json())
        .then(data => {
          if (data.tables) setTables(data.tables);
          if (data.orders) setActiveOrders(data.orders);
          if (data.assistanceRequests) setAssistanceRequests(data.assistanceRequests);
          if (data.dailySales !== undefined) setDailySales(data.dailySales);
        })
        .catch(err => console.error("Error fetching initial counter state:", err));
    };

    fetchInitialState();
    if (!socket) return;
    socket.on('connect', fetchInitialState);
    return () => socket.off('connect', fetchInitialState);
  }, [socket, token]);

  // Menú, para poder agregar productos a un pedido al editarlo. También se re-pide al
  // reconectar: un menu-updated perdido dejaría precios/stock viejos en el panel.
  useEffect(() => {
    const fetchMenu = () => {
      fetch(`${BACKEND_URL}/api/menu`)
        .then(res => res.json())
        .then(setMenu)
        .catch(err => console.error("Error fetching menu:", err));
    };

    fetchMenu();
    if (!socket) return;
    socket.on('connect', fetchMenu);
    return () => socket.off('connect', fetchMenu);
  }, [socket]);

  useSocketRoom(socket, 'counter', token);

  // Socket event handling
  useEffect(() => {
    if (!socket) return;

    // Agrega una alerta al panel (se guardan las últimas 10) y suena
    const notify = (type, title, message, sound) => {
      const notif = { id: Date.now(), type, title, message, time: new Date().toLocaleTimeString() };
      setNotifications(prev => [notif, ...prev].slice(0, 10));
      playNotificationSound(sound);
    };

    socket.on('tables-updated', setTables);

    // New order notification
    socket.on('order-received-counter', (newOrder) => {
      setActiveOrders(prev => {
        if (prev.find(o => o.id === newOrder.id)) return prev;
        return [...prev, newOrder];
      });
      
      notify('new_order', 'Nuevo pedido recibido', `Mesa ${newOrder.tableId} envió un pedido.`, 'success');
    });

    // Bill requested notification
    socket.on('bill-requested', ({ tableId, paymentMethod, total }) => {
      notify('bill_requested', 'Solicitud de cuenta', `Mesa ${tableId} solicita cerrar cuenta en ${paymentMethod === 'efectivo' ? 'Efectivo' : 'Tarjeta'}. Total: $${total}`, 'alert');
    });

    // La mesa pidió algo más después de pedir la cuenta: la solicitud queda cancelada
    socket.on('bill-cancelled', ({ tableId }) => {
      notify('bill_cancelled', 'Cuenta cancelada', `Mesa ${tableId} pidió algo más: se canceló la solicitud de cuenta y el consumo sigue sumando.`, 'alert');
    });

    // Full order list sync (item merges, status changes, table closed)
    socket.on('orders-updated', setActiveOrders);

    // El server recalcula la caja tras cada cobro y la manda a todos los mostradores
    // conectados: única fuente de verdad, sin sumas locales que puedan divergir.
    socket.on('daily-sales-updated', setDailySales);

    // Alguien cerró la caja (puede haber sido otra pestaña/tablet de mostrador)
    socket.on('register-closed', ({ total, ordersCount }) => {
      notify('register_closed', 'Caja cerrada', `Cierre por $${total} (${ordersCount} ${ordersCount === 1 ? 'pedido cobrado' : 'pedidos cobrados'}).`, 'success');
    });

    // Una mesa llamó al mozo
    socket.on('assistance-requested', ({ tableId, timestamp }) => {
      setAssistanceRequests(prev => {
        if (prev.find(a => a.tableId === tableId)) return prev;
        return [...prev, { tableId, timestamp }];
      });
      notify('assistance', 'Llamado de mesa', `Mesa ${tableId} pidió asistencia.`, 'assistance');
    });

    // El menú cambió (posiblemente desde otra pestaña/tablet de mostrador):
    // se refresca la copia local usada por el panel de menú y la edición de pedidos.
    socket.on('menu-updated', setMenu);

    return () => {
      socket.off('tables-updated');
      socket.off('order-received-counter');
      socket.off('bill-requested');
      socket.off('bill-cancelled');
      socket.off('orders-updated');
      socket.off('daily-sales-updated');
      socket.off('register-closed');
      socket.off('assistance-requested');
      socket.off('menu-updated');
    };
  }, [socket]);

  const resolveAssistance = (tableId) => {
    socket.emit('resolve-assistance', { tableId });
    setAssistanceRequests(prev => prev.filter(a => a.tableId !== tableId));
  };

  // Close table and process payment (la caja del día la actualiza el server
  // vía daily-sales-updated, acá no se suma nada localmente)
  const handleCloseTable = (tableId) => {
    socket.emit('close-table', { tableId });

    // Clear details modal if open
    if (selectedTableId === tableId) {
      closeModal();
    }
  };

  // View order details
  const handleViewDetails = (table) => {
    setSelectedTableId(table.id);
  };

  const closeModal = () => {
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

  const handleRemoveTable = (tableId) => {
    if (!window.confirm(`¿Dar de baja la Mesa ${tableId}? Su QR deja de funcionar: si se vuelve a agregar, va a necesitar un QR nuevo.`)) return;
    socket.emit('remove-table', { tableId });
  };

  // --- Habilitación de mesas ---
  // Bloquear una mesa con clientes no la corta: el server la marca y la bloquea al
  // cobrarla, para que una mesa bloqueada nunca tenga una cuenta abierta.

  // Cerrar el día y cerrar la caja son independientes: se ofrece hacer los dos juntos,
  // pero se puede cerrar el día sin tocar la caja.
  const handleEndDay = () => {
    if (!window.confirm('¿Cerrar el día? Las mesas libres se bloquean ahora; las ocupadas se bloquean al cobrarlas.')) return;
    socket.emit('end-day');
    if (window.confirm(`¿Cerrar también la caja? Se registrará un cierre por $${dailySales}.`)) {
      socket.emit('close-register');
    }
  };

  // Para cuando el link de una mesa se filtró: el server genera un token nuevo y el
  // QR anterior deja de funcionar al instante (el consumo de la mesa no se toca).
  const handleRegenerateQr = (tableId) => {
    if (!window.confirm(`¿Regenerar el QR de la Mesa ${tableId}? El QR actual deja de funcionar y hay que reemplazarlo en la mesa. Si hay clientes sentados, tienen que escanear el nuevo.`)) return;
    socket.emit('regenerate-table-qr', { tableId });
  };

  // --- Administración del menú ---
  // Todas las mutaciones van por sockets protegidos con rol counter; el estado local
  // no se toca acá: la única fuente es el broadcast menu-updated que responde el server.

  const closeMenuAdmin = () => {
    setIsMenuAdminOpen(false);
    setMenuForm(emptyMenuForm);
  };

  const startEditingMenuItem = (item) => {
    setMenuForm({
      id: item.id,
      name: item.name,
      description: item.description || '',
      price: String(item.price),
      category: item.category
    });
  };

  const submitMenuForm = (e) => {
    e.preventDefault();
    const name = menuForm.name.trim();
    const price = Number(menuForm.price);
    if (!name || !Number.isFinite(price) || price <= 0) return;

    const payload = { name, description: menuForm.description.trim(), price, category: menuForm.category };
    if (menuForm.id) {
      // Edición: disponibilidad e icono actuales se conservan (el switch de stock es aparte)
      const current = menu.find(m => m.id === menuForm.id);
      socket.emit('menu-update', { id: menuForm.id, ...payload, image: current?.image, available: current?.available });
    } else {
      socket.emit('menu-add', payload);
    }
    setMenuForm(emptyMenuForm);
  };

  // Switch rápido de stock: apagar un producto que se agotó en el salón sin borrarlo
  const toggleMenuAvailability = (item) => {
    socket.emit('menu-update', {
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price,
      category: item.category,
      image: item.image,
      available: !item.available
    });
  };

  const handleDeleteMenuItem = (item) => {
    if (!window.confirm(`¿Eliminar "${item.name}" del menú? Los pedidos ya realizados no se modifican.`)) return;
    socket.emit('menu-delete', { id: item.id });
    if (menuForm.id === item.id) setMenuForm(emptyMenuForm);
  };

  // Cierre de caja: el server sella el total real desde el cierre anterior; el monto
  // del confirm es informativo (lo que muestra la pantalla en este momento).
  const handleCloseRegister = () => {
    if (!window.confirm(`¿Cerrar la caja? Se registrará un cierre por $${dailySales} y la caja arranca de nuevo en $0.`)) return;
    socket.emit('close-register');
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

        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {[
            ['Mesas Activas', `${tablesOccupied} / ${tables.length}`, 'var(--accent-gold)'],
            ['Cuentas Pendientes', tablesWaitingBill, 'var(--danger)'],
            ['Caja del Día', `$${dailySales}`, 'var(--success)']
          ].map(([label, value, color]) => (
            <div key={label} className="glass-panel" style={{ padding: '10px 20px', textAlign: 'center', minWidth: '110px' }}>
              <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</span>
              <div style={{ fontSize: '1.5rem', fontWeight: 800, color }}>{value}</div>
            </div>
          ))}
          <button
            className="btn-secondary"
            style={headerButtonStyle}
            onClick={handleCloseRegister}
            title="Registrar un cierre de caja con lo cobrado hasta ahora"
          >
            <Archive size={16} /> Cerrar Caja
          </button>
          <button
            className="btn-secondary"
            style={headerButtonStyle}
            onClick={() => socket.emit('start-day')}
            title="Habilitar todas las mesas para recibir pedidos"
          >
            <Sun size={16} /> Iniciar Día
          </button>
          <button
            className="btn-secondary"
            style={headerButtonStyle}
            onClick={handleEndDay}
            title="Bloquear todas las mesas (las ocupadas, al cobrarlas)"
          >
            <Moon size={16} /> Cerrar Día
          </button>
          <button
            className="btn-secondary"
            style={headerButtonStyle}
            onClick={() => socket.emit('add-table', {})}
            title="Agregar una mesa nueva (toma el número más chico disponible)"
          >
            <Plus size={16} /> Agregar Mesa
          </button>
          <button
            className="btn-secondary"
            style={headerButtonStyle}
            onClick={() => setIsMenuAdminOpen(true)}
            title="Administrar los productos del menú (precios, stock, altas y bajas)"
          >
            <BookOpen size={16} /> Administrar Menú
          </button>
          <button
            className="btn-secondary"
            style={headerButtonStyle}
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
              // Bloqueada o con bloqueo pendiente: el candado la (re)habilita
              const willEnable = !table.enabled || table.blockOnClose;
              const lockLabel = willEnable
                ? `Habilitar Mesa ${table.id}`
                : table.status === 'libre' ? `Bloquear Mesa ${table.id}` : `Bloquear Mesa ${table.id} al cobrar`;
              return (
                <div 
                  key={table.id} 
                  className={`glass-panel table-card status-${table.status}`}
                  style={table.enabled ? undefined : { opacity: 0.6 }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div className="table-card-number">Mesa {table.id}</div>
                      <div className={`table-card-status status-${table.status}`}>
                        {table.status === 'libre' && (table.enabled ? 'Libre' : 'Bloqueada')}
                        {table.status === 'pedido_pendiente' && 'Pedido Recibido'}
                        {table.status === 'comiendo' && 'Consumiendo'}
                        {table.status === 'esperando_cuenta' && 'Espera Efectivo'}
                        {table.status === 'pagando_tarjeta' && 'Espera Tarjeta'}
                      </div>
                      {table.blockOnClose && (
                        <div style={{ fontSize: '0.7rem', color: 'var(--warning)', marginTop: '2px' }}>
                          Se bloquea al cobrar
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        className="btn-secondary"
                        style={smallButtonStyle}
                        onClick={() => socket.emit('set-table-enabled', { tableId: table.id, enabled: willEnable })}
                        title={lockLabel}
                        aria-label={lockLabel}
                      >
                        {willEnable ? <LockOpen size={12} /> : <Lock size={12} />}
                      </button>
                      <a
                        href={tableClientUrl(table.id, table.qrToken)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-secondary"
                        style={smallButtonStyle}
                        title={`Abrir el link del QR de la Mesa ${table.id}`}
                        aria-label={`QR de la Mesa ${table.id}`}
                      >
                        <QrCode size={12} />
                      </a>
                      <button
                        className="btn-secondary"
                        style={smallButtonStyle}
                        onClick={() => handleRegenerateQr(table.id)}
                        title={`Regenerar el QR de la Mesa ${table.id} (el anterior deja de funcionar)`}
                        aria-label={`Regenerar QR de la Mesa ${table.id}`}
                      >
                        <RefreshCw size={12} />
                      </button>
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
                            onClick={() => handleCloseTable(table.id)}
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
                    <div key={req.tableId} className="assistance-row" style={{
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
                    borderLeft: `3px solid ${notificationColor(notif.type)}`,
                    background: 'rgba(255, 255, 255, 0.02)'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginBottom: '2px' }}>
                      <span style={{ color: notificationColor(notif.type) }}>{notif.title}</span>
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

      {/* Menu Admin Modal */}
      {isMenuAdminOpen && (
        <div className="modal-overlay" onClick={closeMenuAdmin}>
          <div className="glass-panel modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '640px' }}>
            <div className="modal-header">
              <h3 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <BookOpen size={22} style={{ color: 'var(--accent-gold)' }} /> Administrar Menú
              </h3>
              <button className="modal-close" onClick={closeMenuAdmin}>
                <X size={24} />
              </button>
            </div>

            {/* Formulario de alta / edición */}
            <form
              onSubmit={submitMenuForm}
              style={{
                display: 'flex', flexDirection: 'column', gap: '10px', margin: '15px 0',
                padding: '14px', border: '1px solid var(--border-color)', borderRadius: '12px',
                background: 'rgba(255, 255, 255, 0.02)'
              }}
            >
              <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--accent-gold)' }}>
                {menuForm.id ? `Editando: ${menu.find(m => m.id === menuForm.id)?.name || ''}` : 'Agregar Producto Nuevo'}
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <input
                  placeholder="Nombre del producto"
                  value={menuForm.name}
                  onChange={(e) => setMenuForm(f => ({ ...f, name: e.target.value }))}
                  style={{ ...inputStyle, flex: 2 }}
                />
                <input
                  placeholder="Precio"
                  type="number"
                  min="1"
                  value={menuForm.price}
                  onChange={(e) => setMenuForm(f => ({ ...f, price: e.target.value }))}
                  style={{ ...inputStyle, flex: 1 }}
                />
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <input
                  placeholder="Descripción (opcional)"
                  value={menuForm.description}
                  onChange={(e) => setMenuForm(f => ({ ...f, description: e.target.value }))}
                  style={{ ...inputStyle, flex: 2 }}
                />
                <select
                  value={menuForm.category}
                  onChange={(e) => setMenuForm(f => ({ ...f, category: e.target.value }))}
                  style={{ ...inputStyle, flex: 1 }}
                >
                  {MENU_CATEGORIES.map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.label}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button type="submit" className="btn-primary" style={{ flex: 1, padding: '10px', fontSize: '0.9rem' }}>
                  {menuForm.id ? 'Guardar Cambios' : 'Agregar Producto'}
                </button>
                {menuForm.id && (
                  <button type="button" className="btn-secondary" style={{ flex: 1, padding: '10px', fontSize: '0.9rem' }} onClick={() => setMenuForm(emptyMenuForm)}>
                    Cancelar Edición
                  </button>
                )}
              </div>
            </form>

            {/* Lista de productos */}
            <div style={{ maxHeight: '45vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {menu.map(item => (
                <div
                  key={item.id}
                  className="menu-admin-row"
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px',
                    padding: '10px 12px', border: '1px solid var(--border-color)', borderRadius: '10px',
                    opacity: item.available === false ? 0.55 : 1
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                      {item.available === false && (
                        <span style={{ color: 'var(--danger)', fontSize: '0.7rem', fontWeight: 800, flexShrink: 0 }}>AGOTADO</span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      ${item.price} · {item.category.replace('_', ' ')}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button
                      className="btn-secondary"
                      style={{ padding: '6px 10px', fontSize: '0.75rem' }}
                      title={item.available === false ? 'Marcar como disponible' : 'Marcar como agotado'}
                      onClick={() => toggleMenuAvailability(item)}
                    >
                      {item.available === false ? 'Reponer' : 'Agotar'}
                    </button>
                    <button
                      className="btn-secondary"
                      style={{ padding: '6px 10px' }}
                      title={`Editar ${item.name}`}
                      onClick={() => startEditingMenuItem(item)}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="btn-secondary"
                      style={{ padding: '6px 10px', color: 'var(--danger)', borderColor: 'rgba(231, 111, 81, 0.3)' }}
                      title={`Eliminar ${item.name}`}
                      onClick={() => handleDeleteMenuItem(item)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Table Detail Modal */}
      {selectedTable && (
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
                              {/* Sin agotados: el server rechazaría agregarlos, la UI no los ofrece */}
                              {menu.filter(m => m.available !== false).map(m => (
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
                  onClick={() => handleCloseTable(selectedTable.id)}
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
