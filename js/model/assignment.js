import { attributeKind, isAttributeDiscriminator } from './normalize.js';

const DEFAULT_SCOPE = 'default';

// Accepts both assignedCharacteristicTypeReferences (current) and characteristicTypes (deprecated).
export function characteristicRefs(assignment) {
  if (Array.isArray(assignment?.assignedCharacteristicTypeReferences)) return assignment.assignedCharacteristicTypeReferences;
  return (assignment?.characteristicTypes ?? []).map((c) => {
    const target = c.attributeType ?? c.relationType ?? c.complexRelationType ?? {};
    const disc = c.attributeType
      ? c.attributeType.attributeTypeDiscriminator ?? c.attributeType.resourceType ?? 'AttributeType'
      : c.relationType ? 'RelationType' : c.complexRelationType ? 'ComplexRelationType' : c.assignedResourceType;
    return {
      id: c.id,
      assignedResourceReference: { id: target.id, name: target.name ?? target.role, resourceDiscriminator: disc },
      assignedResourcePublicId: target.publicId,
      minimumOccurrences: c.minimumOccurrences,
      maximumOccurrences: c.maximumOccurrences,
      system: c.system,
      readOnly: c.readOnly,
      relationTypeDirection: c.roleDirection ?? c.relationTypeDirection,
      relationTypeRestriction: c.restriction ?? c.relationTypeRestriction,
      matchingLegTypesIds: c.matchingLegTypesIds,
    };
  });
}

export function relationDirections(ref, relType, typeId, ancestorIds = []) {
  switch (ref?.relationTypeDirection) {
    case 'TO_TARGET': return ['out'];
    case 'TO_SOURCE': return ['in'];
    case 'BOTH': return ['out', 'in'];
    default: break;
  }
  const lineage = new Set([typeId, ...ancestorIds]);
  const src = relType?.sourceType?.id;
  const tgt = relType?.targetType?.id;
  if (src && tgt && src === tgt && lineage.has(src)) return ['out', 'in'];
  if (src && lineage.has(src)) return ['out'];
  return ['in'];
}

export const itemKey = (item) =>
  item.itemType === 'attr' ? `attr:${item.id}` : item.itemType === 'rel' ? `rel:${item.id}:${item.direction}` : `complex:${item.id}`;

function occurrence(ref) {
  const min = Number.isFinite(ref?.minimumOccurrences) ? ref.minimumOccurrences : 0;
  const max = Number.isFinite(ref?.maximumOccurrences) ? ref.maximumOccurrences : null;
  return { min, max, required: min >= 1, multi: max === null || max > 1 };
}

function emptyScope(assignment) {
  return {
    id: assignment?.scope?.id ?? DEFAULT_SCOPE,
    name: assignment?.scope?.name ?? 'Default',
    scope: assignment?.scope ?? null,
    assignmentIds: [],
    attributes: [],
    relations: [],
    complexRelations: [],
    statuses: [],
    domainTypes: [],
    validationRules: [],
    dataQualityRules: [],
    raw: [],
  };
}

function pushUnique(list, items) {
  for (const x of items ?? []) if (x?.id && !list.some((y) => y.id === x.id)) list.push(x);
}

