import * as Blockly from "blockly/core";
export const theme = Blockly.Theme.defineTheme("studio", {
  name: "studio",
  base: Blockly.Themes.Classic,
  componentStyles: {
    workspaceBackgroundColour: "#171d20",
    toolboxBackgroundColour: "#1c2225",
    toolboxForegroundColour: "#c8d0d2",
    flyoutBackgroundColour: "#242d31",
    flyoutForegroundColour: "#f1f4ee",
    flyoutOpacity: 1,
    scrollbarColour: "#536063",
    scrollbarOpacity: 0.4,
    insertionMarkerColour: "#d3f36b",
    insertionMarkerOpacity: 0.4,
    cursorColour: "#d3f36b",
  },
  fontStyle: { family: "DM Sans", weight: "500", size: 12 },
  startHats: false,
});
