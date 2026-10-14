import { useState } from 'react';
import { BookOpen, X, Pencil, Trash2, ArrowUp, ArrowDown, ImagePlus, Plus } from 'lucide-react';
import { formatPrice } from '../utils/format';
import { uploadImage } from '../utils/images';
import { imageUrl } from '../config';

const inputStyle = {
  padding: '10px', borderRadius: '8px', background: 'rgba(0, 0, 0, 0.2)',
  border: '1px solid var(--border-color)', color: 'white', fontFamily: 'var(--font-main)', fontSize: '0.9rem'
};
const sectionStyle = {
  display: 'flex', flexDirection: 'column', gap: '10px', margin: '15px 0',
  padding: '14px', border: '1px solid var(--border-color)', borderRadius: '12px',
  background: 'rgba(255, 255, 255, 0.02)'
};
const rowStyle = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px',
  padding: '10px 12px', border: '1px solid var(--border-color)', borderRadius: '10px'
};
const iconButtonStyle = { padding: '6px 10px' };
const dangerButtonStyle = { ...iconButtonStyle, color: 'var(--danger)', borderColor: 'rgba(231, 111, 81, 0.3)' };

// imageId: undefined = sin cambios, null = sacar la foto, string = foto nueva ya subida.
const emptyProductForm = { id: null, name: '', description: '', price: '', category: '', imageId: undefined, previewUrl: null };
const emptyCategoryForm = { id: null, name: '', icon: '' };

