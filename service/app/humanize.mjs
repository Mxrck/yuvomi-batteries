// resumen_humano: one line in Spanish per result, built only from what the domain returned, so
// the agent can repeat it and Marco can correct it on the spot. The module page has its own
// translated texts; this line is for conversation.

const amount = (l) => `${l.quantity} ${l.pool_name}`;

function poolOf(result, poolId) {
  return result.pools?.find((p) => p.id === poolId);
}

function age(days) {
  if (days <= 0) return 'puestas hoy';
  return days === 1 ? 'puestas hace 1 día' : `puestas hace ${days} días`;
}

export function poolLine(p) {
  const b = p.breakdown;
  return `${p.name}: ${p.total} = ${b.device} en aparatos · ${b.charger} en cargador · ${b.drawer} en cajón · ${b.missing} sin ubicar`;
}

function stockLine(pool) {
  return `${pool.name}: total ${pool.total} (${pool.breakdown.missing} sin ubicar)`;
}

function newPoolLine(pool) {
  return `Nuevo stock ${pool.name}: ${pool.total} (${pool.breakdown.missing} sin ubicar)`;
}

// A place card from placesList: "Tren Percy: 3 AAA Duracell Recharge, puestas hoy".
export function placeLine(card) {
  const what = card.items.map((i) => `${i.quantity} ${i.pool_name}`).join(' + ');
  if (card.kind !== 'device') return `${card.label}: ${what}`;
  const oldest = Math.max(...card.items.map((i) => i.age_days));
  return `${card.label}: ${what}, ${age(oldest)}`;
}

export function humanize(operation, result) {
  switch (operation) {
    case 'createPool':
      return newPoolLine(result);
    case 'updatePool':
    case 'addStock':
      return stockLine(result);
    case 'receiveStock':
      return result.created ? newPoolLine(result.pool) : stockLine(result.pool);
    case 'archivePool':
      return `${result.name} archivado`;
    case 'place':
      return result.legs.map((l) => `${l.to.label}: ${amount(l)} (desde ${l.from.label})`).join('; ');
    case 'move':
      return result.legs.map((l) => `${amount(l)}: ${l.from.label} → ${l.to.label}`).join('; ');
    case 'find':
      return result.legs.map((l) => {
        const missing = poolOf(result, l.pool_id)?.breakdown.missing ?? 0;
        return `Encontradas ${amount(l)} en ${l.to.label}; quedan ${missing} sin ubicar`;
      }).join('; ');
    case 'change': {
      const fresh = result.legs.filter((l) => l.role === 'new');
      const old = result.legs.find((l) => l.role === 'old');
      const where = old?.to ? old.to.label : 'basura';
      const device = fresh[0]?.to.label ?? old?.from.label;
      return `${device}: ${fresh.map(amount).join(' + ')} nuevas; las viejas → ${where}`;
    }
    case 'discard':
      return result.legs.map((l) => {
        const total = poolOf(result, l.pool_id)?.total;
        return `Desechadas ${amount(l)} de ${l.from.label}; el total queda en ${total}`;
      }).join('; ');
    default:
      throw new Error(`no resumen_humano for ${operation}`);
  }
}
