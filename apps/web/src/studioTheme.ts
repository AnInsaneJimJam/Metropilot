import * as Blockly from "blockly/core";

// Deep tinted fills with a brighter edge in the category hue: blocks stay distinct without shouting.
// Fill (primary), shadow/field (secondary) and edge (tertiary) per category.
const block = (fill: string, field: string, edge: string) => ({
  colourPrimary: fill,
  colourSecondary: field,
  colourTertiary: edge,
});
export const theme = Blockly.Theme.defineTheme("studio", {
  name: "studio",
  base: Blockly.Themes.Classic,
  blockStyles: {
    root_blocks: block("#151920", "#1c2028", "#343a44"),
    trigger_blocks: block("#3b2b12", "#4a3718", "#a4762c"),
    action_blocks: block("#16284d", "#1d3360", "#4573cc"),
    logic_blocks: block("#261f4d", "#30285e", "#6c58c4"),
    value_blocks: block("#103629", "#164433", "#2f8a68"),
    data_blocks: block("#3b1a30", "#4a223d", "#a14f7f"),
  },
  categoryStyles: {
    trigger_category: { colour: "#a4762c" },
    action_category: { colour: "#4573cc" },
    logic_category: { colour: "#6c58c4" },
    value_category: { colour: "#2f8a68" },
    data_category: { colour: "#a14f7f" },
  },
  componentStyles: {
    workspaceBackgroundColour: "#0d1014",
    toolboxBackgroundColour: "#0d1014",
    toolboxForegroundColour: "#a6a9b0",
    flyoutBackgroundColour: "#12151a",
    flyoutForegroundColour: "#e6e7ea",
    flyoutOpacity: 0.98,
    scrollbarColour: "#3a3c42",
    scrollbarOpacity: 0.6,
    insertionMarkerColour: "#c2a36c",
    insertionMarkerOpacity: 0.25,
    cursorColour: "#c2a36c",
  },
  fontStyle: { family: "Geist Variable, sans-serif", weight: "500", size: 12 },
  startHats: false,
});
