import { useEffect, useRef, useState } from "react";
import * as Blockly from "blockly/core";
import { BLOCK, FIELD, AMOUNT_KIND } from "@monad-hack/strategy";
import { assetSymbol } from "./catalog.ts";
import { rejectionReason } from "./blocks/fields.ts";

// Keyboard and screen-reader alternative to dragging: the root's triggers and statements as a nested list,
// and a labelled form for the selected block's fields. Edits go through Blockly's own field validators and
// events, so the canvas, undo and live validation all see them exactly like canvas edits.

type Block = Blockly.Block;
type EditableField =
  Blockly.FieldTextInput | Blockly.FieldNumber | Blockly.FieldDropdown;

/** The block's own field text, without its children. */
function summary(block: Block): string {
  const value = (name: string) => String(block.getFieldValue(name) ?? "");
  if (block.type === BLOCK.root) return "Strategy settings";
  if (block.type === BLOCK.crossesAbove || block.type === BLOCK.crossesBelow)
    return `when price crosses ${block.type === BLOCK.crossesAbove ? "above" : "below"} ${value(FIELD.threshold)}`;
  if (block.type === BLOCK.swap)
    return `swap ${value(FIELD.amount)}${value(FIELD.amountKind) === AMOUNT_KIND.percent ? "%" : ""} ${assetSymbol(value(FIELD.tokenIn))} → ${assetSymbol(value(FIELD.tokenOut))}`;
  if (block.type === BLOCK.schedule)
    return `Every ${value(FIELD.interval)} seconds`;
  if (block.type === BLOCK.notify) return "Record a note";
  if (block.type === BLOCK.aiDecide) return "Ask AI for a bounded answer";
  if (block.type === BLOCK.read) return `Read ${value(FIELD.operation)}`;
  return (
    block.inputList
      .flatMap((input) => input.fieldRow.map((f) => f.getText().trim()))
      .filter(Boolean)
      .join(" ") || block.type
  );
}

/** Child blocks in input order: statement stacks and plugged value blocks, with the input's label. */
function children(block: Block): { label: string; blocks: Block[] }[] {
  return block.inputList
    .filter((input) => input.connection)
    .map((input) => {
      const blocks: Block[] = [];
      for (
        let b = input.connection!.targetBlock();
        b;
        b =
          input.type === Blockly.inputs.inputTypes.STATEMENT
            ? b.getNextBlock()
            : null
      )
        blocks.push(b);
      const label = input.fieldRow
        .map((f) => f.getText().trim())
        .filter(Boolean)
        .join(" ");
      return {
        label:
          label ||
          (input.type === Blockly.inputs.inputTypes.STATEMENT
            ? "blocks"
            : "value"),
        blocks,
      };
    })
    .filter((group) => group.blocks.length > 0 || block.type === BLOCK.root);
}

/** Editable fields with the label text that precedes each one on its row. */
function editableFields(
  block: Block,
): { field: EditableField; label: string }[] {
  const result: { field: EditableField; label: string }[] = [];
  for (const input of block.inputList) {
    let pending: string[] = [];
    for (const field of input.fieldRow) {
      if (
        (field instanceof Blockly.FieldTextInput ||
          field instanceof Blockly.FieldNumber ||
          field instanceof Blockly.FieldDropdown) &&
        field.name &&
        field.EDITABLE
      ) {
        result.push({
          field,
          label:
            pending.join(" ") ||
            ({
              [FIELD.amountKind]: "Amount type",
              [FIELD.tokenIn]: "From asset",
              [FIELD.bind]: "Result name",
              [FIELD.recordField]: "Result field",
              [FIELD.binding]: "Read from",
            }[field.name] ??
              field.name.replaceAll("_", " ").toLowerCase()),
        });
        pending = [];
      } else if (field.getText().trim()) pending.push(field.getText().trim());
    }
  }
  return result;
}

