// Precio con separador de miles a la argentina ("$1.800"). Los precios son enteros en
// pesos; si algún día hay centavos, Intl los muestra con coma.
const priceFormat = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });

export const formatPrice = (amount) => `$${priceFormat.format(Number(amount) || 0)}`;
