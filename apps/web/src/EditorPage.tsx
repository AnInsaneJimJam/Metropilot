import { useCallback, useEffect, useRef, useState } from "react";
import * as Blockly from "blockly/core";
import { workspaceFromStrategy } from "@monad-hack/strategy";
import { paperBudgetIssue } from "@monad-hack/contracts";
import type { Experience } from "@monad-hack/strategy";
import { PRESETS } from "./presets/index.ts";
import { RehearsePanel } from "./rehearse/RehearsePanel.tsx";
import { StrategyCanvas } from "./StrategyCanvas.tsx";
import { Outline } from "./Outline.tsx";
import { saveEnvelope, useLiveValidation } from "./useLiveValidation.ts";
import { BudgetReview, DEFAULT_BUDGET } from "./BudgetReview.tsx";
import { fieldOf } from "./validation.ts";
import { useSaveRevision } from "./useSaveRevision.ts";
import { useBlocklyStudio, fitWorkspace } from "./useBlocklyStudio.ts";
import { api, ApiError } from "./api.ts";
import type { SaveRequest, SavedAgent } from "./api.ts";
import { editorCatalog } from "./catalog.ts";
import { StrategyHeading } from "./StrategyHeading.tsx";
import type { Notice, Stage } from "./StrategyHeading.tsx";
import { WorkspaceSidebar } from "./WorkspaceSidebar.tsx";
import { PresetPicker } from "./PresetPicker.tsx";
import { OperatePanel } from "./OperatePanel.tsx";
export function EditorPage() {
  const [stage, setStage] = useState<Stage>("build");
  const [experience, setExperience] = useState<Experience>("rookie");
  const [name, setName] = useState(PRESETS[0]!.title);
  const [budget, setBudget] = useState(DEFAULT_BUDGET);
  const [selected, setSelected] = useState<string>();
  const [focusRequest, setFocusRequest] = useState<{
    field: string | undefined;
  }>();
  const [agents, setAgents] = useState<SavedAgent[]>([]);
  const [current, setCurrent] = useState<SavedAgent>();
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const { saving, persist } = useSaveRevision();
  const [dirty, setDirty] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [view, setView] = useState<"blocks" | "rules">(() =>
    window.matchMedia("(max-width: 680px)").matches ? "rules" : "blocks",
  );
  const baselineWorkspace = useRef("");
  const generation = useRef(0);
  const { canvas, workspace } = useBlocklyStudio(stage, view, {
    onSelect: setSelected,
    onChange: (text) => {
      generation.current++;
      if (text !== baselineWorkspace.current) setDirty(true);
    },
  });
  const validation = useLiveValidation(workspace, {
    experience,
    mode: "paper",
  });
  const budgetIssue = paperBudgetIssue(
    budget,
    Boolean(validation?.program?.bounds.aiCalls),
  );
  const refresh = useCallback(async () => {
    try {
      await api("/session");
      const list = await api<{ items: SavedAgent[] }>("/agents?limit=100");
      setAgents(list.items);
      setConnected(true);
      setNotice(undefined);
    } catch {
      setConnected(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const dismiss = useCallback(() => setNotice(undefined), []);
  const change = () => {
    generation.current++;
    setDirty(true);
  };
  const select = useCallback(
    (id: string) => {
      setSelected(id);
      const block = workspace?.getBlockById(id);
      if (block) {
        workspace?.centerOnBlock(id);
        (block as Blockly.BlockSvg).select();
      }
    },
    [workspace],
  );
  const focus = useCallback(
    (id: string, field: string | undefined) => {
      setStage("build");
      select(id);
      setFocusRequest({ field });
    },
    [select],
  );
  const replace = (action: () => void) => {
    if (saving) {
      setNotice({
        text: "Wait for this save to finish before switching strategies.",
        tone: "warn",
      });
      return;
    }
    if (dirty && !window.confirm("Replace your unsaved draft?")) return;
    setSelected(undefined);
    action();
    setNotice(undefined);
  };
  const open = (agent: SavedAgent) =>
    replace(() => {
      if (!workspace) return;
      Blockly.serialization.workspaces.load(agent.workspace.blockly, workspace);
      setName(agent.name);
      setExperience(agent.experience);
      setBudget(agent.budget);
      setCurrent(agent);
      setSelected(workspace.getTopBlocks(false)[0]?.getChildren(false)[0]?.id);
      requestAnimationFrame(() => fitWorkspace(workspace));
      setStage("build");
      setShowPresets(false);
      baselineWorkspace.current = JSON.stringify(saveEnvelope(workspace));
      setDirty(false);
    });
  const preset = (id: string) =>
    replace(() => {
      const p = PRESETS.find((item) => item.id === id);
      if (!workspace || !p) return;
      const envelope = workspaceFromStrategy(p.strategy, editorCatalog);
      Blockly.serialization.workspaces.load(
        envelope.blockly as Record<string, unknown>,
        workspace,
        { recordUndo: true },
      );
      workspace.scrollCenter();
      setSelected(workspace.getTopBlocks(false)[0]?.getChildren(false)[0]?.id);
      requestAnimationFrame(() => fitWorkspace(workspace));
      setName(p.title);
      setCurrent(undefined);
      setBudget(DEFAULT_BUDGET);
      setExperience("rookie");
      change();
      setShowPresets(false);
      setStage("build");
    });
  const save = async () => {
    if (
      !workspace ||
      !validation?.program ||
      validation.problems.length ||
      budgetIssue ||
      saving
    )
      return;
    const body: SaveRequest = {
      schemaVersion: "control-workspace/1",
      name: name.trim(),
      experience,
      workspace: saveEnvelope(workspace) as SaveRequest["workspace"],
      budget,
    };
    const mine = generation.current;
    setNotice(undefined);
    try {
      const result = await persist(body, current);
      setCurrent(result);
      setAgents((a) => [result, ...a.filter((item) => item.id !== result.id)]);
      if (mine === generation.current) {
        baselineWorkspace.current = JSON.stringify(saveEnvelope(workspace));
        setDirty(false);
      }
      setNotice({
        text: `Revision ${result.version} saved. ${mine !== generation.current ? "Newer edits are still unsaved." : ""}`,
        tone: mine !== generation.current ? "warn" : "ok",
      });
    } catch (error) {
      setNotice({ text: (error as Error).message, tone: "error" });
      if (error instanceof ApiError && error.status === 401)
        setConnected(false);
      if (error instanceof ApiError && error.nodeId)
        focus(error.nodeId, fieldOf(error.fieldPath ?? ""));
    }
  };
  const outline = (
    <Outline
      expanded={view === "rules"}
      workspace={workspace}
      selected={selected}
      onSelect={select}
      focusRequest={focusRequest}
    />
  );
  return (
    <div className={`studio stage-${stage}`}>
      <a className="skip-link" href="#workspace">
        Skip to strategy
      </a>
      <WorkspaceSidebar
        agents={agents}
        currentId={current?.id}
        connected={connected}
        onNew={() => setShowPresets(true)}
        onOpen={open}
        onReconnect={() => void refresh()}
      />
      <div className="main-shell">
        <StrategyHeading
          name={name}
          dirty={dirty}
          current={current}
          connected={connected}
          saving={saving}
          validation={validation}
          budgetIssue={budgetIssue}
          notice={notice}
          stage={stage}
          onName={(value) => {
            setName(value);
            change();
          }}
          onSave={() => void save()}
          onDismiss={dismiss}
          onReconnect={() => void refresh()}
          onStage={setStage}
        />
        <main id="workspace">
          {showPresets && (
            <PresetPicker
              onClose={() => setShowPresets(false)}
              onPick={preset}
            />
          )}
          <StrategyCanvas
            visible={stage === "build"}
            canvas={canvas}
            view={view}
            setView={setView}
            outline={outline}
            experience={experience}
            onExperience={(e) => {
              setExperience(e);
              change();
            }}
            validation={validation}
            focus={focus}
            onPatterns={() => setShowPresets(true)}
            onFit={() => workspace && fitWorkspace(workspace)}
            onZoom={(step) => workspace?.zoomCenter(step)}
            onUndo={() => workspace?.undo(false)}
          />
          {stage === "rehearse" && (
            <RehearsePanel
              workspace={workspace}
              program={validation?.program}
              onOperate={() => setStage("operate")}
            />
          )}
          {stage === "review" && (
            <BudgetReview
              budget={budget}
              onBudget={(b) => {
                setBudget(b);
                change();
              }}
              validation={validation}
              onOperate={() => setStage("operate")}
            />
          )}
          {stage === "operate" && (
            <OperatePanel
              current={current}
              dirty={dirty}
              connected={connected}
              validation={validation}
            />
          )}
        </main>
      </div>
    </div>
  );
}
