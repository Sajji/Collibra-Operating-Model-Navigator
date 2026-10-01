const KINDS = new Set(['attr', 'rel', 'complex']);

export function parseHash(hash) {
  const raw = String(hash ?? '').replace(/^#\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const params = new URLSearchParams(query);
  const route = { typeId: null, selection: null, scope: params.get('scope') || null, inherited: params.get('inherited') !== '0' };
  if (segs[0] === 'type' && segs[1]) {
    route.typeId = segs[1];
    if (KINDS.has(segs[2]) && segs[3]) {
      route.selection = { kind: segs[2], id: segs[3] };
      if (segs[2] === 'rel' && (segs[4] === 'in' || segs[4] === 'out')) route.selection.dir = segs[4];
    }
  }
  return route;
}

export function formatHash({ typeId, selection, scope, inherited = true } = {}) {
  if (!typeId) return '#/';
  let h = `#/type/${encodeURIComponent(typeId)}`;
  if (selection && KINDS.has(selection.kind) && selection.id) {
    h += `/${selection.kind}/${encodeURIComponent(selection.id)}`;
    if (selection.kind === 'rel' && selection.dir) h += `/${selection.dir}`;
  }
  const params = new URLSearchParams();
  if (scope && scope !== 'default') params.set('scope', scope);
  if (inherited === false) params.set('inherited', '0');
  const q = params.toString();
  return q ? `${h}?${q}` : h;
}
