export const state = {
  baseURL: '',
  user: null,
  meta: {
    assetTypes: [],
    assetTypesById: new Map(),
    attributeTypesById: new Map(),
    relationTypesById: new Map(),
    complexRelationTypesById: new Map(),
    statusesById: new Map(),
    domainTypesById: new Map(),
    loaded: false,
  },
  hierarchy: null,
  route: { typeId: null, selection: null, scope: null, inherited: true },
  typeModel: null,
  scope: null,
  counts: {},
};
