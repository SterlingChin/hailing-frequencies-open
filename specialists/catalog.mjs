// Authored fiction. A lookup neither reserves inventory nor places an order.
export function lookupParts({ equipment_model } = {}) {
  const model = typeof equipment_model === 'string' ? equipment_model.trim().toUpperCase() : '';
  if (!['RPL-2400', 'RPL-7'].includes(model)) return { ok: false, error: { code: 'compatible_part_not_found' } };
  return { ok: true, fictional: true, source_id: `federation-demo-${model.toLowerCase()}-parts-001`,
    equipment_model: model, part_name: 'Thermal regulator', part_number: `${model}-TR-01`,
    status: 'available', quantity: 1, location: 'Fictional station depot',
    summary: `One compatible ${model} thermal regulator is available at the fictional station depot. Nothing is reserved or ordered.` };
}
