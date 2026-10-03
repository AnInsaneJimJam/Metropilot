import * as Blockly from 'blockly/core';
import { BLOCK, newNodeId } from '@monad-hack/strategy';
import { defineStrategyBlocks } from './definitions.ts';
import { toolbox } from './toolbox.ts';
export { toolbox } from './toolbox.ts';

/**
 * Editor-wide Blockly setup, run once before injecting:
 * - every block ID is a legal node ID (`b` + 10 base36), so one ID names the node everywhere (D19).
 *   Blockly 13 routes all generated IDs through `utils.idGenerator.TEST_ONLY.genUid`; copies are pasted
 *   without IDs (`saveIds: false`), so pasted blocks get fresh ones.
 * - blocks cannot be disabled (D20).
 */
export function setUpBlockly(): void {
  Blockly.utils.idGenerator.TEST_ONLY.genUid = newNodeId;
  if (Blockly.ContextMenuRegistry.registry.getItem('blockDisable')) Blockly.ContextMenuRegistry.registry.unregister('blockDisable');
  defineStrategyBlocks();
}

export const injectOptions: Blockly.BlocklyOptions = {
  toolbox,
  disable: false,
  maxInstances: { [BLOCK.root]: 1 },
  trashcan: true,
  zoom: { controls: true, startScale: 0.9 },
  move: { scrollbars: true, drag: true, wheel: true },
};

/** Adds the single root block when the workspace has none (new strategy). */
export function ensureRoot(workspace: Blockly.WorkspaceSvg): Blockly.Block {
  const existing = workspace.getBlocksByType(BLOCK.root, false)[0];
  if (existing) return existing;
  return Blockly.serialization.blocks.append({ type: BLOCK.root, x: 24, y: 24 }, workspace);
}
