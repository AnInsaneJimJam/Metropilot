import { useEffect, useRef, useState } from "react";
import * as Blockly from "blockly/core";
import * as En from "blockly/msg/en";
import { BLOCK } from "@monad-hack/strategy";
import { ensureRoot, injectOptions, setUpBlockly } from "./blocks/index.ts";
import { PRESETS, loadPreset } from "./presets/index.ts";
import { saveEnvelope } from "./useLiveValidation.ts";
import { theme } from "./studioTheme.ts";
Blockly.setLocale(En as unknown as Record<string, string>);
setUpBlockly();
export function fitWorkspace(workspace: Blockly.WorkspaceSvg) {
  Blockly.svgResize(workspace);
  workspace.zoomToFit();
  if (workspace.scale > 0.85) {
    workspace.setScale(0.85);
    workspace.scrollCenter();
  }
}
export function useBlocklyStudio(
  stage: string,
  view: string,
  handlers: {
    onSelect: (id: string) => void;
    onChange: (text: string) => void;
  },
) {
  const canvas = useRef<HTMLDivElement>(null);
  const [workspace, setWorkspace] = useState<Blockly.WorkspaceSvg>();
  const callbacks = useRef(handlers);
  callbacks.current = handlers;
  useEffect(() => {
    if (!canvas.current) return;
    const ws = Blockly.inject(canvas.current, {
      ...injectOptions,
      theme,
      renderer: "zelos",
      grid: { spacing: 24, length: 1, colour: "#ccd3ce", snap: false },
      zoom: { controls: true, startScale: 0.85, minScale: 0.35, maxScale: 1.5 },
    });
    if (PRESETS[0]) loadPreset(ws, PRESETS[0]);
    else ensureRoot(ws);
    setWorkspace(ws);
    let last = JSON.stringify(saveEnvelope(ws));
    const first = ws.getBlocksByType(BLOCK.crossesAbove, false)[0];
    if (first) callbacks.current.onSelect(first.id);
    const frame = requestAnimationFrame(() => fitWorkspace(ws));
    const observer = new ResizeObserver(() => Blockly.svgResize(ws));
    observer.observe(canvas.current);
    const listener = (event: Blockly.Events.Abstract) => {
      if (event.type === Blockly.Events.SELECTED) {
        const id = (event as Blockly.Events.Selected).newElementId;
        if (id) callbacks.current.onSelect(id);
      }
      if (!event.isUiEvent) {
        const text = JSON.stringify(saveEnvelope(ws));
        if (text !== last) {
          last = text;
          callbacks.current.onChange(text);
        }
      }
    };
    ws.addChangeListener(listener);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      ws.removeChangeListener(listener);
      ws.dispose();
    };
  }, []);
  useEffect(() => {
    if (workspace && stage === "build") {
      const frame = requestAnimationFrame(() => Blockly.svgResize(workspace));
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [workspace, stage, view]);
  return { canvas, workspace };
}