function FieldEditor({
  field,
  label,
  id,
}: {
  field: EditableField;
  label: string;
  id: string;
}) {
  const [rejected, setRejected] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const value = String(field.getValue() ?? "");
  // Show canvas or undo edits, but never overwrite what the user is typing.
  useEffect(() => {
    if (input.current && document.activeElement !== input.current)
      input.current.value = value;
  }, [value]);
  if (field instanceof Blockly.FieldDropdown) {
    return (
      <label className="stacked">
        {label}
        <select
          id={id}
          value={value}
          onChange={(e) => field.setValue(e.target.value)}
        >
          {field.getOptions(false).map(([text, v]) => (
            <option key={String(v)} value={String(v)}>
              {typeof text === "string" ? text : String(v)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  const commit = (element: HTMLInputElement) => {
    const before = String(field.getValue());
    if (element.value === before) {
      setRejected(undefined);
      return;
    }
    field.setValue(element.value);
    const stored = String(field.getValue());
    const accepted = stored !== before || element.value.trim() === before;
    setRejected(
      accepted
        ? undefined
        : (rejectionReason(field) ?? "This value is not allowed here."),
    );
    if (accepted) element.value = stored;
  };
  return (
    <label className="stacked">
      {label}
      <input
        ref={input}
        id={id}
        aria-label={label}
        defaultValue={value}
        aria-invalid={rejected ? true : undefined}
        aria-describedby={rejected ? `${id}-rejected` : undefined}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget);
        }}
      />
      {rejected && (
        <span id={`${id}-rejected`} role="alert" className="status-error">
          Not accepted: {rejected} The previous value {value} is kept.
        </span>
      )}
    </label>
  );
}

function Item({
  block,
  selected,
  onSelect,
}: {
  block: Block;
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  const groups = children(block);
  return (
    <li>
      <button
        type="button"
        className="link"
        aria-current={selected === block.id || undefined}
        onClick={() => onSelect(block.id)}
      >
        {summary(block)}
      </button>
      {groups.map((group) => (
        <ul key={group.label} aria-label={group.label}>
          <li className="muted">
            {group.label}
            {group.blocks.length === 0 ? " (empty)" : ""}
          </li>
          {group.blocks.map((child) => (
            <Item
              key={child.id}
              block={child}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ))}
    </li>
  );
}

interface Props {
  readonly expanded?: boolean;
  readonly workspace: Blockly.WorkspaceSvg | undefined;
  /** The block to edit; set by the outline itself and by problem links. */
  readonly selected: string | undefined;
  readonly onSelect: (id: string) => void;
  /** Set (as a new object) by a problem link so the form takes keyboard focus, on the named field when it has one. */
  readonly focusRequest: { readonly field: string | undefined } | undefined;
}

export function Outline({
  expanded = false,
  workspace,
  selected,
  onSelect,
  focusRequest,
}: Props) {
  const [, setVersion] = useState(0);
  const form = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!workspace) return;
    const listener = (event: Blockly.Events.Abstract) => {
      if (!event.isUiEvent) setVersion((v) => v + 1);
    };
    workspace.addChangeListener(listener);
    return () => workspace.removeChangeListener(listener);
  }, [workspace]);
  useEffect(() => {
    if (!focusRequest || !form.current) return;
    const named =
      focusRequest.field && selected
        ? document.getElementById(`edit-${selected}-${focusRequest.field}`)
        : null;
    (
      named ?? form.current.querySelector<HTMLElement>("input, select")
    )?.focus();
  }, [focusRequest]); // only a new request moves focus; selection alone never does

  const root = workspace?.getBlocksByType(BLOCK.root, false)[0];
  const block = selected
    ? (workspace?.getBlockById(selected) ?? undefined)
    : undefined;
  const fields = block ? editableFields(block) : [];
  return (
    <section aria-labelledby="outline-heading">
      <h2 id="outline-heading">Rule inspector</h2>
      <p className="muted">
        Select a block on the canvas, or choose a rule below.
      </p>
      <div ref={form} role="group" aria-labelledby="outline-edit-heading">
        <h3 id="outline-edit-heading">
          {block ? `Edit: ${summary(block)}` : "Edit"}
        </h3>
        {!block ? (
          <p className="muted">
            Choose a block in the outline or a problem above.
          </p>
        ) : fields.length === 0 ? (
          <p className="muted">This block has no fields.</p>
        ) : (
          fields.map(({ field, label }) => (
            <FieldEditor
              key={`${block.id}-${field.name}`}
              field={field}
              label={label}
              id={`edit-${block.id}-${field.name}`}
            />
          ))
        )}
      </div>
      <details className="rule-browser" open={expanded || undefined}>
        <summary>Browse all rules</summary>{" "}
        {root ? (
          <ul className="outline">
            <Item block={root} selected={selected} onSelect={onSelect} />
          </ul>
        ) : (
          <p className="muted">No strategy block.</p>
        )}
      </details>
    </section>
  );
}
