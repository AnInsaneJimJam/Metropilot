import type * as Blockly from 'blockly/core';
import { BLOCK, VALUE_TYPES, literalBlock } from '@monad-hack/strategy';
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
    // Shown so the roadmap is visible, but locked in the flyout until the engine supports them (plan Phase 8).
    { kind: 'category', name: 'Coming soon', colour: COLOUR.soon, contents: [block(BLOCK.read, { disabledReasons: ['COMING_SOON'] }), block(BLOCK.aiDecide, { disabledReasons: ['COMING_SOON'] })] },
  ],
};
