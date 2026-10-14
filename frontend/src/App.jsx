import { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { Coffee, Monitor, ChefHat, Volume2, Info, ExternalLink } from 'lucide-react';
import ClientView from './components/ClientView';
import KitchenView from './components/KitchenView';
import CounterView from './components/CounterView';
import StaffLogin from './components/StaffLogin';
import { createAudioContext, playTone } from './utils/sound';
import { useStaffAuth } from './hooks/useStaffAuth';
import { BACKEND_URL, tableClientUrl, absoluteBackendUrl } from './config';

export default function App() {
  const [view, setView] = useState('portal'); // 'portal', 'client', 'kitchen', 'counter'
  const [tableId, setTableId] = useState(null);
  const [qrToken, setQrToken] = useState(null);
  // Links con token de las mesas para el simulador de QR del portal. null mientras carga
  // o si el backend no los expone (en producción no existe el endpoint de demo).
  const [demoTableLinks, setDemoTableLinks] = useState(null);
  // Configuración pública del server (/api/config): { mode, businessName } y, en la demo,
  // { credentials, idleResetMinutes }. null mientras carga.
  const [appConfig, setAppConfig] = useState(null);
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const kitchenAuth = useStaffAuth('kitchen');
  const counterAuth = useStaffAuth('counter');

  // Check URL parameters for routing
  useEffect(() => {
    const handleUrlRouting = () => {
      const params = new URLSearchParams(window.location.search);
      const viewParam = params.get('view');
      const tableParam = params.get('table');

      if (viewParam === 'client' && tableParam) {
        setView('client');
        setTableId(tableParam);
        setQrToken(params.get('t'));
      } else if (viewParam === 'kitchen') {
        setView('kitchen');
      } else if (viewParam === 'counter') {
        setView('counter');
      } else {
        setView('portal');
      }
    };

    handleUrlRouting();
    window.addEventListener('popstate', handleUrlRouting);
    return () => window.removeEventListener('popstate', handleUrlRouting);
  }, []);

  // Initialize Socket.io Connection
  useEffect(() => {
    const newSocket = io(BACKEND_URL, {
      transports: ['websocket', 'polling']
    });

    newSocket.on('connect', () => {
      setIsConnected(true);
      console.log('Conectado al servidor de Sockets');
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
      console.log('Desconectado del servidor de Sockets');
    });

    // La demo pública volvió a fábrica: recargar para tomar el estado nuevo de una vez.
    newSocket.on('demo-reset', () => window.location.reload());
    // El Mostrador cambió el nombre del local: se actualiza en todas las pantallas.
    newSocket.on('settings-updated', (settings) => setAppConfig(prev => ({ ...prev, ...settings })));

    // El socket es una conexión externa que nace con el efecto y muere en su cleanup:
    // guardarlo en el estado es la forma de compartirlo con las vistas.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSocket(newSocket);
    // Referencia global para los tests E2E (simulan cortes y reconexiones de socket
    // llamando a __socket.disconnect()/connect() desde la página). Solo en desarrollo:
    // en el build de producción no queda expuesta.
    if (import.meta.env.DEV) window.__socket = newSocket;

    return () => {
      newSocket.close();
    };
  }, []);

  // Si el server rechaza el token de personal (ej. se reinició y perdió las sesiones
  // en memoria), forzar el login de nuevo en vez de dejar la pantalla sorda a eventos.
  useEffect(() => {
    if (!socket) return;
    const handleAuthError = ({ role }) => {
      if (role === 'kitchen') kitchenAuth.logout();
      if (role === 'counter') counterAuth.logout();
    };
    socket.on('auth-error', handleAuthError);
    return () => socket.off('auth-error', handleAuthError);
    // Se depende de .logout (estable vía useCallback) y no de los objetos kitchenAuth/counterAuth
    // completos, que son literales nuevos en cada render y harían que este efecto se re-ejecute siempre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, kitchenAuth.logout, counterAuth.logout]);

  // Audio test helper
  const testChime = () => {
    try {
      const ctx = createAudioContext();
      const gainNode = playTone(ctx, { freq: 523.25, gain: 0.1, duration: 0.4 }); // C5
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    } catch {
      alert("Por favor habilita el audio interactuando con la página primero.");
    }
  };

  // Helper to change view and update browser URL without reloading
  const navigateTo = (newView, table = null, token = null, visitCode = null) => {
    const params = new URLSearchParams();
    if (newView !== 'portal') {
      params.set('view', newView);
      if (table) params.set('table', table);
      if (token) params.set('t', token);
      if (visitCode) params.set('c', visitCode);
    }
    const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname;
    window.history.pushState({}, '', newUrl);
    
    setView(newView);
    // Normalizado a string: el backend compara el id de mesa como string,
    // y el botón "Ir a Mesa" pasa un número mientras que la URL siempre da un string.
    setTableId(table !== null ? String(table) : null);
    setQrToken(token);
  };

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/config`)
      .then(res => (res.ok ? res.json() : null))
      .catch(() => null)
      .then(setAppConfig);
  }, []);

  const businessName = appConfig?.businessName || '';
  const logoUrl = absoluteBackendUrl(appConfig?.logoUrl);
  useEffect(() => {
    if (businessName) document.title = businessName;
  }, [businessName]);

  // En producción la raíz es la pantalla del personal: un cliente en su mesa no tiene
  // nada que hacer ahí, así que su vista no ofrece volver.
  const isProduction = appConfig?.mode === 'production';
  const canLeaveView = view !== 'portal' && !(isProduction && view === 'client');
  const demoCredentials = appConfig?.credentials;

  // Se recargan cada vez que se vuelve al portal: el mostrador puede haber agregado,
  // quitado mesas o regenerado un QR mientras tanto.
  useEffect(() => {
    if (view !== 'portal') return;
    let cancelled = false;
    fetch(`${BACKEND_URL}/api/demo/table-links`)
      .then(res => (res.ok ? res.json() : null))
      .catch(() => null)
      .then(links => { if (!cancelled) setDemoTableLinks(links); });
    return () => { cancelled = true; };
  }, [view]);

  return (
    <div className="app-container">
      {/* Universal Header */}
      <header className="header">
        <div
          className="logo"
          onClick={canLeaveView ? () => navigateTo('portal') : undefined}
          style={{ cursor: canLeaveView ? 'pointer' : 'default' }}
        >
          {logoUrl
            ? <img className="logo-img" src={logoUrl} alt="" />
            : <Coffee style={{ color: 'var(--accent-gold)' }} />}
          <span className="logo-name">{businessName}</span>
        </div>

        <div className="header-actions">
          {/* Connection Status Badge */}
          <span
            className="badge header-status"
            role="status"
            aria-label={isConnected ? 'Servidor conectado' : 'Sin conexión'}
            style={{ 
              background: isConnected ? 'rgba(96, 180, 123, 0.12)' : 'rgba(231, 111, 81, 0.12)',
              color: isConnected ? 'var(--success)' : 'var(--danger)',
              border: `1px solid ${isConnected ? 'rgba(96, 180, 123, 0.3)' : 'rgba(231, 111, 81, 0.3)'}`,
              fontSize: '0.8rem'
            }}
          >
            <span style={{ 
              width: '6px', 
              height: '6px', 
              borderRadius: '50%', 
              background: isConnected ? 'var(--success)' : 'var(--danger)',
              display: 'inline-block',
              flexShrink: 0
            }} />
            <span className="header-status-text">{isConnected ? 'Servidor Conectado' : 'Sin Conexión'}</span>
          </span>

          {canLeaveView && (
            <button 
              className="btn-secondary" 
              style={{ padding: '6px 12px', fontSize: '0.8rem', borderRadius: '8px' }}
              onClick={() => navigateTo('portal')}
            >
              {isProduction ? 'Inicio' : 'Volver al Portal'}
            </button>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="main-content">
        
        {/* VIEW 1: Customer View */}
        {/* key fuerza un remount completo al cambiar de mesa (o de QR) en la misma pestaña,
            evitando que el carrito/pedido activo de una mesa quede pegado al pasar a otra */}
        {view === 'client' && tableId && (
          <ClientView key={`${tableId}:${qrToken}`} tableId={tableId} qrToken={qrToken} socket={socket} />
        )}

        {/* VIEW 2: Kitchen Screen (detrás de login de personal) */}
        {view === 'kitchen' && (
          kitchenAuth.token ? (
            <KitchenView socket={socket} token={kitchenAuth.token} onLogout={kitchenAuth.logout} />
          ) : (
            <StaffLogin role="kitchen" onLogin={kitchenAuth.login} error={kitchenAuth.error} loading={kitchenAuth.loading} demoPassword={demoCredentials?.kitchen} />
          )
        )}

        {/* VIEW 3: Counter/Manager Dashboard (detrás de login de personal) */}
        {view === 'counter' && (
          counterAuth.token ? (
            <CounterView socket={socket} token={counterAuth.token} onLogout={counterAuth.logout} businessName={businessName} logoUrl={logoUrl} />
          ) : (
            <StaffLogin role="counter" onLogin={counterAuth.login} error={counterAuth.error} loading={counterAuth.loading} demoPassword={demoCredentials?.counter} />
          )
        )}

        {/* VIEW 4: Portal. En demo y desarrollo, el simulador con las mesas; en producción,
            solo el acceso a las pantallas del personal. Se espera a /api/config para no
            mostrar un instante el simulador en un local real. */}
        {view === 'portal' && appConfig && (
          <div className="animate-fade-in" style={{ maxWidth: '1000px', margin: '0 auto' }}>
            
            {/* Hero Section */}
            <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', marginBottom: '30px' }}>
              <div className="coffee-cup-illustration">
                <Coffee size={50} style={{ color: 'var(--accent-gold)' }} />
              </div>
              <h1 style={{ fontSize: '2.2rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '10px' }}>
                {isProduction ? businessName : 'Sistema de Pedidos QR para Cafetería'}
              </h1>
              <p style={{ color: 'var(--text-secondary)', maxWidth: '600px', margin: '0 auto 24px auto', fontSize: '1rem', lineHeight: '1.6' }}>
                {isProduction
                  ? 'Pantallas del personal. Elegí la de este dispositivo e ingresá la contraseña del rol.'
                  : 'Bienvenido al simulador interactivo. Desde aquí puedes abrir las diferentes pantallas para ver cómo interactúan en tiempo real mediante WebSockets.'}
              </p>
              {demoCredentials && (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', maxWidth: '600px', margin: '0 auto 24px auto' }}>
                  Demo pública: contraseña de Mostrador <strong>{demoCredentials.counter}</strong> y de Cocina <strong>{demoCredentials.kitchen}</strong>.
                  Los cambios son compartidos con otros visitantes y todo vuelve al estado inicial tras {appConfig.idleResetMinutes} minutos sin uso.
                </p>
              )}
              
              <div style={{ display: 'flex', justifyContent: 'center', gap: '15px', flexWrap: 'wrap' }}>
                <button className="btn-primary" onClick={testChime}>
                  <Volume2 size={18} /> Probar Audio
                </button>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  <Info size={16} /> (Habilita el audio interactuando con la página)
                </div>
              </div>
            </div>

            {/* Admin and Kitchen Panels Row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '30px', flexWrap: 'wrap' }}>
              
              {[
                {
                  view: 'counter', Icon: Monitor, title: 'Pantalla del Mostrador', button: 'Abrir Mostrador',
                  text: 'Vista para el cajero/encargado. Monitorea las mesas, muestra los pedidos y totales en consumo, recibe alertas de solicitudes de cierre de cuenta y procesa cobros.'
                },
                {
                  view: 'kitchen', Icon: ChefHat, title: 'Monitor de Cocina', button: 'Abrir Cocina',
                  text: 'Vista para los chefs y cocineros. Lista los pedidos entrantes clasificados cronológicamente, muestra los detalles de los productos y sus notas, y permite avanzar su preparación.'
                }
              ].map(({ view: target, Icon, title, button, text }) => (
                <div key={target} className="glass-panel" style={{ padding: '24px', display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                    <Icon style={{ color: 'var(--accent-gold)' }} /> {title}
                  </h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '20px', flex: 1 }}>
                    {text}
                  </p>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button className="btn-primary" style={{ flex: 1 }} onClick={() => navigateTo(target)}>
                      {button}
                    </button>
                    <a href={`?view=${target}`} target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ padding: '12px' }}>
                      <ExternalLink size={16} />
                    </a>
                  </div>
                </div>
              ))}

            </div>

            {/* QR Simulator Tables Grid (solo demo y desarrollo) */}
            {!isProduction && (
            <div className="glass-panel qr-simulator-box">
              <h3 style={{ fontSize: '1.25rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
                <Coffee style={{ color: 'var(--accent-gold)' }} /> Simulador de Códigos QR en Mesas
              </h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '6px', maxWidth: '600px', margin: '6px auto 0 auto' }}>
                Haz clic en cualquier mesa para simular el escaneo del código QR por parte de un cliente. Se recomienda abrir las mesas en pestañas nuevas para probar el flujo simultáneo.
              </p>

              {!demoTableLinks && (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '16px' }}>
                  Los links de las mesas se abren desde el Mostrador (botón de QR en cada mesa).
                </p>
              )}

              <div className="qr-grid">
                {(demoTableLinks || []).map(({ id: tableNum, qrToken: token, visitCode }) => {
                  return (
                    <div key={tableNum} className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px', background: 'rgba(255, 255, 255, 0.02)' }}>
                      <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--accent-gold)' }}>Mesa {tableNum}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <button 
                          className="btn-primary" 
                          style={{ padding: '6px 8px', fontSize: '0.75rem', borderRadius: '6px', width: '100%' }}
                          onClick={() => navigateTo('client', tableNum, token, visitCode)}
                        >
                          Ir a Mesa
                        </button>
                        <a 
                          href={tableClientUrl(tableNum, token, visitCode)} 
                          target="_blank" 
                          rel="noopener noreferrer" 
                          className="btn-secondary" 
                          style={{ padding: '6px 8px', fontSize: '0.75rem', borderRadius: '6px', width: '100%', textDecoration: 'none', color: 'var(--accent-gold)' }}
                        >
                          Nueva Pestaña
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            )}

          </div>
        )}

      </main>
    </div>
  );
}
