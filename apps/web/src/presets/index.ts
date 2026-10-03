import * as Blockly from 'blockly/core';
import { PRESETS, workspaceFromStrategy } from '@monad-hack/strategy';
import type { Preset } from '@monad-hack/strategy';
import { editorCatalog } from '../catalog.ts';

export { PRESETS };
export type { Preset };
/** Listed so the roadmap is visible; they need read and ai.decide (editor plan Phase 8). */
export const COMING_SOON_PRESETS = [
  { title: 'Observe and explain', summary: 'On a schedule, read the price, optionally ask AI for a summary, and record it.' },
  { title: 'AI-gated purchase', summary: 'On a schedule, read the price, ask AI to allow or skip, and buy only on allow.' },
] as const;

/** Replaces the canvas with the preset's blocks, built from its strategy document. Undo restores the previous canvas. */
export function loadPreset(workspace: Blockly.WorkspaceSvg, preset: Preset): void {
  const { blockly } = workspaceFromStrategy(preset.strategy, editorCatalog);
  Blockly.serialization.workspaces.load(blockly as Record<string, unknown>, workspace, { recordUndo: true });
  workspace.scrollCenter();
}
