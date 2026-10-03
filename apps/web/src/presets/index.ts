import * as Blockly from 'blockly/core';
import { PRESETS, workspaceFromStrategy } from '@monad-hack/strategy';
import type { Preset } from '@monad-hack/strategy';
import { editorCatalog } from '../catalog.ts';

export { PRESETS };
export type { Preset };

/** Replaces the canvas with the preset's blocks, built from its strategy document. Undo restores the previous canvas. */
export function loadPreset(workspace: Blockly.WorkspaceSvg, preset: Preset): void {
  const { blockly } = workspaceFromStrategy(preset.strategy, editorCatalog);
  Blockly.serialization.workspaces.load(blockly as Record<string, unknown>, workspace, { recordUndo: true });
  workspace.scrollCenter();
}