// Administración del menú desde el Mostrador: productos (con foto) y categorías.
// Todas las mutaciones van por sockets protegidos con rol counter; el estado no se toca
// acá: la única fuente son los broadcasts menu-updated y categories-updated del server.
export default function MenuAdminModal({ socket, token, menu, categories, onClose }) {
  const [productForm, setProductForm] = useState(emptyProductForm);
  const [categoryForm, setCategoryForm] = useState(emptyCategoryForm);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const categoryName = (id) => categories.find(c => c.id === id)?.name || 'Sin categoría';
  // Una categoría recién creada o borrada mientras se edita: si la del formulario ya no
  // existe, se propone la primera.
  const formCategory = categories.some(c => c.id === productForm.category) ? productForm.category : categories[0]?.id || '';
  const editingProduct = productForm.id ? menu.find(m => m.id === productForm.id) : null;
  const productPhotoUrl = productForm.imageId === undefined
    ? imageUrl(editingProduct?.imageId)
    : productForm.previewUrl;

  // --- Productos ---

  const startEditingProduct = (item) => {
    setError('');
    setProductForm({
      id: item.id,
      name: item.name,
      description: item.description || '',
      price: String(item.price),
      category: item.category,
      imageId: undefined,
      previewUrl: null
    });
  };

  const choosePhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setUploading(true);
    try {
      const id = await uploadImage(file, token);
      setProductForm(f => ({ ...f, imageId: id, previewUrl: imageUrl(id) }));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const submitProduct = (e) => {
    e.preventDefault();
    const name = productForm.name.trim();
    const price = Number(productForm.price);
    if (!name || !Number.isFinite(price) || price <= 0 || !formCategory) return;

    const payload = { name, description: productForm.description.trim(), price, category: formCategory };
    if (productForm.imageId !== undefined) payload.imageId = productForm.imageId;
    if (productForm.id) {
      // Edición: disponibilidad e icono actuales se conservan (el switch de stock es aparte)
      socket.emit('menu-update', { id: productForm.id, ...payload, image: editingProduct?.image, available: editingProduct?.available });
    } else {
      socket.emit('menu-add', payload);
    }
    setProductForm(emptyProductForm);
  };

  // Switch rápido de stock: apagar un producto que se agotó en el salón sin borrarlo
  const toggleAvailability = (item) => {
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

  const deleteProduct = (item) => {
    if (!window.confirm(`¿Eliminar "${item.name}" del menú? Los pedidos ya realizados no se modifican.`)) return;
    socket.emit('menu-delete', { id: item.id });
    if (productForm.id === item.id) setProductForm(emptyProductForm);
  };

  // --- Categorías ---

  const submitCategory = (e) => {
    e.preventDefault();
    const name = categoryForm.name.trim();
    if (!name) return;
    const payload = { name, icon: categoryForm.icon.trim() };
    if (categoryForm.id) socket.emit('category-update', { id: categoryForm.id, ...payload });
    else socket.emit('category-add', payload);
    setCategoryForm(emptyCategoryForm);
  };

  const deleteCategory = (category) => {
    const count = menu.filter(m => m.category === category.id).length;
    if (count > 0) {
      setError(`"${category.name}" tiene ${count === 1 ? '1 producto' : `${count} productos`}: movelos a otra categoría o borralos antes de eliminarla.`);
      return;
    }
    if (!window.confirm(`¿Eliminar la categoría "${category.name}"?`)) return;
    setError('');
    socket.emit('category-delete', { id: category.id });
    if (categoryForm.id === category.id) setCategoryForm(emptyCategoryForm);
  };

  const moveCategory = (index, delta) => {
    const ids = categories.map(c => c.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    socket.emit('category-reorder', { ids });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="glass-panel modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '640px' }}>
        <div className="modal-header">
          <h3 style={{ fontSize: '1.4rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <BookOpen size={22} style={{ color: 'var(--accent-gold)' }} /> Administrar Menú
          </h3>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar administración del menú">
            <X size={24} />
          </button>
        </div>

        {error && (
          <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '10px' }}>{error}</p>
        )}

        {/* Formulario de alta / edición de productos */}
        <form onSubmit={submitProduct} style={sectionStyle}>
          <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--accent-gold)' }}>
            {editingProduct ? `Editando: ${editingProduct.name}` : 'Agregar Producto Nuevo'}
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <input
              placeholder="Nombre del producto"
              value={productForm.name}
              onChange={(e) => setProductForm(f => ({ ...f, name: e.target.value }))}
              style={{ ...inputStyle, flex: 2 }}
            />
            <input
              placeholder="Precio"
              type="number"
              min="1"
              value={productForm.price}
              onChange={(e) => setProductForm(f => ({ ...f, price: e.target.value }))}
              style={{ ...inputStyle, flex: 1 }}
            />
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <input
              placeholder="Descripción (opcional)"
              value={productForm.description}
              onChange={(e) => setProductForm(f => ({ ...f, description: e.target.value }))}
              style={{ ...inputStyle, flex: 2 }}
            />
            <select
              aria-label="Categoría del producto"
              value={formCategory}
              onChange={(e) => setProductForm(f => ({ ...f, category: e.target.value }))}
              style={{ ...inputStyle, flex: 1 }}
            >
              {categories.map(cat => (
                <option key={cat.id} value={cat.id}>{cat.name}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {productPhotoUrl && (
              <img src={productPhotoUrl} alt="Foto del producto" style={{ width: '56px', height: '56px', objectFit: 'cover', borderRadius: '8px' }} />
            )}
            <label className="btn-secondary" style={{ padding: '8px 12px', fontSize: '0.8rem', cursor: 'pointer' }}>
              <ImagePlus size={14} /> {uploading ? 'Subiendo…' : productPhotoUrl ? 'Cambiar foto' : 'Agregar foto'}
              <input type="file" accept="image/*" onChange={choosePhoto} disabled={uploading} hidden data-testid="product-photo-input" />
            </label>
            {productPhotoUrl && (
              <button type="button" className="btn-secondary" style={{ padding: '8px 12px', fontSize: '0.8rem' }}
                onClick={() => setProductForm(f => ({ ...f, imageId: null, previewUrl: null }))}>
                Quitar foto
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button type="submit" className="btn-primary" disabled={uploading} style={{ flex: 1, padding: '10px', fontSize: '0.9rem' }}>
              {productForm.id ? 'Guardar Cambios' : 'Agregar Producto'}
            </button>
            {productForm.id && (
              <button type="button" className="btn-secondary" style={{ flex: 1, padding: '10px', fontSize: '0.9rem' }} onClick={() => setProductForm(emptyProductForm)}>
                Cancelar Edición
              </button>
            )}
          </div>
        </form>

        {/* Lista de productos */}
        <div style={{ maxHeight: '35vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {menu.map(item => (
            <div key={item.id} className="menu-admin-row" style={{ ...rowStyle, opacity: item.available === false ? 0.55 : 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                {item.imageId && (
                  <img src={imageUrl(item.imageId)} alt="" style={{ width: '36px', height: '36px', objectFit: 'cover', borderRadius: '6px', flexShrink: 0 }} />
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                    {item.available === false && (
                      <span style={{ color: 'var(--danger)', fontSize: '0.7rem', fontWeight: 800, flexShrink: 0 }}>AGOTADO</span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {formatPrice(item.price)} · {categoryName(item.category)}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                <button
                  className="btn-secondary"
                  style={{ padding: '6px 10px', fontSize: '0.75rem' }}
                  title={item.available === false ? 'Marcar como disponible' : 'Marcar como agotado'}
                  onClick={() => toggleAvailability(item)}
                >
                  {item.available === false ? 'Reponer' : 'Agotar'}
                </button>
                <button className="btn-secondary" style={iconButtonStyle} title={`Editar ${item.name}`} onClick={() => startEditingProduct(item)}>
                  <Pencil size={12} />
                </button>
                <button className="btn-secondary" style={dangerButtonStyle} title={`Eliminar ${item.name}`} onClick={() => deleteProduct(item)}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Categorías */}
        <form onSubmit={submitCategory} style={sectionStyle}>
          <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--accent-gold)' }}>
            {categoryForm.id ? `Editando categoría: ${categoryName(categoryForm.id)}` : 'Categorías'}
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <input
              placeholder="Emoji"
              aria-label="Emoji de la categoría"
              value={categoryForm.icon}
              maxLength={8}
              onChange={(e) => setCategoryForm(f => ({ ...f, icon: e.target.value }))}
              style={{ ...inputStyle, width: '70px', textAlign: 'center' }}
            />
            <input
              placeholder="Nombre de la categoría"
              value={categoryForm.name}
              maxLength={40}
              onChange={(e) => setCategoryForm(f => ({ ...f, name: e.target.value }))}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button type="submit" className="btn-primary" style={{ padding: '10px 14px', fontSize: '0.85rem' }}>
              {categoryForm.id ? 'Guardar' : <><Plus size={14} /> Agregar</>}
            </button>
            {categoryForm.id && (
              <button type="button" className="btn-secondary" style={{ padding: '10px 14px', fontSize: '0.85rem' }} onClick={() => setCategoryForm(emptyCategoryForm)}>
                Cancelar
              </button>
            )}
          </div>
          {categories.map((category, index) => (
            <div key={category.id} className="category-admin-row" style={rowStyle}>
              <span style={{ fontWeight: 700 }}>
                {category.icon && <span style={{ marginRight: '8px' }}>{category.icon}</span>}
                {category.name}
                <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '0.8rem', marginLeft: '8px' }}>
                  ({menu.filter(m => m.category === category.id).length})
                </span>
              </span>
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                <button type="button" className="btn-secondary" style={iconButtonStyle} title={`Subir ${category.name}`} disabled={index === 0} onClick={() => moveCategory(index, -1)}>
                  <ArrowUp size={12} />
                </button>
                <button type="button" className="btn-secondary" style={iconButtonStyle} title={`Bajar ${category.name}`} disabled={index === categories.length - 1} onClick={() => moveCategory(index, 1)}>
                  <ArrowDown size={12} />
                </button>
                <button type="button" className="btn-secondary" style={iconButtonStyle} title={`Editar categoría ${category.name}`}
                  onClick={() => setCategoryForm({ id: category.id, name: category.name, icon: category.icon || '' })}>
                  <Pencil size={12} />
                </button>
                <button type="button" className="btn-secondary" style={dangerButtonStyle} title={`Eliminar categoría ${category.name}`} onClick={() => deleteCategory(category)}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </form>
      </div>
    </div>
  );
}
