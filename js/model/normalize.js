export const ATTR_KINDS = {
  StringAttributeType: { key: 'text', label: 'Text', icon: 'Aa', group: 'Text', order: 1 },
  SingleValueListAttributeType: { key: 'single', label: 'Single-select list', icon: '◉', group: 'Lists', order: 2 },
  MultiValueListAttributeType: { key: 'multi', label: 'Multi-select list', icon: '☰', group: 'Lists', order: 2 },
  NumericAttributeType: { key: 'number', label: 'Number', icon: '#', group: 'Numbers', order: 3 },
  DateAttributeType: { key: 'date', label: 'Date / date-time', icon: '📅', group: 'Dates', order: 4 },
  BooleanAttributeType: { key: 'boolean', label: 'True / False', icon: '◐', group: 'Booleans', order: 5 },
  ScriptAttributeType: { key: 'script', label: 'Script', icon: '</>', group: 'Scripts', order: 6 },
};

const OTHER = { key: 'other', label: 'Attribute', icon: '•', group: 'Other', order: 9 };

export function isAttributeDiscriminator(d) {
  return typeof d === 'string' && /AttributeType$/.test(d);
}

export function attributeDiscriminator(rec) {
  return rec?.attributeTypeDiscriminator || rec?.resourceDiscriminator || rec?.resourceType || null;
}

// record = full attribute type (optional) to refine the label (rich text, integer, date-time).
export function attributeKind(discriminator, record) {
  const base = ATTR_KINDS[discriminator] ?? OTHER;
  let label = base.label;
  if (discriminator === 'StringAttributeType' && record?.stringType === 'RICH_TEXT') label = 'Rich text';
  if (discriminator === 'NumericAttributeType' && record?.isInteger) label = 'Integer';
  if (discriminator === 'DateAttributeType' && record?.dateTime === true) label = 'Date-time';
  if (discriminator === 'DateAttributeType' && record?.dateTime === false) label = 'Date';
  return { ...base, label };
}

export const KIND_GROUP_ORDER = ['Text', 'Lists', 'Numbers', 'Dates', 'Booleans', 'Scripts', 'Other'];

export function indexById(list) {
  const m = new Map();
  for (const x of list ?? []) if (x?.id) m.set(x.id, x);
  return m;
}
