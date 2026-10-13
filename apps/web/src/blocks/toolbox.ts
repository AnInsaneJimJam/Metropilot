import type * as Blockly from 'blockly/core';
import { BLOCK, FIELD, INPUT, VALUE_TYPES, literalBlock } from '@monad-hack/strategy';
// Category styles are defined with the block styles in studioTheme.ts.
// One toolbox for rookie and advanced alike; rookie differs only by stricter limits (D17).
// The root strategy block is not in the toolbox: every workspace has exactly one.
const block = (type: string, extra: object = {}) => ({ kind: 'block', type, ...extra });
/** Adds a per-category class to the icon so CSS can draw its colour key. */
const icon = (category: string) => ({ icon: `blocklyToolboxCategoryIcon category-${category}` });
export const toolbox: Blockly.utils.toolbox.ToolboxDefinition = {
  kind: 'categoryToolbox',
  contents: [
    { kind: 'category', name: 'Triggers', categorystyle: 'trigger_category', cssconfig: icon('trigger'), contents: [block(BLOCK.crossesAbove), block(BLOCK.crossesBelow), block(BLOCK.schedule)] },
    { kind: 'category', name: 'Actions', categorystyle: 'action_category', cssconfig: icon('action'), contents: [block(BLOCK.swap), block(BLOCK.notify), block(BLOCK.stop)] },
    { kind: 'category', name: 'Logic', categorystyle: 'logic_category', cssconfig: icon('logic'), contents: [block(BLOCK.if), block(BLOCK.repeat), block(BLOCK.compare), block(BLOCK.logical), block(BLOCK.not)] },
    { kind: 'category', name: 'Values', categorystyle: 'value_category', cssconfig: icon('value'), contents: [...VALUE_TYPES.map(type => block(literalBlock(type))), block(BLOCK.arithmetic)] },
    {
      kind: 'category', name: 'Data & AI', categorystyle: 'data_category', cssconfig: icon('data'), contents: [
        block(BLOCK.read),
        // Arrives with one input wired to market.price, since an AI block needs at least one input.
        block(BLOCK.aiDecide, { extraState: { inputs: ['price'] }, inputs: { [INPUT.notifyInput('price')]: { block: { type: BLOCK.field, fields: { [FIELD.binding]: 'market', [FIELD.recordField]: 'price' } } } } }),
        block(BLOCK.field),
      ],
    },
  ],
};
