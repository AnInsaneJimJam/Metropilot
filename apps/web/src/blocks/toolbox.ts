import type * as Blockly from 'blockly/core';
import { BLOCK, FIELD, INPUT, VALUE_TYPES, literalBlock } from '@monad-hack/strategy';
import { COLOUR } from './definitions.ts';
// One toolbox for rookie and advanced alike; rookie differs only by stricter limits (D17).
// The root strategy block is not in the toolbox: every workspace has exactly one.
const block = (type: string, extra: object = {}) => ({ kind: 'block', type, ...extra });
export const toolbox: Blockly.utils.toolbox.ToolboxDefinition = {
  kind: 'categoryToolbox',
  contents: [
    { kind: 'category', name: 'Triggers', colour: String(COLOUR.trigger), contents: [block(BLOCK.crossesAbove), block(BLOCK.crossesBelow), block(BLOCK.schedule)] },
    { kind: 'category', name: 'Actions', colour: String(COLOUR.action), contents: [block(BLOCK.swap), block(BLOCK.notify), block(BLOCK.stop)] },
    { kind: 'category', name: 'Logic', colour: String(COLOUR.logic), contents: [block(BLOCK.if), block(BLOCK.repeat), block(BLOCK.compare), block(BLOCK.logical), block(BLOCK.not)] },
    { kind: 'category', name: 'Values', colour: String(COLOUR.value), contents: [...VALUE_TYPES.map(type => block(literalBlock(type))), block(BLOCK.arithmetic)] },
    {
      kind: 'category', name: 'Data & AI', colour: String(COLOUR.data), contents: [
        block(BLOCK.read),
        // Arrives with one input wired to market.price, since an AI block needs at least one input.
        block(BLOCK.aiDecide, { extraState: { inputs: ['price'] }, inputs: { [INPUT.notifyInput('price')]: { block: { type: BLOCK.field, fields: { [FIELD.binding]: 'market', [FIELD.recordField]: 'price' } } } } }),
        block(BLOCK.field),
      ],
    },
  ],
};
