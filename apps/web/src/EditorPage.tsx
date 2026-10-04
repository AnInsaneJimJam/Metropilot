import { useCallback, useEffect, useRef, useState } from 'react';
import * as Blockly from 'blockly/core';
import * as En from 'blockly/msg/en';
import type { Experience } from '@monad-hack/strategy';
import { ensureRoot, injectOptions, setUpBlockly } from './blocks/index.ts';
import { loadPreset, PRESETS } from './presets/index.ts';
import type { Preset } from './presets/index.ts';
import { RehearsePanel } from './rehearse/RehearsePanel.tsx';
import { StrategyPanel } from './StrategyPanel.tsx';
import { Outline } from './Outline.tsx';
import { useLiveValidation } from './useLiveValidation.ts';

Blockly.setLocale(En as unknown as Record<string, string>);
setUpBlockly();

export function EditorPage() {
  const canvas = useRef<HTMLDivElement>(null);
  const [workspace, setWorkspace] = useState<Blockly.WorkspaceSvg>();
  // Rookie by default: same blocks, stricter limits (D17). Only paper exists until deployment (G3).
  const [experience, setExperience] = useState<Experience>('rookie');
  const validation = useLiveValidation(workspace, { experience, mode: 'paper' });

  useEffect(() => {
    if (!canvas.current) return;
    const ws = Blockly.inject(canvas.current, injectOptions);
    ensureRoot(ws);
    setWorkspace(ws);
    return () => { setWorkspace(undefined); ws.dispose(); };
  }, []);

  const [selected, setSelected] = useState<string>();
  const [focusRequest, setFocusRequest] = useState<{ field: string | undefined }>();
  // Picking a block (outline or problem link) shows it on the canvas; a problem link also moves focus into its form.
  const onSelect = useCallback((id: string) => {
    setSelected(id);
    if (workspace?.getBlockById(id)) { workspace.centerOnBlock(id); (workspace.getBlockById(id) as Blockly.BlockSvg).select(); }
  }, [workspace]);
  const onFocusBlock = useCallback((id: string, field: string | undefined) => { onSelect(id); setFocusRequest({ field }); }, [onSelect]);
  const onLoadPreset = useCallback((preset: Preset) => { if (workspace) loadPreset(workspace, preset); }, [workspace]);
  const onStartTutorial = useCallback(() => {
    setExperience('rookie');
    const threshold = PRESETS.find(p => p.id === 'threshold_sale');
    if (workspace && threshold) loadPreset(workspace, threshold);
  }, [workspace]);

  return (
    <main className="editor">
      <div ref={canvas} className="editor-canvas" role="region" aria-label="Strategy blocks canvas" />
      <StrategyPanel experience={experience} onExperience={setExperience} validation={validation}
        onFocusBlock={onFocusBlock} onLoadPreset={onLoadPreset} onStartTutorial={onStartTutorial}
        outline={<Outline workspace={workspace} selected={selected} onSelect={onSelect} focusRequest={focusRequest} />}>
        <RehearsePanel workspace={workspace} program={validation?.program} />
      </StrategyPanel>
    </main>
  );
}
