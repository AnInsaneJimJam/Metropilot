import { useEffect, useRef } from 'react';
import * as Blockly from 'blockly/core';
import * as En from 'blockly/msg/en';
import { syntheticCatalog } from '@monad-hack/strategy';

Blockly.setLocale(En as unknown as Record<string, string>);

export function EditorPage() {
  const canvas = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    // Blocks and toolbox arrive in Phase 3; this proves the canvas mounts and disposes cleanly.
    const workspace = Blockly.inject(canvas.current, { trashcan: true, zoom: { controls: true }, move: { scrollbars: true, drag: true, wheel: true } });
    return () => workspace.dispose();
  }, []);
  return (
    <main className="editor">
      <div ref={canvas} className="editor-canvas" role="region" aria-label="Strategy blocks canvas" />
      <aside className="editor-panel" aria-label="Strategy details">
        <h2>Paper catalog</h2>
        <ul>
          {Object.entries(syntheticCatalog.assets).map(([ref, asset]) => <li key={ref}>{ref} ({asset.decimals} decimals{asset.native ? ', native' : ''})</li>)}
        </ul>
      </aside>
    </main>
  );
}