export function buildTypeModel({ typeId, assignments, ancestorIds = [], relationTypesById = new Map(), attributeTypesById = new Map(), complexRelationTypesById = new Map() }) {
  const scopes = new Map();
  for (const a of assignments ?? []) {
    const key = a?.scope?.id ?? DEFAULT_SCOPE;
    if (!scopes.has(key)) scopes.set(key, emptyScope(a));
    const scope = scopes.get(key);
    scope.assignmentIds.push(a.id);
    scope.raw.push(a);
    pushUnique(scope.statuses, a.statuses);
    pushUnique(scope.domainTypes, a.domainTypes);
    pushUnique(scope.validationRules, a.validationRules);
    pushUnique(scope.dataQualityRules, a.dataQualityRules);
    const seen = new Set([...scope.attributes, ...scope.relations, ...scope.complexRelations].map(itemKey));

    for (const ref of characteristicRefs(a)) {
      const r = ref?.assignedResourceReference;
      if (!r?.id) continue;
      const disc = r.resourceDiscriminator ?? r.resourceType;
      const base = {
        id: r.id,
        name: r.name ?? '',
        publicId: ref.assignedResourcePublicId ?? null,
        assignedId: ref.id ?? null,
        system: !!ref.system,
        readOnly: !!ref.readOnly,
        inheritedFrom: null,
        ...occurrence(ref),
      };
      if (isAttributeDiscriminator(disc)) {
        const full = attributeTypesById.get(r.id);
        const discriminator = disc === 'AttributeType' ? full?.attributeTypeDiscriminator ?? disc : disc;
        const item = { ...base, itemType: 'attr', discriminator, kind: attributeKind(discriminator, full), description: full?.description ?? '' };
        if (!seen.has(itemKey(item))) {
          seen.add(itemKey(item));
          scope.attributes.push(item);
        }
      } else if (disc === 'RelationType' || disc === 'DerivedRelationType') {
        const rt = relationTypesById.get(r.id);
        for (const direction of relationDirections(ref, rt, typeId, ancestorIds)) {
          const defaultOther = direction === 'out' ? rt?.targetType : rt?.sourceType;
          const restriction = ref.relationTypeRestriction?.id ? ref.relationTypeRestriction : null;
          const item = {
            ...base,
            itemType: 'rel',
            derived: disc === 'DerivedRelationType',
            direction,
            role: rt?.role ?? r.name ?? '',
            coRole: rt?.coRole ?? '',
            label: (direction === 'out' ? rt?.role : rt?.coRole) || r.name || '(relation)',
            sourceType: rt?.sourceType ?? null,
            targetType: rt?.targetType ?? null,
            otherType: restriction ?? defaultOther ?? { id: null, name: '?' },
            restricted: !!restriction,
            description: rt?.description ?? '',
          };
          if (!seen.has(itemKey(item))) {
            seen.add(itemKey(item));
            scope.relations.push(item);
          }
        }
      } else if (disc === 'ComplexRelationType') {
        const crt = complexRelationTypesById.get(r.id);
        const item = { ...base, itemType: 'complex', name: crt?.name ?? base.name, legIds: ref.matchingLegTypesIds ?? [], legTypes: crt?.legTypes ?? [], attributeTypes: crt?.attributeTypes ?? [], symbolData: crt?.symbolData ?? null, description: crt?.description ?? '' };
        if (!seen.has(itemKey(item))) {
          seen.add(itemKey(item));
          scope.complexRelations.push(item);
        }
      }
    }
  }
  const list = [...scopes.values()].sort((x, y) => (x.id === DEFAULT_SCOPE ? -1 : y.id === DEFAULT_SCOPE ? 1 : x.name.localeCompare(y.name)));
  for (const s of list) {
    s.attributes.sort((x, y) => x.kind.order - y.kind.order || x.name.localeCompare(y.name));
    s.relations.sort((x, y) => (x.direction === y.direction ? 0 : x.direction === 'out' ? -1 : 1) || String(x.otherType?.name).localeCompare(String(y.otherType?.name)) || x.label.localeCompare(y.label));
    s.complexRelations.sort((x, y) => x.name.localeCompare(y.name));
    s.defaultStatusId = s.statuses[0]?.id ?? null;
  }
  return { typeId, scopes: list };
}

export function scopeKeys(scope) {
  return new Set([...scope.attributes, ...scope.relations, ...scope.complexRelations].map(itemKey));
}

export function pickScope(model, scopeId) {
  return model?.scopes.find((s) => s.id === scopeId) ?? model?.scopes.find((s) => s.id === DEFAULT_SCOPE) ?? model?.scopes[0] ?? null;
}

// ancestorKeys: [{ id, name, keys:Set }] ordered nearest parent first. An item is inherited from
// the farthest ancestor reachable through an unbroken chain of ancestors that also carry it.
export function applyInheritance(scope, ancestorKeys) {
  for (const item of [...scope.attributes, ...scope.relations, ...scope.complexRelations]) {
    const key = itemKey(item);
    let origin = null;
    for (const anc of ancestorKeys) {
      if (!anc.keys?.has(key)) break;
      origin = anc;
    }
    item.inheritedFrom = origin ? { id: origin.id, name: origin.name } : null;
  }
  return scope;
}

export function summarize(scope) {
  const attrs = scope?.attributes ?? [];
  const rels = scope?.relations ?? [];
  return {
    attributes: attrs.length,
    required: attrs.filter((a) => a.required).length,
    optional: attrs.filter((a) => !a.required).length,
    relations: rels.length,
    outgoing: rels.filter((r) => r.direction === 'out').length,
    incoming: rels.filter((r) => r.direction === 'in').length,
    complex: scope?.complexRelations?.length ?? 0,
    inherited: [...attrs, ...rels].filter((x) => x.inheritedFrom).length,
  };
}

export function formatOccurrence({ min, max }) {
  return `${min ?? 0}..${max == null ? '∞' : max}`;
}
